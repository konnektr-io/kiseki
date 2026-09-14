"""Photo batch ingest + placement (issue #190) — EXIF in, right day out.

Three pieces, in the order the human sees them:

1. **EXIF on ingest** — ``POST /api/files`` reports ``sha256`` + ``exif``
   (see ``app/exif.py``) next to the existing ``url``. Additive, no
   contract break.
2. **Propose** (``POST /photos/propose``) — read-only, writes NOTHING. Each
   photo's capture timestamp is converted to the TRIP's timezone (#42,
   never the viewer's clock): date → day; within the day the nearest block
   with a ``time`` wins when within ``PHOTO_BLOCK_WINDOW_MIN`` (±90 min
   — wide enough for a long lunch, narrow enough that breakfast never
   claims dinner); otherwise day-level. No EXIF, or a date outside the
   trip window, lands in the explicit ``undated`` bucket — never guessed.
   Screenshots and re-sent WhatsApp images (stripped metadata) are the
   normal undated case, not the exception.
3. **Confirm** (``POST /photos/confirm``) — the human-confirmed write.
   Block-targeted photos append to ``Block.images`` (decision A, #191);
   day-level photos append to (or create) a ``gallery`` block at the
   chronologically correct position (decision B). Ordering everywhere is by
   capture time (``taken_at``), never upload order; a missing ``taken_at``
   sorts last, stable by filename. Idempotent: a filename already present
   in the target day's images/gallery set is skipped (re-import = no-op),
   reported as ``skipped`` alongside ``written``.

Conventions inherited from the write path: bare filenames only (the
existing 422 http(s) gate applies here too; ``resolve_media_urls``
canonicalizes on read), ``order`` stays server-managed (clients never
send it), and backfill is the normal case — no live-window check anywhere.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field

from . import write as write_svc
from .exif import extract_exif
from .graph.convert import graph_to_trip
from .media import get_media_store, object_key_for
from .models import Block, Day, Trip
from .store import get_graph_client
from .write import BlockCreate, BlockFields, ContainerRef, WriteError

#: Block-match window, minutes either side of a block's ``time``. Stated in
#: code AND tests: a photo within ±90 min of a timed block belongs to it.
PHOTO_BLOCK_WINDOW_MIN = 90

_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})")
_EXTERNAL_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


# ---------------------------------------------------------------- payloads
class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProposePhoto(_Strict):
    """One photo to place: the stored bare filename + an optional override.

    ``taken_at`` lets the caller supply the capture time (the undated tray's
    human edit, or a client that already read EXIF); when absent the server
    reads the stored bytes' EXIF itself.
    """

    file_name: str = Field(min_length=1)
    taken_at: Optional[str] = Field(default=None, description="ISO-8601 capture time override")


class ProposeBody(_Strict):
    photos: list[ProposePhoto] = Field(default_factory=list)


class ConfirmPlacement(_Strict):
    """One human-confirmed placement (the proposal as confirmed/edited)."""

    file_name: str = Field(min_length=1)
    day_id: str = Field(min_length=1)
    block_id: Optional[str] = None


class ConfirmBody(_Strict):
    placements: list[ConfirmPlacement] = Field(default_factory=list)


# ---------------------------------------------------------------- time logic
def parse_taken_at(value: Any) -> Optional[_dt.datetime]:
    """ISO-8601 → datetime (aware or naive); None when unparseable."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = _dt.datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    return parsed


def exif_taken_at(raw: bytes) -> Optional[_dt.datetime]:
    """Capture time from image bytes (None when the file carries none)."""
    return parse_taken_at(extract_exif(raw).get("taken_at"))


def _trip_zone(timezone: Optional[str]) -> _dt.tzinfo:
    """The trip's IANA zone (#42); unknown/absent falls back to UTC."""
    if timezone:
        try:
            return ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return _dt.timezone.utc


def trip_local_datetime(taken: _dt.datetime, timezone: Optional[str]) -> _dt.datetime:
    """Capture time expressed in the trip's calendar.

    Aware timestamps convert into the trip zone; naive wall time (a camera
    set to local time, no offset recorded) is read as trip-local directly.
    """
    zone = _trip_zone(timezone)
    if taken.tzinfo is not None:
        return taken.astimezone(zone)
    return taken.replace(tzinfo=zone)


def _block_minutes(value: Any) -> Optional[int]:
    """Block ``time`` (``HH:MM``, ``H:MM`` + optional suffix) → minutes."""
    if not isinstance(value, str):
        return None
    m = _TIME_RE.match(value.strip())
    if not m:
        return None
    hh, mm = int(m.group(1)), int(m.group(2))
    if not 0 <= hh <= 23 or not 0 <= mm <= 59:
        return None
    return hh * 60 + mm


def match_block(blocks: list[Block], local: _dt.datetime) -> tuple[Optional[Block], Optional[int]]:
    """Nearest timed block to ``local`` within the window (else (None, None)).

    Returns (block, delta_minutes). Ties break to the first block in day
    order — deterministic, never a coin flip.
    """
    photo_min = local.hour * 60 + local.minute
    best: Optional[Block] = None
    best_delta: Optional[int] = None
    for b in blocks:
        mins = _block_minutes(b.time)
        if mins is None:
            continue
        delta = abs(mins - photo_min)
        if delta <= PHOTO_BLOCK_WINDOW_MIN and (
            best_delta is None or delta < best_delta
        ):
            best, best_delta = b, delta
    return best, best_delta


def sort_key(taken: Optional[_dt.datetime], timezone: Optional[str]) -> float:
    """Capture-time ordering: taken sorts by instant, missing sorts last."""
    if taken is None:
        return float("inf")
    return trip_local_datetime(taken, timezone).timestamp()


# ---------------------------------------------------------------- propose
def propose_placements(
    trip: Trip, photos: list[tuple[str, Optional[_dt.datetime]]]
) -> dict[str, Any]:
    """Pure placement: (file_name, taken_at) pairs → placements + undated.

    ``taken_at`` None, or a trip-local date matching no day, → ``undated``
    with an explicit reason. The trip window is the day list itself (works
    on finished trips — backfill is the normal case, #190.6).
    """
    by_date = {d.date: (i, d) for i, d in enumerate(trip.days)}
    placements: list[dict[str, Any]] = []
    undated: list[str] = []
    for file_name, taken in photos:
        if taken is None:
            placements.append({
                "file_name": file_name, "day_id": None, "day_index": None,
                "block_id": None, "taken_at": None,
                "reason": "no capture timestamp — undated tray",
            })
            undated.append(file_name)
            continue
        local = trip_local_datetime(taken, trip.timezone)
        hit = by_date.get(local.date().isoformat())
        if hit is None:
            placements.append({
                "file_name": file_name, "day_id": None, "day_index": None,
                "block_id": None, "taken_at": taken.isoformat(),
                "reason": f"capture date {local.date().isoformat()} is outside the trip window",
            })
            undated.append(file_name)
            continue
        day_index, day = hit
        block, delta = match_block(day.blocks, local)
        if block is not None:
            reason = f"within {delta} min of block time {block.time}"
        else:
            reason = (
                "no timed block within "
                f"±{PHOTO_BLOCK_WINDOW_MIN} min — day level"
            )
        placements.append({
            "file_name": file_name,
            "day_id": day.id,
            "day_index": day_index,
            "block_id": block.id if block is not None else None,
            "taken_at": taken.isoformat(),
            "reason": reason,
        })
    return {"placements": placements, "undated": undated}


def _stored_bytes(trip_dtid: str, file_name: str) -> bytes:
    """Raw bytes of a trip-namespaced upload (404 when unknown)."""
    if _EXTERNAL_URL_RE.match(file_name.strip()):
        raise WriteError(
            422,
            "file_name stores a bare media filename, not a URL "
            f"({file_name.strip()[:60]!r}) — upload the file first "
            "(POST /api/files with tripId)",
        )
    store = get_media_store()
    if store is None:
        raise WriteError(503, "Media storage is not configured")
    chunks = store.get(object_key_for(trip_dtid, file_name))
    if chunks is None:
        raise WriteError(404, f"Photo not found on this trip: {file_name!r}")
    return b"".join(chunks)


def propose_photos(trip_dtid: str, body: ProposeBody) -> dict[str, Any]:
    """Read-only placement proposal (the route already gated editor+)."""
    client = get_graph_client()
    if client is None:
        raise WriteError(503, "Graph not configured")
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        raise WriteError(404, "Trip not found")
    trip = graph_to_trip(graph)
    resolved: list[tuple[str, Optional[_dt.datetime]]] = []
    for photo in body.photos:
        taken = parse_taken_at(photo.taken_at)
        if taken is None and photo.taken_at is None:
            # No override — read the stored bytes' EXIF (missing file 404s,
            # corrupt bytes read as undated, never a guess).
            taken = exif_taken_at(_stored_bytes(trip_dtid, photo.file_name))
        resolved.append((photo.file_name, taken))
    return propose_placements(trip, resolved)


# ---------------------------------------------------------------- confirm
def _day_of(trip: Trip, day_id: str) -> Day:
    for d in trip.days:
        if d.id == day_id:
            return d
    raise WriteError(404, f"Day not found on this trip: {day_id!r}")


def _day_image_set(day: Day) -> set[str]:
    """Every bare filename already filed on this day (strips + galleries)."""
    present: set[str] = set()
    for b in day.blocks:
        for img in b.images or []:
            if isinstance(img, str):
                present.add(img)
        if b.kind == "gallery":
            for item in b.items or []:
                if isinstance(item, str):
                    present.add(item)
                elif isinstance(item, dict) and isinstance(item.get("url"), str):
                    present.add(item["url"])
    return present


def _gallery_insert_index(day: Day, earliest: Optional[_dt.datetime], timezone: Optional[str]) -> int:
    """Chronological position for a new gallery block among the day's blocks.

    After the last block whose ``time`` is at/before the earliest photo
    (timeless blocks keep their relative spot — the insert walks past only
    timed blocks at-or-before the photo); photos without a capture time
    append at the end.
    """
    if earliest is None:
        return len(day.blocks)
    ordered = sorted(day.blocks, key=lambda b: b.order or 0)
    photo_min = (
        trip_local_datetime(earliest, timezone).hour * 60
        + trip_local_datetime(earliest, timezone).minute
    )
    index = 0
    for b in ordered:
        mins = _block_minutes(b.time)
        if mins is not None and mins <= photo_min:
            index += 1
        elif mins is None:
            index += 1
        else:
            break
    return min(index, len(day.blocks))


def confirm_placements(
    trip_dtid: str, actor: dict, body: ConfirmBody
) -> tuple[Trip, list[str], list[str]]:
    """Apply human-confirmed placements; returns (trip, written, skipped)."""
    written: list[str] = []
    skipped: list[str] = []
    if not body.placements:
        client = get_graph_client()
        if client is None:
            raise WriteError(503, "Graph not configured")
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            raise WriteError(404, "Trip not found")
        return graph_to_trip(graph), written, skipped

    # Validate everything against the CURRENT document before writing: day
    # membership, block-on-day membership, stored bytes presence (404s here,
    # so a half-applied batch can never happen).
    client = get_graph_client()
    if client is None:
        raise WriteError(503, "Graph not configured")
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        raise WriteError(404, "Trip not found")
    trip = graph_to_trip(graph)
    day_ids = {d.id for d in trip.days}
    block_day: dict[str, str] = {}
    for d in trip.days:
        for b in d.blocks:
            block_day[b.id] = d.id
    taken_of: dict[str, Optional[_dt.datetime]] = {}
    for p in body.placements:
        if p.day_id not in day_ids:
            raise WriteError(404, f"Day not found on this trip: {p.day_id!r}")
        if p.block_id is not None and block_day.get(p.block_id) != p.day_id:
            raise WriteError(404, f"Block not found on day {p.day_id!r}: {p.block_id!r}")
        taken_of[p.file_name] = exif_taken_at(_stored_bytes(trip_dtid, p.file_name))

    # Group by target: (day_id, block_id|None) → filenames, capture-ordered.
    strip_targets: dict[tuple[str, str], list[str]] = {}
    day_targets: dict[str, list[str]] = {}
    for p in body.placements:
        if p.block_id is not None:
            strip_targets.setdefault((p.day_id, p.block_id), []).append(p.file_name)
        else:
            day_targets.setdefault(p.day_id, []).append(p.file_name)

    result = trip
    for (day_id, block_id), names in strip_targets.items():
        day = _day_of(result, day_id)
        present = _day_image_set(day)
        fresh = [n for n in names if n not in present]
        skipped.extend(n for n in names if n in present)
        if not fresh:
            continue
        twin = next(b for b in day.blocks if b.id == block_id)
        merged = sorted(
            list(twin.images or []) + fresh,
            key=lambda n: (sort_key(taken_of.get(n), result.timezone), n),
        )
        result = write_svc.update_block(
            trip_dtid, actor, block_id, BlockFields(images=merged)
        )
        written.extend(fresh)

    for day_id, names in day_targets.items():
        day = _day_of(result, day_id)
        present = _day_image_set(day)
        fresh = [n for n in names if n not in present]
        skipped.extend(n for n in names if n in present)
        if not fresh:
            continue
        fresh_sorted = sorted(
            fresh, key=lambda n: (sort_key(taken_of.get(n), result.timezone), n)
        )
        existing = next((b for b in day.blocks if b.kind == "gallery"), None)
        if existing is not None:
            items = list(existing.items or [])
            if not all(isinstance(x, (str, dict)) for x in items):
                raise WriteError(422, "gallery items must be media filenames/URLs")
            # normalize to the stored object shape ({"url": name}) — same
            # rule _validate_items enforces on the generic block write path
            norm = [it if isinstance(it, dict) else {"url": it} for it in items]
            fresh_names = [n for n in fresh_sorted]
            merged_names = [it.get("url", "") for it in norm]
            merged = sorted(
                norm + [{"url": n} for n in fresh_names if n not in merged_names],
                key=lambda it: (
                    (
                        sort_key(taken_of.get(it["url"]), result.timezone)
                        if it.get("url") in taken_of
                        else float("inf")
                    ),
                    str(it.get("url", "")),
                ),
            )
            result = write_svc.update_block(
                trip_dtid, actor, existing.id, BlockFields(items=merged)
            )
        else:
            earliest = next(
                (taken_of[n] for n in fresh_sorted if taken_of.get(n) is not None),
                None,
            )
            index = _gallery_insert_index(day, earliest, result.timezone)
            result = write_svc.create_block(
                trip_dtid,
                actor,
                BlockCreate(
                    kind="gallery",
                    container=ContainerRef(type="day", id=day_id),
                    index=index,
                    title="Photos",
                    # BlockCreate/_validate_items normalizes to {"url": n}
                    items=fresh_sorted,
                ),
            )
        written.extend(fresh_sorted)

    # De-duplicate written while keeping capture order (the same file placed
    # twice in one batch writes once).
    seen: set[str] = set()
    ordered_written = [n for n in written if not (n in seen or seen.add(n))]
    return result, ordered_written, skipped
