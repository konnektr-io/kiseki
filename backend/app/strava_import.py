"""Strava → a trip day (#449): which day, which block, the write.

Split from :mod:`app.strava` on purpose — that module is transport (OAuth,
cookies, HTTP, GPX bytes), this one is trip-shaped and has no idea what an
HTTP response looks like. Everything here is either a pure function over a
``Trip`` (so it is unit-testable without a graph or a network) or the one
import that reads a trip, stores the file and writes the block.

The rules, all of them decided in #449:

* **Date is the hard filter.** An activity's ``start_date_local`` is already
  the athlete's local date (Strava's quirk: local time with a ``Z`` suffix), so
  its date part is compared to ``Day.date`` verbatim. No timezone arithmetic —
  converting it through the trip's zone would *shift* a date that is already
  right.
* **Geo proximity picks the block**, not the clock: haversine from the
  activity's start/end to the day's block locations (resolved through the
  trip's ``locations`` registry, which is where coordinates live). ``time`` is
  only a tiebreaker. No geo evidence → day-level suggestion, and the human
  picks.
* **Nothing is written until the human imports.** The list route is read-only.
* **Idempotent without a schema change**: the block's "View on Strava" link
  carries the activity id, so a re-import finds its own previous work and
  returns ``written: false`` instead of a duplicate block.
* **First import wins** on a block that already has a track (two crew members
  recording the same ride): the response names the conflict instead of
  silently replacing someone else's recording.
"""

from __future__ import annotations

import math
import threading
import time
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from . import strava
from . import write as write_svc
from .graph.convert import graph_to_trip
from .media import content_addressed_key, get_media_store, object_key_for
from .models import Block, Day, Link, Trip
from .store import get_graph_client
from .write import BlockCreate, BlockFields, ContainerRef, WriteError

#: How far an activity's start (or end) may sit from a block's place and still
#: be "that block". Wide enough for a trailhead outside town, narrow enough that
#: two places on the same day never claim each other's ride.
GEO_MATCH_M = 25_000.0

#: The list is cached per (athlete, trip) so opening the menu twice costs one
#: Strava call. Suggestions and import state are recomputed every request —
#: they are pure and cheap, and a stale "imported" badge would be a lie.
LIST_TTL_S = 900

ACTIVITY_URL = "https://www.strava.com/activities/{id}"
LINK_LABEL = "View on Strava"


class ImportBody(BaseModel):
    """``POST /api/integrations/strava/trips/{trip_id}/import`` body."""

    model_config = ConfigDict(extra="forbid")

    activity_id: int
    day_id: str
    block_id: Optional[str] = None
    include_photos: bool = True
    consent: bool = True


# ------------------------------------------------------------------ pure helpers


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def local_date(activity: dict[str, Any]) -> Optional[str]:
    """The activity's own calendar date (``start_date_local`` is already local)."""
    for key in ("start_date_local", "start_date"):
        raw = activity.get(key)
        if isinstance(raw, str) and len(raw) >= 10:
            return raw[:10]
    return None


def local_time(activity: dict[str, Any]) -> Optional[str]:
    """``HH:MM`` of ``start_date_local`` — the block's time label on import."""
    raw = activity.get("start_date_local")
    if isinstance(raw, str) and len(raw) >= 16 and raw[11] == ":":
        return raw[11:16]
    return None


def is_importable(activity: dict[str, Any]) -> bool:
    """A recorded, GPS-bearing activity — not a trainer/virtual session.

    An indoor ride has no ``latlng`` stream, so it would import as an empty
    track; the list leaves it out rather than offering a promise it cannot keep.
    """
    start = activity.get("start_latlng")
    if not isinstance(start, (list, tuple)) or len(start) < 2:
        return False
    if activity.get("trainer") is True:
        return False
    sport = str(activity.get("sport_type") or activity.get("type") or "")
    return not sport.lower().startswith("virtual")


def _place_index(trip: Trip) -> dict[str, tuple[float, float]]:
    """Lower-cased name/alias → coordinates, from the trip's locations registry."""
    index: dict[str, tuple[float, float]] = {}
    for location in trip.locations:
        if location.lat is None or location.lng is None:
            continue
        for name in [location.name, *(location.alias or [])]:
            if name:
                index[name.strip().lower()] = (float(location.lat), float(location.lng))
    return index


def _block_point(block: Block, places: dict[str, tuple[float, float]]) -> Optional[tuple[float, float]]:
    if not block.location:
        return None
    return places.get(str(block.location).strip().lower())


def _activity_points(activity: dict[str, Any]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for key in ("start_latlng", "end_latlng"):
        pair = activity.get(key)
        if isinstance(pair, (list, tuple)) and len(pair) >= 2:
            try:
                out.append((float(pair[0]), float(pair[1])))
            except (TypeError, ValueError):
                continue
    return out


def _minutes(value: Optional[str]) -> Optional[int]:
    if not value or ":" not in value:
        return None
    head, _, tail = value.partition(":")
    try:
        return int(head) * 60 + int(tail[:2])
    except ValueError:
        return None


def suggest(trip: Trip, activity: dict[str, Any]) -> Optional[dict[str, Any]]:
    """``{"day_id", "block_id"?}`` for an activity, or ``None`` when no day matches.

    Date first (hard), then geo, then the clock. A day with exactly one
    track-less activity block is suggested even without geo evidence: that is
    the ordinary case (a planned "Ride Niseko" block with no coordinates) and
    asking would be friction for an obvious answer.
    """
    date = local_date(activity)
    if not date:
        return None
    day = next((d for d in trip.days if d.date == date), None)
    if day is None:
        return None

    places = _place_index(trip)
    points = _activity_points(activity)
    activity_minutes = _minutes(local_time(activity))

    candidates = [
        block
        for block in day.blocks
        if block.kind == "activity" and not block.track
    ]
    if not candidates:
        return {"day_id": day.id}

    scored: list[tuple[tuple[int, float, int], Block]] = []
    for block in candidates:
        point = _block_point(block, places)
        distance = min(
            (
                haversine_m(point[0], point[1], lat, lng)
                for lat, lng in points
            ),
            default=math.inf,
        ) if point and points else math.inf
        geo = distance <= GEO_MATCH_M
        block_minutes = _minutes(block.time)
        time_delta = (
            abs(block_minutes - activity_minutes)
            if block_minutes is not None and activity_minutes is not None
            else 10_000
        )
        # (geo first, then nearest, then closest in time)
        scored.append(((0 if geo else 1, distance if geo else math.inf, time_delta), block))

    scored.sort(key=lambda item: item[0])
    best_key, best = scored[0]
    if best_key[0] == 0:
        return {"day_id": day.id, "block_id": best.id}
    if len(candidates) == 1:
        return {"day_id": day.id, "block_id": candidates[0].id}
    return {"day_id": day.id}


def resolve_target(trip: Trip, day: Day, activity: dict[str, Any]) -> Optional[Block]:
    """The block this activity belongs on — INCLUDING one that already has a track.

    :func:`suggest` deliberately offers only track-less blocks (a UI must not
    point the human at a finished recording). The import needs the wider
    answer: when the day's activity blocks all carry a track, the single one is
    still the answer — and it becomes a ``track_exists`` conflict rather than a
    second block for the same ride.
    """
    blocks = [block for block in day.blocks if block.kind == "activity"]
    untracked = [block for block in blocks if not block.track]
    if untracked:
        suggestion = suggest(trip, activity)
        if suggestion and suggestion.get("day_id") == day.id and suggestion.get("block_id"):
            return next((b for b in untracked if b.id == suggestion["block_id"]), None)
        return None
    if len(blocks) == 1:
        return blocks[0]
    return None


def find_imported_block(trip: Trip, activity_id: int) -> Optional[tuple[str, Block]]:
    """``(day_id, block)`` whose "View on Strava" link names this activity."""
    url = ACTIVITY_URL.format(id=int(activity_id))
    for day in trip.days:
        for block in day.blocks:
            for link in block.links:
                if link.url.rstrip("/") == url:
                    return day.id, block
    return None


def is_garmin(activity: dict[str, Any]) -> bool:
    """Whether the recording came from a Garmin device (API Policy §4.4)."""
    device = str(activity.get("device_name") or "").lower()
    external = str(activity.get("external_id") or "").lower()
    return "garmin" in device or external.startswith("garmin")


# ------------------------------------------------------------------- the list


_CACHE: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
_CACHE_LOCK = threading.Lock()


def _cache_get(key: tuple[str, str]) -> Optional[list[dict[str, Any]]]:
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if not entry or entry[0] < time.time():
            return None
        return entry[1]


def _cache_put(key: tuple[str, str], activities: list[dict[str, Any]]) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = (time.time() + LIST_TTL_S, activities)


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def trip_window(trip: Trip) -> tuple[Optional[int], Optional[int]]:
    """Epoch window for ``/athlete/activities``: trip start −1d → end +2d.

    The margins exist because ``start_date_local`` can sit either side of the
    UTC date the epoch bounds are computed from; the date filter afterwards is
    what decides, this is only wide enough not to lose a day.
    """
    import datetime as _dt

    dates = sorted(d for d in (trip.startDate, trip.endDate) if d)
    if not dates:
        dates = sorted(day.date for day in trip.days if day.date)
    if not dates:
        return None, None

    def _epoch(date: str, delta_days: int) -> Optional[int]:
        try:
            base = _dt.datetime.fromisoformat(date[:10]).replace(tzinfo=_dt.timezone.utc)
        except ValueError:
            return None
        return int((base + _dt.timedelta(days=delta_days)).timestamp())

    after = _epoch(dates[0], -1)
    before = _epoch(dates[-1], 2)
    return after, before


def list_for_trip(
    trip: Trip, session: dict[str, Any], *, athlete_id: Any = None
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The trip's candidate activities, each with its suggestion."""
    key = (str(athlete_id or session.get("a") or ""), trip.id)
    cached = _cache_get(key)
    if cached is None:
        after, before = trip_window(trip)
        session, raw = strava.activities(session, after=after, before=before)
        cached = [a for a in raw if isinstance(a, dict)]
        _cache_put(key, cached)

    day_dates = {day.date for day in trip.days if day.date}
    items: list[dict[str, Any]] = []
    for activity in cached:
        if not is_importable(activity):
            continue
        date = local_date(activity)
        if date not in day_dates:
            continue
        imported = find_imported_block(trip, int(activity.get("id") or 0))
        photos_block = imported[1] if imported else None
        items.append(
            {
                "id": activity.get("id"),
                "name": activity.get("name"),
                "sport_type": activity.get("sport_type") or activity.get("type"),
                "local_date": date,
                "distance_m": activity.get("distance"),
                "moving_time_s": activity.get("moving_time"),
                "elapsed_time_s": activity.get("elapsed_time"),
                "elevation_gain_m": activity.get("total_elevation_gain"),
                "start_latlng": activity.get("start_latlng"),
                "photo_count": activity.get("total_photo_count")
                or (activity.get("photos") or {}).get("count")
                or 0,
                "suggested": suggest(trip, activity),
                "imported": (
                    {
                        "day_id": imported[0],
                        "block_id": imported[1].id,
                        "has_photos": bool(photos_block.images) if photos_block else False,
                    }
                    if imported
                    else None
                ),
            }
        )
    items.sort(key=lambda item: (str(item["local_date"]), str(item.get("id"))))
    return session, {"activities": items, "scopes": session.get("s") or ""}


# ------------------------------------------------------------------- the import


def _day_of(trip: Trip, day_id: str):
    day = next((d for d in trip.days if d.id == day_id), None)
    if day is None:
        raise WriteError(404, f"Day not found on this trip: {day_id!r}")
    return day


def _photo_bytes(
    session: dict[str, Any], activity_id: int
) -> tuple[dict[str, Any], list[tuple[bytes, str]], int, int]:
    """Download every photo; failures are reported, never fatal (#449)."""
    session, listed = strava.photos(session, activity_id)
    raw: list[tuple[bytes, str]] = []
    failures = 0
    for photo in listed:
        urls = photo.get("urls") if isinstance(photo, dict) else None
        url = None
        if isinstance(urls, dict):
            for size in ("2048", "600", "100"):
                if urls.get(size):
                    url = urls[size]
                    break
        if not url:
            failures += 1
            continue
        try:
            raw.append(strava.download_photo(str(url)))
        except strava.StravaError:
            failures += 1
    return session, raw, failures, len(listed)


def import_activity(
    trip_dtid: str,
    actor: dict[str, Any],
    body: ImportBody,
    session: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Put one activity's GPX (+ photos) onto a day. Returns ``(session, result)``.

    Order matters: the track file is stored BEFORE the block is written, because
    the write path validates that the named ``.gpx`` exists and parses.
    """
    if not body.consent:
        raise WriteError(
            422,
            "Import needs the consent tick — the track and photos become part of "
            "the trip (visible to the crew, and in the booklet).",
        )
    client = get_graph_client()
    if client is None:
        raise WriteError(503, "Graph not configured")
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        raise WriteError(404, "Trip not found")
    trip = graph_to_trip(graph)

    # Idempotency before anything is fetched from Strava: the link URL carries
    # the activity id, so a re-import is a no-op that names its own block.
    already = find_imported_block(trip, body.activity_id)
    if already is not None:
        day_id, block = already
        return session, {
            "written": False,
            "conflict": "already_imported",
            "day_id": day_id,
            "block_id": block.id,
            "track": block.track,
            "photos": {"written": 0, "failed": 0, "total": 0},
            "consent": body.consent,
            "trip": trip,
        }

    day = _day_of(trip, body.day_id)

    session, detail = strava.activity_detail(session, body.activity_id)
    if not isinstance(detail, dict):
        raise strava.StravaError(502, "Strava returned an unexpected activity")

    # Target block: explicit → suggestion → a new activity block on the day.
    target: Optional[Block] = None
    suggestion = suggest(trip, detail)
    if body.block_id:
        target = next((b for b in day.blocks if b.id == body.block_id), None)
        if target is None:
            raise WriteError(404, f"Block not found on day {body.day_id!r}: {body.block_id!r}")
        if target.kind != "activity":
            raise WriteError(422, "A track can only be attached to an 'activity' block")
    else:
        target = resolve_target(trip, day, detail)

    if target is not None and target.track:
        return session, {
            "written": False,
            "conflict": "track_exists",
            "day_id": day.id,
            "block_id": target.id,
            "track": target.track,
            "photos": {"written": 0, "failed": 0, "total": 0},
            "consent": body.consent,
            "trip": trip,
        }

    store = get_media_store()
    if store is None:
        raise WriteError(503, "Media store not configured")

    session, points = strava.stream_points_for(session, detail)
    raw_gpx = strava.build_gpx(points, name=str(detail.get("name") or "Strava activity"))
    track_name = content_addressed_key(raw_gpx, ".gpx")
    store.put(object_key_for(trip_dtid, track_name), raw_gpx, "application/gpx+xml")

    # Photos are opt-in by the same dialog tick; a failure per photo never
    # blocks the track (the block is still worth having without them).
    photo_report = {"written": 0, "failed": 0, "total": 0}
    image_names: list[str] = []
    if body.include_photos:
        try:
            session, blob_pairs, failed, total = _photo_bytes(session, body.activity_id)
        except strava.StravaError:
            blob_pairs, failed, total = [], 0, 0
        for raw, ext in blob_pairs:
            name = content_addressed_key(raw, ext)
            store.put(
                object_key_for(trip_dtid, name),
                raw,
                "image/png" if ext == ".png" else "image/jpeg",
            )
            image_names.append(name)
        photo_report = {"written": len(image_names), "failed": failed, "total": total}

    links = [Link(label=LINK_LABEL, url=ACTIVITY_URL.format(id=int(body.activity_id)))]
    if is_garmin(detail):
        # Strava's API Policy §4.4: Garmin-sourced data carries Garmin
        # attribution. The block has no free-text credit field and the track
        # itself must stay indistinguishable, so attribution rides as a link.
        links.append(Link(label="Garmin", url="https://www.garmin.com"))
    existing_links = [link for link in target.links] if target else []
    if not any(link.url == links[0].url for link in existing_links):
        links = existing_links + links

    if target is None:
        trip = write_svc.create_block(
            trip_dtid,
            actor,
            BlockCreate(
                kind="activity",
                container=ContainerRef(type="day", id=day.id),
                title=str(detail.get("name") or "Activity"),
                time=local_time(detail),
                status="done",
                track=track_name,
                images=image_names,
                links=links,
            ),
        )
        day_id, block_id = day.id, _newest_block_id(trip, day.id)
    else:
        trip = write_svc.update_block(
            trip_dtid,
            actor,
            target.id,
            BlockFields(track=track_name, images=image_names, links=links),
        )
        day_id, block_id = day.id, target.id

    return session, {
        "written": True,
        "conflict": None,
        "day_id": day_id,
        "block_id": block_id,
        "track": track_name,
        "photos": photo_report,
        "consent": body.consent,
        "activity": {
            "id": body.activity_id,
            "name": detail.get("name"),
            "sport_type": detail.get("sport_type") or detail.get("type"),
            "garmin": is_garmin(detail),
        },
        "trip": trip,
    }


def _newest_block_id(trip: Trip, day_id: str) -> Optional[str]:
    """The block ``create_block`` just appended (it returns the whole trip)."""
    day = next((d for d in trip.days if d.id == day_id), None)
    if day is None or not day.blocks:
        return None
    block = max(day.blocks, key=lambda b: b.order if b.order is not None else -1)
    return block.id
