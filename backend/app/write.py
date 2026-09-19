"""Write-path service (issue #46) — role-gated content writes to the graph.

Every public function here:

- requires a graph (``store.get_graph_client()`` -> None = 503),
- receives the caller's ``actor = {"sub": …, "role": …}`` (resolved by the
  ACL dependency in ``app/acl.py``) and forwards ``sub`` as ``x-user-id`` on
  every graph op so the graph stamps ``$lastUpdatedBy`` (chart x-user-id, #3),
- validates against the CURRENT trip document (fetched fresh after cache
  invalidation), mutates through the thin ``GraphWriteClient`` ops (JSON Patch
  per field — never whole-twin replace — so concurrent edits to different
  fields/items of the same twin cannot clobber each other),
- stamps ``trip.updated`` with today's date,
- returns the REBUILT :class:`app.models.Trip` so routes can serialize the
  canonical document in one round trip.

Content writes go to the graph ONLY — there is no file store, no PVC, no
reseed. ``claimToken`` is never accepted by any payload model here (the secret
is not trip content), and ``$metadata``/``$dtId`` are never writable.

Ordering convention (matching the read path): a block's position inside its
container (Day or TripSection) is its ``order`` property — the frontend and
booklet sort by it. ``hasBlock`` edges carry no index. This module maintains
``order`` exclusively; clients never set it (``order`` in a payload is a 422).
"""

from __future__ import annotations

import datetime as _dt
import re
import secrets
import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .graph.client import TRIP_MODEL, GraphWriteError, _invalidate_graph_cache
from .graph.convert import GraphNotFound, crew_edge_name, graph_to_trip
from .fit import FitError, parse_fit
from .gpx import GpxError, parse_gpx
from .media import get_media_store, is_valid_media_name, object_key_for
from .sanitize import sanitize_custom_html
from .models import (
    BlockKind,
    BlockStatus,
    Contact,
    FeatureCard,
    Link,
    Practical,
    PracticalBlock,
    Role,
    Stage,
    Stat,
    Theme,
    TodoItem,
    Trip,
    Visibility,
)
from .store import get_graph_client
from . import tricount as tricount_svc

# DTMI of the interfaces this service creates/patches (client.py exports the
# trip/user/person ones; the rest are needed verbatim here).
BLOCK_MODEL = "dtmi:kiseki:travel:Block;1"
DAY_MODEL = "dtmi:kiseki:travel:Day;1"
FEATURE_MODEL = "dtmi:kiseki:travel:Feature;1"
LOCATION_MODEL = "dtmi:kiseki:travel:Location;1"
PERSON_MODEL = "dtmi:kiseki:travel:Person;1"
SECTION_MODEL = "dtmi:kiseki:travel:TripSection;1"

_STAGE_ORDER = ["idea", "options", "shortlist", "planned", "booked", "live", "archive"]
_STAGE_IDX = {s: i for i, s in enumerate(_STAGE_ORDER)}

# Transport-only fields (drive/flight cards). Rejected on any other kind.
_TRANSPORT_FIELDS = {"distance", "duration", "route", "via", "from", "to", "mode"}

_EDITOR_ROLE = {"editor", "owner"}


class WriteError(Exception):
    """Expected write failure; carries the HTTP status (mirrors ClaimError)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ---------------------------------------------------------------- payloads
class _Strict(BaseModel):
    """Write payloads are explicit: unknown fields are a 422, not silence."""

    model_config = ConfigDict(extra="forbid")


class ContainerRef(_Strict):
    type: Literal["day", "section"]
    id: str


class TripPatch(_Strict):
    """Trip-level scalar edits (editor+; visibility enforced owner-only by the
    route). Every field optional — provided fields are patched, the rest keep
    their current value. ``claimToken`` deliberately has no field here."""

    title: Optional[str] = None
    subtitle: Optional[str] = None
    summary: Optional[str] = None
    stage: Optional[Stage] = None
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    timezone: Optional[str] = None
    theme: Optional[Theme] = None
    cover: Optional[str] = None
    coverCredit: Optional[str] = None
    map: Optional[str] = None
    visibility: Optional[Visibility] = None
    discoverable: Optional[bool] = None
    # Cover-strip lines + the "at a glance" row (issue #178) — plain scalar
    # list props on the Trip twin, patched like any other scalar. A present
    # ``null`` (or ``[]``) clears; an absent field is left untouched.
    coverStats: Optional[list[str]] = None
    stats: Optional[list[Stat]] = None


class PracticalPut(_Strict):
    """Whole-object replace of the trip's practical value object.

    ``tricount`` is owner-only and structurally unwritable through this
    payload (ignored + rejected like ``claimToken``) — use the dedicated
    connect/disconnect endpoints (#111), which fetch and validate the
    registry before writing anything."""

    todos: list[TodoItem] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)
    notes: Optional[str] = None
    blocks: list[PracticalBlock] = Field(default_factory=list)
    contacts: list[Contact] = Field(default_factory=list)


class TodoToggle(_Strict):
    done: bool


class TricountConnect(_Strict):
    """Owner-only payload for POST /practical/tricount/connect (#111).

    Accepts the full sharing URL (tricount.com/tXXXX) or the bare key —
    the crew's actual workflow is pasting the link they have."""

    registryKey: str

    def normalized_key(self) -> str:
        """URL → bare key, nothing else.

        A bare Tricount key ALWAYS starts with 't' (the ``/t`` path in
        tricount.com/tXXXX) — there is no URL-slug prefix to strip, and a
        length heuristic cannot tell them apart. Anything that still
        contains a '/' is treated as a URL (last segment); anything else is
        taken verbatim and validated against bunq before it is stored."""
        key = self.registryKey.strip()
        if "/" in key:
            key = key.rstrip("/").rsplit("/", 1)[-1]
        return key


def connect_and_validate(practical_dict: dict, registry_key: str) -> dict:
    """Pure helper: practical dict with the (already-validated) tricount key
    merged in. The snapshot validation happens in the service before this is
    reached; kept separate so write tests exercise the merge without network."""
    practical = dict(practical_dict or {})
    practical["tricount"] = {"registryKey": registry_key.strip()}
    return practical


class TodoAdd(_Strict):
    label: str
    done: bool = False
    when: Optional[str] = None
    links: list[Link] = Field(default_factory=list)


class PracticalBlockAdd(_Strict):
    """POST /api/trips/{id}/practical/blocks body (#273).

    ``index`` is the insert position in the block list (default: append). List
    position IS the render order (#254), so inserting is how a heading lands
    where the roadbook puts it — there is deliberately no `order` to send, and
    no whole-section body to rebuild.
    """

    title: str
    body: str
    index: Optional[int] = None


class PracticalBlockPatch(_Strict):
    """PUT /api/trips/{id}/practical/blocks/{index} body (#273).

    Patch semantics, like day/section blocks: only the fields sent are written,
    so editing a body cannot silently drop a title. At least one field is
    required — an empty body is a 422, never a no-op write.
    """

    title: Optional[str] = None
    body: Optional[str] = None


class BlockFields(_Strict):
    """Editable block fields shared across kinds (id/kind/order excluded)."""

    title: Optional[str] = None
    time: Optional[str] = None
    description: Optional[str] = None
    links: Optional[list[Link]] = None
    cost: Optional[float] = None
    currency: Optional[str] = None
    status: Optional[BlockStatus] = None
    bookingCode: Optional[str] = None
    items: Optional[list[Any]] = None
    html: Optional[str] = None
    distance: Optional[str] = None
    duration: Optional[str] = None
    route: Optional[str] = None
    via: Optional[str] = None
    from_: Optional[str] = Field(default=None, alias="from")
    to: Optional[str] = None
    mode: Optional[str] = None
    location: Optional[str] = None
    placeId: Optional[str] = None
    images: Optional[list[str]] = None
    track: Optional[str] = None


class BlockCreate(BlockFields):
    kind: BlockKind
    container: ContainerRef
    index: Optional[int] = Field(
        default=None, ge=0, description="Insert position within the container; default = append."
    )


class BlockMove(_Strict):
    container: ContainerRef
    index: Optional[int] = Field(default=None, ge=0)


class BlockOrder(_Strict):
    block_ids: list[str]


class DayPatch(_Strict):
    title: Optional[str] = None
    notes: Optional[str] = None
    map: Optional[str] = None
    meta: Optional[list[dict[str, str]]] = None
    # date is calendar truth — not editable through the write API (see plan §10)
    date: Optional[str] = None


class DayCreate(_Strict):
    """POST /days body: insert a new day at ``index`` (the 0-based position
    the new day takes; omit/None = append after the last day). ``date`` is
    calendar truth for the new day — explicit ISO date, or a neighbor-based
    default (previous day + 1, first day − 1 when prepending, trip startDate /
    today on an empty trip). ``title`` defaults to untitled ("")."""

    index: Optional[int] = Field(default=None, ge=0)
    date: Optional[str] = None
    title: Optional[str] = None


class SectionPatch(_Strict):
    title: Optional[str] = None
    locationRefs: Optional[list[str]] = None
    # days is the section's inclusive [first, last] 0-based day range (issue
    # #89). The write service rewires the section's hasDay edges + twin
    # ``days`` property to match; ranges must stay in trip bounds and must not
    # overlap another section (a day renders under exactly one section).
    days: Optional[list[int]] = None


class SectionCreate(_Strict):
    """POST /sections body (issue #89): a brand-new chapter over trip days.

    ``days`` optional — omit for a pure ideation section (unscheduled blocks
    can join later via POST /blocks with a section container).
    """

    title: str = Field(min_length=1)
    days: Optional[list[int]] = None
    locationRefs: Optional[list[str]] = None


class CrewPatch(_Strict):
    role: Optional[Role] = None
    note: Optional[str] = None
    contact: Optional[str] = None


class CrewAdd(_Strict):
    """POST /crew body — three ways to add a crew member.

    Default: an unclaimed placeholder Person (they claim later via the invite,
    #6) — it grants nobody access until then.

    With ``sub``: an account that already exists on Kiseki (#198 follow-up) —
    the crew entry attaches to that account's ``User`` twin directly, so they
    are crew the moment it lands (read access immediately, no invite link, no
    claim step). Owner-only, and only for an account the caller follows.
    ``name`` is still the trip-relative label; ``contact`` is refused (it
    belongs to their own profile, not to this trip).

    With ``personId`` (#322): an UNCLAIMED placeholder that is already crew on
    another trip the caller owns — the same human, one identity, so their
    invite lands them on every linked trip at once. Owner-only, explicit and
    id-based (never name-matched); ``contact`` is refused for the same reason
    as ``sub``, only here the shared thing is the placeholder twin itself.
    ``name`` is this trip's own label for them, as always.
    """

    name: str = Field(min_length=1)
    role: Role = "viewer"
    note: Optional[str] = None
    contact: Optional[str] = None
    sub: Optional[str] = None
    personId: Optional[str] = None


class LocationWrite(_Strict):
    """One registry entry for PUT /locations (full-array replace, diff-by-name).

    Explicit-clear contract: only fields PRESENT in the payload are written.
    A present ``null`` (or ``[]`` for a list field) clears that field on the
    twin; an absent field leaves the stored value alone. ``marker: null``
    clears to the positional default (marker is optional, never rejected).
    """

    id: Optional[str] = None
    name: str = Field(min_length=1)
    marker: Optional[int] = None
    alias: Optional[list[str]] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    placeId: Optional[str] = None
    address: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    openingHours: Optional[list[str]] = None
    types: Optional[list[str]] = None
    wheelchairAccessible: Optional[bool] = None
    rating: Optional[float] = None
    summary: Optional[str] = None
    photo: Optional[str] = None
    photoCredit: Optional[str] = None
    photoLicense: Optional[str] = None
    photoSourceUrl: Optional[str] = None


# Location twin props managed by put_locations (diff-by-name). lat/lng stay;
# every durable place-metadata field (#15/#95) rides along. The photo fields
# are RIGHTS-CLEAN stored media only (own upload / Wikimedia / press kit with
# license) — Google photos are never written here (live /api/places/photo
# overlay instead, #95).
_LOCATION_PROPS = (
    "marker", "alias", "lat", "lng", "placeId", "address", "website",
    "phone", "openingHours", "types", "wheelchairAccessible", "rating",
    "summary", "photo", "photoCredit", "photoLicense", "photoSourceUrl",
)


def _location_pairs(entry: LocationWrite) -> list[tuple[str, Any]]:
    """(prop, value) pairs to write for a registry entry.

    Explicit-clear contract (``model_fields_set``): absent fields are left
    untouched (a full replace that only names a place keeps its stored
    metadata); a present ``null`` emits ``(prop, None)`` so ``_scalar_ops``
    removes the prop from the twin; a present list — including ``[]`` — is
    written verbatim (an explicit ``[]`` clears a list field to empty).
    `rating` is a short-lived snapshot — accepted here, aged out by the
    read path once the trip goes stale.
    """
    pairs = []
    for prop in _LOCATION_PROPS:
        if prop not in entry.model_fields_set:
            continue
        value = getattr(entry, prop)
        pairs.append((prop, list(value) if isinstance(value, list) else value))
    return pairs


class LocationsPut(_Strict):
    locations: list[LocationWrite]


class LocationUpsert(_Strict):
    """One incremental location edit for PATCH /locations (named upsert).

    Matched by ``id`` when supplied, otherwise by ``name``. Only the fields
    present in the payload are patched — everything else on the twin keeps
    its stored value. A present ``null`` (or ``[]`` for a list field) clears
    that field. New names are appended to the registry (marker order
    = root ``atLocation`` edge index); unmentioned locations are untouched.
    """

    id: Optional[str] = Field(
        default=None,
        description="Location twin id ($dtId). When supplied, the entry matches that twin (unknown id = 404); otherwise matching is by `name`.",
    )
    name: str = Field(min_length=1, description="Place name (the canonical key). New names are appended.")
    marker: Optional[int] = Field(default=None, description="Explicit ① ② … loop-marker number.")
    alias: Optional[list[str]] = Field(default=None, description="Alternate names that resolve to this location.")
    lat: Optional[float] = Field(default=None, description="Latitude (enables map generation).")
    lng: Optional[float] = Field(default=None, description="Longitude (enables map generation).")
    placeId: Optional[str] = Field(default=None, description="Google place_id — the only third-party place key persisted indefinitely (#15 storage rule).")
    address: Optional[str] = Field(default=None, description="Formatted display address.")
    website: Optional[str] = Field(default=None, description="Official website URL of the place.")
    phone: Optional[str] = Field(default=None, description="Phone in international format.")
    openingHours: Optional[list[str]] = Field(default=None, description="Weekday opening-hours lines.")
    types: Optional[list[str]] = Field(default=None, description="Place types, e.g. ['ski_resort', 'lodging'].")
    wheelchairAccessible: Optional[bool] = Field(default=None, description="Whether the place is wheelchair accessible.")
    rating: Optional[float] = Field(default=None, description="Google rating snapshot (short-lived; aged out by the read path).")
    summary: Optional[str] = Field(default=None, description="Editorial summary of the place (markdown OK).")
    photo: Optional[str] = Field(default=None, description="Rights-clean stored photo — bare media filename or external image URL. Never a Google photo (#15/#95).")
    photoCredit: Optional[str] = Field(default=None, description="Credit line for the stored photo.")
    photoLicense: Optional[str] = Field(default=None, description="License of the stored photo.")
    photoSourceUrl: Optional[str] = Field(default=None, description="Source page URL of the stored photo.")


class LocationsPatch(_Strict):
    """Incremental location edits — named upserts only, never a replace."""

    locations: list[LocationUpsert]


class FeatureWrite(_Strict):
    """One editorial overview card for PUT/PATCH /features (issue #178).

    A Feature is a twin joined to the trip by an indexed ``hasFeature`` edge
    (card order = edge index, matching the seed). ``title`` is the natural
    match key for PATCH (features have no unique human key); ``id`` pins an
    exact twin when supplied. Only fields PRESENT in the payload are written;
    a present ``null`` clears that field, a present list — including ``[]`` —
    is written verbatim, and absent fields keep their stored value.
    """

    id: Optional[str] = Field(
        default=None,
        description="Feature twin id ($dtId). When supplied, the entry matches that twin (unknown id = 404); otherwise matching is by `title`.",
    )
    title: str = Field(min_length=1, description="Feature title (the canonical match key). New titles are appended.")
    kicker: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    images: Optional[list[str]] = None
    chips: Optional[list[str]] = None
    cards: Optional[list[FeatureCard]] = None
    map: Optional[bool] = None
    links: Optional[list[Link]] = None


class FeaturesPut(_Strict):
    """Full-array replace of the trip's editorial overview cards."""

    features: list[FeatureWrite]


class FeaturesPatch(_Strict):
    """Incremental feature edits — upserts by `id`/`title`, never a replace."""

    features: list[FeatureWrite]


# ---------------------------------------------------------------- validation
def _validate_block_kind_fields(kind: str, fields: set[str]) -> None:
    """Cross-field rules by block kind (the model is coarse on purpose)."""
    transport_given = _TRANSPORT_FIELDS & fields
    if transport_given and kind != "transport":
        raise WriteError(
            422, f"Field(s) {sorted(transport_given)} are only valid on transport blocks"
        )
    if "html" in fields and kind != "custom":
        raise WriteError(422, "Field 'html' is only valid on custom blocks")
    if "items" in fields and kind not in ("todo", "gallery"):
        raise WriteError(422, "Field 'items' is only valid on todo/gallery blocks")
    if "track" in fields and kind != "activity":
        raise WriteError(422, "Field 'track' is only valid on activity blocks")


def _validate_items(kind: str, items: list[Any]) -> list[Any]:
    """Normalize + validate the items array for todo/gallery blocks."""
    if kind == "todo":
        out = []
        for it in items:
            if not isinstance(it, dict):
                raise WriteError(422, "todo items must be objects {label, done, when?, links?}")
            try:
                out.append(TodoItem.model_validate(it).model_dump(exclude_none=True))
            except Exception as exc:
                raise WriteError(422, f"Invalid todo item: {exc}") from exc
        return out
    # gallery: bare media filenames (or full URLs kept verbatim). Stored as
    # {"url": f} — the one object shape the graph's DTDL `items` schema
    # accepts (todo items already live there); readers unwrap both shapes.
    if not all(isinstance(x, (str, dict)) for x in items):
        raise WriteError(422, "gallery items must be media filenames/URLs")
    return [
        it if isinstance(it, dict) else {"url": it}
        for it in items
    ]


def _validate_track(trip_dtid: str, track: Any) -> None:
    """A block `track` must name its uploaded .gpx/.fit — at attach time (#279, #290).

    The value stored is the BARE filename (the read path canonicalizes it to
    ``/media/<trip_id>/<file>`` like every other media field). A web URL is
    rejected by ``_reject_media_urls`` alongside images; here the extension is
    checked and — when a store is configured — the file must EXIST and parse,
    so a typo cannot leave a track card pointing at nothing. Without a store
    (unit tests that never configured one) only the shape is checked.
    """
    from pathlib import Path

    if track is None:
        return
    if not isinstance(track, str) or not track:
        raise WriteError(422, "track stores a bare .gpx/.fit filename — upload the file first (POST /api/files with tripId)")
    ext = Path(track).suffix.lower()
    if ext not in (".gpx", ".fit") or not is_valid_media_name(track):
        raise WriteError(
            422,
            f"track stores a bare .gpx/.fit filename, not {track[:60]!r} — upload the file first "
            "(POST /api/files with tripId) and write the name it returns",
        )
    store = get_media_store()
    if store is None:
        return
    chunks = store.get(object_key_for(trip_dtid, track))
    if chunks is None:
        raise WriteError(
            422,
            f"track {track!r} is not uploaded to this trip — upload the track first "
            "(POST /api/files with tripId) and write the name it returns",
        )
    try:
        if ext == ".fit":
            parse_fit(b"".join(chunks), track)
        else:
            parse_gpx(b"".join(chunks), track)
    except (GpxError, FitError) as exc:
        raise WriteError(422, str(exc)) from exc


def _validate_iso_date(value: Optional[str], what: str) -> None:
    if value is None:
        return
    try:
        _dt.date.fromisoformat(value)
    except ValueError as exc:
        raise WriteError(422, f"{what} must be ISO YYYY-MM-DD, got {value!r}") from exc


#: A media field value that is a web URL rather than a bare media filename.
_EXTERNAL_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _reject_media_urls(**fields: Any) -> None:
    """Media fields carry BARE filenames — 422 on a stored web URL (#187).

    The read path canonicalizes a bare name to ``/media/<trip_id>/<file>``, so a
    stored ``https://…`` is a hotlink and always a mistake: it 404s when the
    source moves or blocks hotlinking (the broken image a traveler reported), it
    cannot be embedded in the booklet, and it skips the Garage pipeline the
    content agent is supposed to use. Lists are checked item-wise and non-string
    items (gallery/todo objects) are ignored, so one helper guards every media
    field. ``Location.photo`` is deliberately exempt — it documents an external
    image URL as an accepted value (#95).
    """
    for name, value in fields.items():
        values = value if isinstance(value, (list, tuple)) else [value]
        for item in values:
            if isinstance(item, str) and _EXTERNAL_URL_RE.match(item.strip()):
                raise WriteError(
                    422,
                    f"{name} stores a bare media filename, not a URL "
                    f"({item.strip()[:60]!r}) — upload the file first "
                    "(POST /api/files with tripId) and write the name it "
                    "returns; a web link cannot be embedded in the booklet",
                )


def _reject_feature_media(features: Any) -> None:
    """Feature cards carry media fields too — guard image / images / cards[].image."""
    for feature in features or []:
        tag = getattr(feature, "title", "") or "?"
        nested = {
            f"features[{tag}].cards[{i}].image": card.image
            for i, card in enumerate(getattr(feature, "cards", None) or [])
        }
        _reject_media_urls(
            **{
                f"features[{tag}].image": getattr(feature, "image", None),
                f"features[{tag}].images": getattr(feature, "images", None),
            },
            **nested,
        )


def _validate_stage(current: str, new: str, role: str) -> None:
    if new == current:
        return
    if new == "archive":
        if role != "owner":
            raise WriteError(403, "Only the trip owner can archive a trip")
        return
    forward = _STAGE_IDX[new] > _STAGE_IDX[current]
    if forward:
        return  # forward + any skip allowed for editor+
    if role != "owner":
        raise WriteError(403, "Only the trip owner can move a trip backwards in stage")


def _model_kind(twin: dict) -> str:
    model = (twin.get("$metadata") or {}).get("$model", "")
    return model.rsplit(":", 1)[-1].split(";")[0] if model else ""


# ---------------------------------------------------------------- graph bits
def _client():
    c = get_graph_client()
    if c is None:
        raise WriteError(503, "Graph not configured")
    return c


def _fetch(client, trip_dtid: str) -> dict:
    """Fresh graph bundle for this trip (cache retired first — a write may
    have happened since the last read)."""
    _invalidate_graph_cache(trip_dtid=trip_dtid)
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        raise WriteError(404, "Trip not found")
    return graph


def _twin(graph: dict, dtid: str) -> dict | None:
    return next((t for t in graph.get("twins", []) if t.get("$dtId") == dtid), None)


def _trip_twin(graph: dict, trip_dtid: str) -> dict:
    t = _twin(graph, trip_dtid)
    if t is None or _model_kind(t) != "Trip":
        raise WriteError(404, "Trip not found")
    return t


def _rel(graph: dict, rel_id: str) -> dict | None:
    return next((r for r in graph.get("relationships", []) if r.get("$relationshipId") == rel_id), None)


def _scalar_ops(existing: dict, pairs: list[tuple[str, Any]]) -> list[dict]:
    """Build RFC 6902 ops from (prop, value) pairs against CURRENT props:
    add when missing, replace when present, remove on explicit None."""
    ops: list[dict] = []
    for prop, value in pairs:
        path = f"/{prop}"
        if value is None:
            if prop in existing:
                ops.append({"op": "remove", "path": path})
            continue
        ops.append({"op": "replace" if prop in existing else "add", "path": path, "value": value})
    return ops


def _theme_ops(existing: dict, theme: Theme) -> list[dict]:
    """Full replace of the theme block (preset-only, #40 follow-up).

    When ``theme`` is present in the PATCH body, the twin's theme dict is
    replaced wholesale: ``preset`` is added/replaced, and EVERY other key in
    the current theme dict (legacy primary/accent/surface/font/…/radius/
    mapStyle) is removed. Only ``remove`` ops for keys that actually exist
    are emitted — a ``remove`` on a missing path fails the whole patch.
    When ``theme`` is absent from the body, the caller emits nothing."""
    ops: list[dict] = []
    cur = existing.get("theme") if isinstance(existing.get("theme"), dict) else {}
    if not isinstance(cur, dict):
        cur = {}
    if theme.preset is not None:
        ops.append({
            "op": "replace" if "preset" in cur else "add",
            "path": "/theme/preset",
            "value": theme.preset,
        })
    for key in cur:
        if key != "preset":
            ops.append({"op": "remove", "path": f"/theme/{key}"})
    return ops


def _today() -> str:
    return _dt.date.today().isoformat()


def _new_id() -> str:
    return str(uuid.uuid4())


# Ordered block ids of a container (day/section), by their `order` property.
def _container_blocks(graph: dict, container_id: str) -> list[str]:
    ids = [
        r.get("$targetId")
        for r in graph.get("relationships", [])
        if r.get("$sourceId") == container_id and r.get("$relationshipName") == "hasBlock"
    ]
    by_id = {t["$dtId"]: t for t in graph.get("twins", [])}
    ordered = sorted(
        (i for i in ids if i in by_id),
        key=lambda i: by_id[i].get("order") if isinstance(by_id[i].get("order"), int) else 0,
    )
    return [str(i) for i in ordered]


def _rel_id(src: str, name: str, tgt: str) -> str:
    return f"{src}__{name}__{tgt}"


def _renumber(client, trip_dtid: str, container_id: str, block_ids: list[str], sub: str) -> None:
    """Write order=0..n-1 onto a container's blocks (order is the only truth)."""
    for i, bid in enumerate(block_ids):
        client.update_twin_props(
            trip_dtid, bid,
            [{"op": "replace", "path": "/order", "value": i}],
            x_user_id=sub,
        )


def _rebuild(client, trip_dtid: str, graph: dict | None = None,
             user_dtid: str | None = None) -> Trip:
    """Return the canonical Trip document (fresh read after the write).

    ``user_dtid`` additionally retires THAT user's memoized reads. The trip
    document is cached per TRIP but the "my trips" listing is cached per USER,
    so a trip-scalar write (title/stage/cover/visibility) that invalidated only
    ``trip_dtid`` left the landing page serving the pre-write row until the TTL
    expired (issue #185). ``delete_trip``/claim already pass both ids.
    """
    if graph is None:
        _invalidate_graph_cache(trip_dtid=trip_dtid, user_dtid=user_dtid)
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            raise WriteError(503, "Trip could not be re-read after write")
    try:
        return graph_to_trip(graph)
    except GraphNotFound as exc:  # trip vanished mid-write (#171)
        raise WriteError(503, "Trip could not be re-read after write") from exc


def _trip_of(graph: dict) -> Trip:
    return graph_to_trip(graph)


# ---------------------------------------------------------------- trip level
class TripCreate(_Strict):
    """POST /api/trips body (issue #9): spawn an empty trip.

    The agent fills it afterwards through the existing write API — creation
    only names it. ``title`` is required; everything else starts at the
    defaults (``stage: idea``, ``visibility: private``).
    """

    title: str = Field(min_length=1)
    subtitle: Optional[str] = None


def _slugify(title: str) -> str:
    """Kebab-case slug from a title (repo-folder style, uniqueness not required)."""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "trip"


def _drop_nones(value: Any) -> Any:
    """Drop explicit nulls recursively (mirrors scripts/trip_to_graph.twin):
    ADT validates null against the property schema, while absent is fine."""
    if isinstance(value, dict):
        return {k: _drop_nones(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_drop_nones(v) for v in value if v is not None]
    return value


def create_trip(actor_sub: str, token_sub: str, profile: dict[str, Any], payload: TripCreate) -> Trip:
    """Spawn an empty trip owned by the acting user (issue #9 / M4).

    The trip twin carries the same scalar shape a seed trip would (``stage:
    idea``, ``visibility: private``, no days/sections/crew yet) plus a fresh
    ``claimToken`` so the owner can invite crew afterwards; the creator's
    ``hasCrew`` edge (``role: owner``, ``index: 0``) is the ACL fact every
    later read/write gates on.

    Identity rule (#142): a missing User twin is provisioned ONLY from the
    caller's own token profile. An act-as sub with no twin is a 403 — the
    agent never provisions identity for the mapped user behind their back.
    A user token with no email anywhere is a 403 too: a User twin without a
    verified email is not useful, and the server invents no identity.
    """
    client = _client()
    title = (payload.title or "").strip()
    if not title:
        raise WriteError(422, "Trip title must not be blank")
    if not actor_sub or not token_sub:
        raise WriteError(401, "Missing actor identity")
    if not client.user_twin_exists(actor_sub):
        if actor_sub != token_sub:
            raise WriteError(
                403,
                "No user identity for this act-as sub — sign in with the user's own token first",
            )
        if not client.create_user_twin(actor_sub, profile or {}):
            raise WriteError(
                403,
                "Cannot create a user identity without a verified email",
            )
    trip_id = _new_id()
    doc = Trip(
        id=trip_id,
        slug=_slugify(title),
        title=title,
        subtitle=(payload.subtitle or "").strip(),
        stage="idea",
        visibility="private",
        discoverable=True,
        claimToken=secrets.token_urlsafe(24),
        updated=_today(),
    )
    props = doc.model_dump(by_alias=True)
    for field in ("days", "locations", "crew", "features", "sections"):
        props.pop(field, None)
    props.pop("id", None)
    twin: dict[str, Any] = {"$dtId": trip_id, "$metadata": {"$model": TRIP_MODEL}}
    twin.update(_drop_nones(props))
    client.upsert_twin(trip_id, twin, x_user_id=actor_sub)
    # The owner's crew name on THIS trip rides the edge (issue #196) — a claim
    # or an account rename must never rewrite it. At creation the token profile
    # is the source; when it carries no name/email (no userinfo — the ordinary
    # Auth0 access token), the creator's own twin name is the honest fallback.
    # The opaque auth sub is never a crew label (issue #213).
    owner_name = ((profile or {}).get("name") or "").strip()
    if not owner_name:
        owner_name = ((profile or {}).get("email") or "").split("@")[0].strip()
    if not owner_name:
        twin = client.get_user_profile(actor_sub) or {}
        owner_name = (twin.get("displayName") or twin.get("name") or "").strip()
    rel: dict[str, Any] = {
        "$relationshipId": _rel_id(trip_id, "hasCrew", actor_sub),
        "$sourceId": trip_id,
        "$relationshipName": "hasCrew",
        "$targetId": actor_sub,
        "role": "owner",
        "index": 0,
    }
    if owner_name:
        rel["displayName"] = owner_name
    client.upsert_relationship(trip_id, rel, x_user_id=actor_sub)
    # The creator's trip list is cached per user — retire it so the new trip
    # shows up on the landing immediately.
    _invalidate_graph_cache(trip_dtid=trip_id, user_dtid=actor_sub)
    return _rebuild(client, trip_id)


def delete_trip(trip_dtid: str, actor: dict) -> None:
    """Owner-only: delete a trip twin and EVERYTHING scoped to it (issue #163).

    The graph server does NOT cascade twin deletes — a twin with incident
    edges refuses deletion ("Cannot delete a vertex that has edge(s)", #89) —
    so this walks the whole trip subgraph edges-first: every relationship
    SOURCED inside the trip (the trip's own ``hasDay``/``hasSection``/
    ``hasFeature``/root ``atLocation`` edges, plus every section/day/block's
    outgoing ``hasDay``/``hasBlock``/``atLocation`` edges) is deleted before
    any twin, then the Trip/Day/Section/Block/Feature twins go, then finally
    the Trip twin itself.

    Crew-linked Person twins: a placeholder Person (claimed via #6 pending)
    only makes sense inside its trip, so it goes with the trip; a **claimed
    User twin** is a global identity (``$dtId`` = the auth sub) that belongs
    to its human across every trip and is NEVER deleted here — only the
    ``hasCrew`` edge (an inside-the-trip edge, already removed above) tied it
    to this trip. The same rule scopes the edge sweep (#222): an edge is
    trip-scoped when its SOURCE twin is trip-scoped, so a User twin's own
    outgoing edges (``follows``) survive alongside it.

    Order matters everywhere: edges before their twins, targets before the
    trip. Returns None — there is nothing left to rebuild; the route answers
    204. Re-runnable by construction: every pass re-fetches the CURRENT
    bundle and removes what remains, so a run that failed mid-way converges
    to fully deleted on the next attempt (the second DELETE of a finished
    cleanup is a plain 404 at the route gate).
    """
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can delete a trip")
    client = _client()
    graph = _fetch(client, trip_dtid)
    _trip_twin(graph, trip_dtid)  # presence + model check (404 on mismatch)
    sub = actor["sub"]

    relationships = graph.get("relationships", [])
    twins = {t.get("$dtId"): t for t in graph.get("twins", [])}

    # 0) Which crew placeholders SURVIVE this trip (#322)? A placeholder is a
    #    shared twin — one Person, one hasCrew edge per trip — so it outlives
    #    the trip whenever a SIBLING trip still crews them. Decided here, from
    #    the live graph, BEFORE the sweep that removes this trip's edges: the
    #    sibling edge is what answers the question, and by step 3 it is the
    #    only thing left to read anyway. Deleting a still-crewed placeholder is
    #    not merely wrong, it is REFUSED by the graph (a vertex with edges) —
    #    which would 503 the delete after the whole trip was already swept.
    shared_placeholders = {
        dtid
        for dtid, twin in twins.items()
        if _model_kind(twin) == "Person"
        and any(
            e.get("tripId") != trip_dtid
            for e in _person_crew_edges(client, dtid)
        )
    }

    # 1) Edges first — every edge SOURCED by a TRIP-SCOPED twin goes with the
    #    trip. #222: the bundle is wider than the trip (MAX_HOPS reachability
    #    finds the crew's User twins through hasCrew), so it also carries THEIR
    #    outgoing edges — `follows`, sourced at a global auth sub, which belong
    #    to the human and outlive the trip. Scope the sweep by the source twin's
    #    MODEL KIND, exactly like the twin sweep below (which skips User twins),
    #    instead of deleting whatever the bundle happened to return: feeding a
    #    non-UUID source to delete_relationship trips the client's content guard
    #    (GraphWriteError 422 → 500) *after* the trip-sourced edges are already
    #    gone, orphaning the trip behind a role-less ACL gate.
    for r in relationships:
        src = r.get("$sourceId")
        rel_id = r.get("$relationshipId")
        if not src or not rel_id:
            continue
        twin = twins.get(src)
        if twin is None:
            continue
        if _model_kind(twin) == "User":
            continue  # global identity — its edges (follows) outlive the trip
        client.delete_relationship(src, rel_id, x_user_id=sub)

    # 2) Twin deletes, leaves first — Feature/Location/Block/Section/Day
    #    before the Trip root. Person placeholders go with the trip; claimed
    #    User twins (global identities, $dtId = auth sub) are never deleted.
    leaf_order = ("Feature", "Location", "Block", "TripSection", "Day", "Trip")
    ordered = sorted(
        twins.items(),
        key=lambda kv: leaf_order.index(_model_kind(kv[1]))
        if _model_kind(kv[1]) in leaf_order else len(leaf_order),
    )
    for dtid, twin in ordered:
        kind = _model_kind(twin)
        if kind == "User":
            continue  # global identity — outlives the trip
        if kind == "Person":
            continue  # crew-linked placeholders ride below, never via this loop
        client.delete_twin(trip_dtid, dtid, x_user_id=sub)
    # Person twins here are crew placeholders (#6). Since #322 a placeholder can
    # be SHARED across trips (one Person, one hasCrew edge per trip), so it goes
    # only when THIS trip held its last crew edge — see ``shared_placeholders``
    # above, decided before the sweep.
    for dtid, twin in twins.items():
        if _model_kind(twin) != "Person":
            continue
        if dtid in shared_placeholders:
            continue  # still crew on another trip — the placeholder outlives this one
        client.delete_twin(trip_dtid, dtid, x_user_id=sub)

    # The trip is gone — retire its cached reads (and the owner's trip list,
    # which no longer contains it).
    _invalidate_graph_cache(trip_dtid=trip_dtid, user_dtid=actor["sub"])


def update_trip(trip_dtid: str, actor: dict, patch: TripPatch) -> Trip:
    """Trip scalar edits + stage machine + owner-only visibility.

    Actor role gates are enforced HERE (not just by the route), so the service
    is safe to call from anywhere: visibility + stage transitions per the
    approved rules; ``claimToken`` is not in the payload model at all.
    """
    _reject_media_urls(cover=patch.cover, map=patch.map)
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    trip = _trip_of(graph)
    ops: list[dict] = []

    fields = patch.model_dump(exclude_unset=True, exclude={"theme", "visibility", "stage", "discoverable"})
    for prop in ("title", "subtitle", "summary", "cover", "coverCredit", "map"):
        if prop in fields:
            ops += _scalar_ops(trip_twin, [(prop, fields[prop])])
    for prop in ("startDate", "endDate"):
        if prop in fields:
            _validate_iso_date(fields[prop], prop)
            ops += _scalar_ops(trip_twin, [(prop, fields[prop])])
    for prop in ("coverStats", "stats"):
        # Issue #178: list-valued trip scalars. A PRESENT ``null`` (or ``[]``)
        # clears the prop; an ABSENT field keeps the stored value — the same
        # explicit-clear contract as PATCH /locations, so a partial PUT can
        # never wipe a strip the caller didn't mean to touch.
        if prop in patch.model_fields_set:
            value = getattr(patch, prop)
            if prop == "stats" and value is not None:
                value = [
                    s.model_dump() if isinstance(s, Stat) else dict(s) for s in value
                ]
            ops += _scalar_ops(trip_twin, [(prop, value)])
    if "timezone" in fields and fields["timezone"] is not None:
        # Cheap sanity: must look like an IANA zone; the frontend degrades
        # gracefully on unknown zones (Intl fallback), so no hard lookup here.
        ops += _scalar_ops(trip_twin, [("timezone", fields["timezone"])])

    if patch.theme is not None:
        ops += _theme_ops(trip_twin, patch.theme)

    if "stage" in patch.model_fields_set:
        new_stage = patch.stage or trip.stage
        _validate_stage(trip.stage, new_stage, actor["role"])
        ops += _scalar_ops(trip_twin, [("stage", new_stage)])

    if "visibility" in patch.model_fields_set and patch.visibility != trip.visibility:
        if actor["role"] != "owner":
            raise WriteError(403, "Only the trip owner can change visibility")
        ops += _scalar_ops(trip_twin, [("visibility", patch.visibility)])

    if "discoverable" in patch.model_fields_set and patch.discoverable != trip.discoverable:
        if actor["role"] != "owner":
            raise WriteError(403, "Only the trip owner can change discoverability")
        ops += _scalar_ops(trip_twin, [("discoverable", patch.discoverable)])

    ops += _scalar_ops(trip_twin, [("updated", _today())])
    if ops:
        client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid, user_dtid=actor["sub"])


# ------------------------------------------------------- links (#6 / #197)
def mint_follow_link(trip_dtid: str, actor: dict) -> str:
    """Owner-only: mint (or rotate) the trip's FOLLOW link (#197).

    A SECOND secret, deliberately not the claim token: the follow link can be
    handed to people who should read the trip and follow it but must never be
    able to claim a crew identity. Rotating it revokes the previous follow
    link without touching the crew invite — and revoking the invite leaves
    every follow link working.
    """
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can manage the follow link")
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    previous = graph_to_trip(graph).followToken
    token = secrets.token_urlsafe(24)
    ops = _scalar_ops(trip_twin, [("followToken", token)])
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    _invalidate_graph_cache(trip_dtid=trip_dtid, user_dtid=actor["sub"], token=previous)
    return token


def revoke_claim_invite(trip_dtid: str, actor: dict) -> None:
    """Owner-only: disable the crew invite by clearing ``claimToken`` (#197).

    Invite-only publishing that can never be narrowed is a trap: a link
    leaked into a WhatsApp group can be killed without killing the trip.
    Existing crew keep their roles and followers keep following — what dies
    is the ability to CLAIM through that link (and to follow through it).
    Idempotent: revoking twice is not an error.
    """
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can revoke the invite link")
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    previous = graph_to_trip(graph).claimToken
    ops = _scalar_ops(trip_twin, [("claimToken", None)])
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    _invalidate_graph_cache(trip_dtid=trip_dtid, user_dtid=actor["sub"], token=previous)


# ---------------------------------------------------------------- practical
def put_practical(trip_dtid: str, actor: dict, body: PracticalPut) -> Trip:
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    value = Practical.model_validate(body.model_dump()).model_dump(exclude_none=True)
    # tricount is managed by the dedicated connect/disconnect endpoints (#111):
    # a practical PUT must never clobber (or forge) the connection.
    current = graph_to_trip(graph).practical
    if current.tricount is not None:
        value["tricount"] = current.tricount.model_dump(exclude_none=True)
    ops = _scalar_ops(trip_twin, [("practical", value)])
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


def connect_tricount(trip_dtid: str, actor: dict, body: TricountConnect) -> Trip:
    """Owner-only: link the trip to a Tricount registry (issue #111).

    The registry is fetched and validated BEFORE anything is written — an
    unresolvable key is a 502/404, never a stored bad key. Editor+ could see
    the panel; only the owner decides what the trip is connected to (same
    gate as visibility / crew roles)."""
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can connect Tricount")
    snapshot = tricount_svc.validate_registry_key(body.normalized_key())  # 404/502 on a bad key
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    practical = graph_to_trip(graph).practical
    value = connect_and_validate(practical.model_dump(exclude_none=True), snapshot.registryKey)
    ops = _scalar_ops(trip_twin, [("practical", value)])
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


def disconnect_tricount(trip_dtid: str, actor: dict) -> Trip:
    """Owner-only: remove the trip's Tricount connection (idempotent)."""
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can disconnect Tricount")
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    practical = graph_to_trip(graph).practical
    if practical.tricount is None:
        return _rebuild(client, trip_dtid)  # already disconnected — no write
    value = tricount_svc.disconnect_ops(practical.model_dump(exclude_none=True))
    ops = _scalar_ops(trip_twin, [("practical", value)])
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


def toggle_todo(trip_dtid: str, actor: dict, index: int, body: TodoToggle) -> Trip:
    """The #46 proof slice — per-item toggle, atomic at the item path."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip = _trip_of(graph)
    if not 0 <= index < len(trip.practical.todos):
        raise WriteError(404, f"No todo at index {index}")
    trip_twin = _trip_twin(graph, trip_dtid)
    ops = [{
        "op": "replace",
        "path": f"/practical/todos/{index}/done",
        "value": body.done,
    }]
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


def add_todo(trip_dtid: str, actor: dict, body: TodoAdd) -> Trip:
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    item = TodoItem(
        label=body.label, done=body.done, when=body.when, links=body.links
    ).model_dump(exclude_none=True)
    ops = [{"op": "add", "path": "/practical/todos/-", "value": item}]
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


def _practical_blocks(trip: Trip) -> list[PracticalBlock]:
    return trip.practical.blocks


def _practical_block_add_op(trip_twin: dict, value: dict, index: int | None) -> dict:
    """The ONE RFC 6902 op that appends/inserts a practical block (#273).

    Scoped to the blocks array — or, on a section that has never had one, to
    creating exactly that key. Nothing else about ``practical`` rides in the
    request, which is what makes the per-block verbs clobber-free: a
    concurrent todo/link/contact edit cannot be lost, because no op touches
    those keys (the whole-object PUT was authoritative for all five).

    An explicit ``index`` is the insert position; out of range is a 422, never
    a silently-ignored append (a caller who asked for position 3 and got the
    last slot instead has no way to notice).
    """
    practical = trip_twin.get("practical")
    stored_blocks = practical.get("blocks") if isinstance(practical, dict) else None
    if isinstance(stored_blocks, list):
        if index is None:
            return {"op": "add", "path": "/practical/blocks/-", "value": value}
        if not 0 <= index <= len(stored_blocks):
            raise WriteError(422, f"No insert position {index} in {len(stored_blocks)} practical blocks")
        return {"op": "add", "path": f"/practical/blocks/{index}", "value": value}
    # No stored array yet: position 0 (or append, which is the same thing) is
    # the only position there is, so create the array rather than patching
    # into a path that does not exist.
    if index not in (None, 0):
        raise WriteError(422, f"No insert position {index} in 0 practical blocks")
    if isinstance(practical, dict):
        return {"op": "add", "path": "/practical/blocks", "value": [value]}
    return {"op": "add", "path": "/practical", "value": {"blocks": [value]}}


def add_practical_block(trip_dtid: str, actor: dict, body: PracticalBlockAdd) -> Trip:
    """Add ONE titled practicality block (#273).

    The smallest useful practical edit: a roadbook heading plus its body, in
    one call — no trip GET, no section rebuild, no verifying GET, and no
    silent-clobber window over the rest of the section.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    item = PracticalBlock(title=body.title, body=body.body)
    ops = [_practical_block_add_op(trip_twin, item.model_dump(), body.index)]
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


def update_practical_block(
    trip_dtid: str, actor: dict, index: int, body: PracticalBlockPatch
) -> Trip:
    """Edit ONE practical block in place (#273) — patch semantics: only the
    fields sent are written, and every other block keeps its position."""
    fields = body.model_dump(exclude_unset=True, exclude_none=True)
    if not fields:
        raise WriteError(422, "Nothing to update — send title and/or body")
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    blocks = _practical_blocks(_trip_of(graph))
    if not 0 <= index < len(blocks):
        raise WriteError(404, f"No practical block at index {index}")
    patched = blocks[index].model_copy(update=fields)
    ops = [{"op": "replace", "path": f"/practical/blocks/{index}", "value": patched.model_dump()}]
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


def delete_practical_block(trip_dtid: str, actor: dict, index: int) -> Trip:
    """Delete ONE practical block (#273); the remaining blocks keep their order."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    blocks = _practical_blocks(_trip_of(graph))
    if not 0 <= index < len(blocks):
        raise WriteError(404, f"No practical block at index {index}")
    ops = [{"op": "remove", "path": f"/practical/blocks/{index}"}]
    ops += _scalar_ops(trip_twin, [("updated", _today())])
    client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


# ---------------------------------------------------------------- days
def update_day(trip_dtid: str, actor: dict, day_id: str, patch: DayPatch) -> Trip:
    _reject_media_urls(map=patch.map)
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    day_ids = {
        r.get("$targetId") for r in graph.get("relationships", [])
        if r.get("$sourceId") == root["$dtId"] and r.get("$relationshipName") == "hasDay"
    }
    twin = _twin(graph, day_id)
    if twin is None or day_id not in day_ids or _model_kind(twin) != "Day":
        raise WriteError(404, "Day not found on this trip")
    fields = patch.model_dump(exclude_unset=True)
    if "date" in fields:
        if fields["date"] and fields["date"] != twin.get("date"):
            raise WriteError(422, "A day's date is calendar truth — not editable")
    pairs = []
    for prop in ("title", "notes", "map"):
        if prop in fields:
            pairs.append((prop, fields[prop]))
    if "meta" in fields:
        pairs.append(("meta", fields["meta"]))
    ops = _scalar_ops(twin, pairs)
    if ops:
        client.update_twin_props(trip_dtid, day_id, ops, x_user_id=actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def _default_day_date(graph: dict, day_ids: list[str], index: int, root: dict) -> str:
    """Neighbor-based default date for an inserted day.

    A day's date is immutable after creation (update_day rejects edits), so
    the default guesses the most plausible: previous day + 1 when inserting
    after it (duplicating the next day's date mid-trip when days run
    consecutive — the caller should pass an explicit date then), first day
    − 1 when prepending, trip startDate / today on an empty trip.
    """
    by_id = {t["$dtId"]: t for t in graph.get("twins", [])}

    def _shift(iso: Any, delta: int) -> str | None:
        if not isinstance(iso, str) or not iso:
            return None
        try:
            return (_dt.date.fromisoformat(iso) + _dt.timedelta(days=delta)).isoformat()
        except ValueError:
            return None

    if day_ids and index > 0:
        shifted = _shift((by_id.get(day_ids[index - 1]) or {}).get("date"), 1)
        if shifted:
            return shifted
    if day_ids and index == 0:
        shifted = _shift((by_id.get(day_ids[0]) or {}).get("date"), -1)
        if shifted:
            return shifted
    shifted = _shift(root.get("startDate"), 0)
    return shifted or _today()


def create_day(trip_dtid: str, actor: dict, payload: DayCreate) -> Trip:
    """Insert a new Day twin at 0-based position ``index`` (default = append).

    Day identity is the opaque twin id (never the position), so the insert
    re-indexes the trip's ``hasDay`` edges: the new day takes ``index``, every
    day at/after it moves +1 (upsert under the stable deterministic edge id).
    Section ranges follow the insert so the same days stay covered:

    - chapter starts strictly after the insert (``first > index``) → ``+1``;
    - chapter spans the insert or ends exactly on it (``last >= index``) →
      the end moves ``+1`` — the chapter grows to swallow the new day;
    - chapter ends before the insert → untouched.

    Appending past every chapter extends the chapter covering the old last
    day (when one exists), so the tiling invariant — every day under exactly
    one section — survives the insert at any position. ``locationRefs`` /
    ``atLocation`` edges are place references, never day references, and are
    left untouched.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    day_ids = _trip_day_ids_by_index(graph, root["$dtId"])
    n_days = len(day_ids)

    index = n_days if payload.index is None else payload.index
    if (not isinstance(index, int) or isinstance(index, bool)
            or not 0 <= index <= n_days):
        raise WriteError(
            422,
            f"Day index {payload.index!r} out of range — trip has {n_days} days (0..{n_days})",
        )

    if payload.date is not None:
        _validate_iso_date(payload.date, "date")
        date = payload.date
    else:
        date = _default_day_date(graph, day_ids, index, root)

    day_id = _new_id()
    client.upsert_twin(
        trip_dtid,
        {
            "$dtId": day_id,
            "$metadata": {"$model": DAY_MODEL},
            "date": date,
            "title": payload.title or "",
        },
        x_user_id=actor["sub"],
    )
    client.upsert_relationship(
        trip_dtid,
        {
            "$relationshipId": _rel_id(trip_dtid, "hasDay", day_id),
            "$sourceId": trip_dtid,
            "$relationshipName": "hasDay",
            "$targetId": day_id,
            "index": index,
        },
        x_user_id=actor["sub"],
    )
    for i in range(index, n_days):
        client.upsert_relationship(
            trip_dtid,
            {
                "$relationshipId": _rel_id(trip_dtid, "hasDay", day_ids[i]),
                "$sourceId": trip_dtid,
                "$relationshipName": "hasDay",
                "$targetId": day_ids[i],
                "index": i + 1,
            },
            x_user_id=actor["sub"],
        )

    # Section ranges follow the insert. Edges point at day twin ids (stable
    # across the insert — the read path derives section days from the trip's
    # day order), so only the twin ``days`` property and the edges'
    # seed-canonical ``index`` props (trip-day position) are rewritten.
    new_order = day_ids[:index] + [day_id] + day_ids[index:]
    pos_of = {tid: i for i, tid in enumerate(new_order)}
    sections = [
        (r.get("$targetId"), _twin(graph, r.get("$targetId")))
        for r in graph.get("relationships", [])
        if r.get("$sourceId") == root["$dtId"] and r.get("$relationshipName") == "hasSection"
    ]
    claimed = False
    for sid, stwin in sections:
        if stwin is None or _model_kind(stwin) != "TripSection":
            continue
        covered = _section_day_indices(graph, sid, day_ids)
        if not covered:
            continue  # ideation section — no days to shift
        first, last = min(covered), max(covered)
        new_first = first + 1 if first > index else first
        new_last = last + 1 if last >= index else last
        if (new_first, new_last) == (first, last):
            continue
        client.update_twin_props(
            trip_dtid, sid,
            _scalar_ops(stwin, [("days", [new_first, new_last])]),
            x_user_id=actor["sub"],
        )
        for i in covered:
            tgt = day_ids[i]
            client.upsert_relationship(
                trip_dtid,
                {
                    "$relationshipId": _rel_id(sid, "hasDay", tgt),
                    "$sourceId": sid,
                    "$relationshipName": "hasDay",
                    "$targetId": tgt,
                    "index": pos_of[tgt],
                },
                x_user_id=actor["sub"],
            )
        if new_first <= index <= new_last:
            client.upsert_relationship(
                trip_dtid,
                {
                    "$relationshipId": _rel_id(sid, "hasDay", day_id),
                    "$sourceId": sid,
                    "$relationshipName": "hasDay",
                    "$targetId": day_id,
                    "index": index,
                },
                x_user_id=actor["sub"],
            )
            claimed = True

    if index == n_days and not claimed:
        # Appending past every chapter: extend the chapter covering the old
        # last day (when one exists) so the new final day stays chaptered.
        for sid, stwin in sections:
            if stwin is None or _model_kind(stwin) != "TripSection":
                continue
            covered = _section_day_indices(graph, sid, day_ids)
            if covered and max(covered) == n_days - 1:
                client.update_twin_props(
                    trip_dtid, sid,
                    _scalar_ops(stwin, [("days", [min(covered), n_days])]),
                    x_user_id=actor["sub"],
                )
                client.upsert_relationship(
                    trip_dtid,
                    {
                        "$relationshipId": _rel_id(sid, "hasDay", day_id),
                        "$sourceId": sid,
                        "$relationshipName": "hasDay",
                        "$targetId": day_id,
                        "index": index,
                    },
                    x_user_id=actor["sub"],
                )
                break

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def delete_day(trip_dtid: str, actor: dict, day_id: str) -> Trip:
    """Remove a Day twin at its 0-based position (the complement of create_day).

    The day's blocks go with it (no orphan twins), the trip's ``hasDay`` edge
    is dropped and every later day re-indexes -1, and every section range that
    spans or sits after the removed index shrinks/shifts -1/-1 so the same
    surviving days stay covered and the tiling invariant — every day under
    exactly one section — survives the delete. A section left with no days
    becomes an ideation section (``days`` = []). ``locationRefs`` /
    ``atLocation`` edges are place references, never day references, and are
    left untouched. Deleting the last remaining day is a 422.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    day_ids = _trip_day_ids_by_index(graph, root["$dtId"])
    n_days = len(day_ids)

    if day_id not in set(day_ids):
        raise WriteError(404, "Day not found on this trip")
    if n_days <= 1:
        raise WriteError(422, "A trip must keep at least one day")

    index = day_ids.index(day_id)
    sub = actor["sub"]

    # The day's blocks go with it (the graph server does not cascade —
    # a twin with edges refuses deletion, same no-cascade rule as
    # delete_block/put_locations): drop the day-sourced hasBlock edge +
    # any block-sourced edges first, then the block twin.
    day_blocks = _container_blocks(graph, day_id)
    for bid in day_blocks:
        client.delete_relationship(
            day_id, _rel_id(day_id, "hasBlock", bid), x_user_id=sub
        )
    for bid in day_blocks:
        for r in [r for r in graph.get("relationships", [])
                  if r.get("$sourceId") == bid]:
            client.delete_relationship(
                bid, r["$relationshipId"], x_user_id=sub
            )
    for bid in day_blocks:
        client.delete_twin(trip_dtid, bid, x_user_id=sub)

    # Section hasDay edges pointing at the doomed day (each sourced at its
    # section) + the trip's own hasDay edge (sourced at the trip).
    sections = [
        (r.get("$targetId"), _twin(graph, r.get("$targetId")))
        for r in graph.get("relationships", [])
        if r.get("$sourceId") == root["$dtId"] and r.get("$relationshipName") == "hasSection"
    ]
    for sid, _ in sections:
        if sid is None:
            continue
        if day_id in {
            r.get("$targetId")
            for r in graph.get("relationships", [])
            if r.get("$sourceId") == sid and r.get("$relationshipName") == "hasDay"
        }:
            client.delete_relationship(
                sid, _rel_id(sid, "hasDay", day_id), x_user_id=sub
            )
    client.delete_relationship(
        trip_dtid, _rel_id(trip_dtid, "hasDay", day_id), x_user_id=sub
    )
    client.delete_twin(trip_dtid, day_id, x_user_id=sub)

    # Re-index the surviving trip hasDay edges so index props stay contiguous.
    new_order = day_ids[:index] + day_ids[index + 1:]
    for i, tid in enumerate(new_order):
        client.upsert_relationship(
            trip_dtid,
            {
                "$relationshipId": _rel_id(trip_dtid, "hasDay", tid),
                "$sourceId": trip_dtid,
                "$relationshipName": "hasDay",
                "$targetId": tid,
                "index": i,
            },
            x_user_id=sub,
        )

    # Re-tile sections: drop the removed index, shift later days -1, rewrite
    # the twin ``days`` property and the surviving edges' index props.
    pos_of = {tid: i for i, tid in enumerate(new_order)}
    for sid, stwin in sections:
        if sid is None or stwin is None or _model_kind(stwin) != "TripSection":
            continue
        covered = _section_day_indices(graph, sid, day_ids)
        if not covered:
            continue  # ideation section — no days to shift
        new_covered = sorted(
            (i - 1 if i > index else i) for i in covered if i != index
        )
        days_prop: list[int] = [min(new_covered), max(new_covered)] if new_covered else []
        client.update_twin_props(
            trip_dtid, sid,
            _scalar_ops(stwin, [("days", days_prop)]),
            x_user_id=sub,
        )
        for i in covered:
            if i == index:
                continue
            tgt = day_ids[i]
            client.upsert_relationship(
                trip_dtid,
                {
                    "$relationshipId": _rel_id(sid, "hasDay", tgt),
                    "$sourceId": sid,
                    "$relationshipName": "hasDay",
                    "$targetId": tgt,
                    "index": pos_of[tgt],
                },
                x_user_id=sub,
            )

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


# ---------------------------------------------------------------- sections
def _trip_day_ids_by_index(graph: dict, root_id: str) -> list[str]:
    """Ordered day twin ``$dtId``s for a trip, in calendar (day-index) order.

    The canonical day order is the trip's ``hasDay`` edge ``index`` property
    (falling back to the day's ISO ``date``), so index i in the returned list
    is trip day i — the day a section's range entry refers to.
    """
    rows = []
    for r in graph.get("relationships", []):
        if r.get("$sourceId") == root_id and r.get("$relationshipName") == "hasDay":
            t = _twin(graph, r.get("$targetId"))
            if t is None or _model_kind(t) != "Day":
                continue
            idx = r.get("index")
            rows.append((idx if isinstance(idx, int) else 10**9, t.get("date") or "", t["$dtId"]))
    rows.sort(key=lambda x: (x[0], x[1]))
    return [tid for _, _, tid in rows]


def _section_day_indices(graph: dict, section_id: str, day_ids: list[str]) -> list[int]:
    """0-based trip-day indices a section's ``hasDay`` edges cover, sorted."""
    idx_of = {tid: i for i, tid in enumerate(day_ids)}
    out = []
    for r in graph.get("relationships", []):
        if r.get("$sourceId") == section_id and r.get("$relationshipName") == "hasDay":
            i = idx_of.get(r.get("$targetId"))
            if i is not None:
                out.append(i)
    return sorted(out)


def _validate_section_days(days: Any, n_days: int) -> tuple[int, int]:
    """Validate an inclusive [first, last] 0-based range against the trip."""
    if (not isinstance(days, list) or len(days) != 2
            or not all(isinstance(x, int) and not isinstance(x, bool) for x in days)):
        raise WriteError(422, "Section days must be an inclusive [first, last] pair of day indices")
    first, last = days
    if first < 0 or last >= n_days or first > last:
        raise WriteError(422, f"Section days {days} out of range — trip has {n_days} days (0..{n_days - 1})")
    return first, last


def _validate_location_refs_exist(graph: dict, names: list[str]) -> None:
    """Check that every ``locationRefs`` name maps to a Location twin.

    Pure validation — no writes (issue #172: validate-then-write). ``create_section``
    calls this before any upsert so a 422 leaves the graph untouched; the shared
    ``_sync_section_location_refs`` re-runs it after the twin is created.
    """
    locations = {
        t.get("name")
        for t in graph.get("twins", []) if _model_kind(t) == "Location"
    }
    for n in names:
        if n not in locations:
            raise WriteError(422, f"Unknown location {n!r} — add it to the trip first")


def _sync_section_location_refs(
    client: Any, trip_dtid: str, graph: dict, section_id: str, names: list[str], x_user_id: str
) -> None:
    """Make a section's ``atLocation`` edges exactly ``names`` (registry names)."""
    locations = {
        t.get("name"): t["$dtId"]
        for t in graph.get("twins", []) if _model_kind(t) == "Location"
    }
    for n in names:
        if n not in locations:
            raise WriteError(422, f"Unknown location {n!r} — add it to the trip first")
    cur = {
        r.get("$targetId") for r in graph.get("relationships", [])
        if r.get("$sourceId") == section_id and r.get("$relationshipName") == "atLocation"
    }
    keep = {locations[n] for n in names if locations[n] in cur}
    for target in cur - keep:
        # Edges are sourced at the SECTION, not the trip (issue #89).
        client.delete_relationship(
            section_id, _rel_id(section_id, "atLocation", target), x_user_id=x_user_id
        )
    for n in names:
        target = locations[n]
        if target not in cur:
            client.upsert_relationship(
                trip_dtid,
                {
                    "$relationshipId": _rel_id(section_id, "atLocation", target),
                    "$sourceId": section_id,
                    "$relationshipName": "atLocation",
                    "$targetId": target,
                },
                x_user_id=x_user_id,
            )


def _sync_section_days(
    client: Any, trip_dtid: str, graph: dict, root: dict, section_id: str,
    days: Optional[list[int]], x_user_id: str,
) -> list[int]:
    """Rewrite a section's hasDay edges (and twin ``days`` property) to ``days``.

    Returns the twin ``days`` property to store ([first, last] or [] for an
    ideation section). ``days`` may also be None/[] — that clears the section's
    day coverage (pure ideation). Overlap with any OTHER section is a 422.
    """
    day_ids = _trip_day_ids_by_index(graph, root["$dtId"])
    n_days = len(day_ids)
    day_id_for = {i: tid for i, tid in enumerate(day_ids)}

    if days is None:
        new_indices: set[int] = set()
        first_last: Optional[list[int]] = None
    elif not days:
        new_indices = set()
        first_last = []
    else:
        first, last = _validate_section_days(days, n_days)
        new_indices = set(range(first, last + 1))
        first_last = [first, last]

    # Overlap guard: a day renders under exactly one section.
    if new_indices:
        for r in graph.get("relationships", []):
            if (r.get("$sourceId") == root["$dtId"]
                    and r.get("$relationshipName") == "hasSection"
                    and r.get("$targetId") != section_id):
                other = _twin(graph, r["$targetId"])
                if other is None or _model_kind(other) != "TripSection":
                    continue
                covered = set(_section_day_indices(graph, r["$targetId"], day_ids))
                clash = sorted(new_indices & covered)
                if clash:
                    raise WriteError(
                        422,
                        f"Section days {days} overlap '{other.get('title')}' "
                        f"(already covers day {clash[0]}) — sections must not share days",
                    )

    cur = set(_section_day_indices(graph, section_id, day_ids))
    for i in sorted(cur - new_indices):
        client.delete_relationship(
            section_id, _rel_id(section_id, "hasDay", day_id_for[i]), x_user_id=x_user_id
        )
    for i in sorted(new_indices - cur):
        client.upsert_relationship(
            trip_dtid,
            {
                "$relationshipId": _rel_id(section_id, "hasDay", day_id_for[i]),
                "$sourceId": section_id,
                "$relationshipName": "hasDay",
                "$targetId": day_id_for[i],
                "index": i,
            },
            x_user_id=x_user_id,
        )
    return list(first_last) if first_last is not None else []


def update_section(trip_dtid: str, actor: dict, section_id: str, patch: SectionPatch) -> Trip:
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    section_ids = {
        r.get("$targetId") for r in graph.get("relationships", [])
        if r.get("$sourceId") == root["$dtId"] and r.get("$relationshipName") == "hasSection"
    }
    twin = _twin(graph, section_id)
    if twin is None or section_id not in section_ids or _model_kind(twin) != "TripSection":
        raise WriteError(404, "Section not found on this trip")

    ops = []
    if "title" in patch.model_fields_set:
        ops += _scalar_ops(twin, [("title", patch.title)])

    if "days" in patch.model_fields_set:
        days_prop = _sync_section_days(
            client, trip_dtid, graph, root, section_id, patch.days, actor["sub"]
        )
        ops += [{"op": "replace", "path": "/days", "value": days_prop}]

    if "locationRefs" in patch.model_fields_set:
        _sync_section_location_refs(
            client, trip_dtid, graph, section_id, patch.locationRefs or [], actor["sub"]
        )

    if ops:
        client.update_twin_props(trip_dtid, section_id, ops, x_user_id=actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def create_section(trip_dtid: str, actor: dict, payload: SectionCreate) -> Trip:
    """Create a new TripSection chapter over trip days (issue #89).

    The section twin gets a ``days`` property AND hasDay edges (kept in sync,
    matching the seed); locationRefs become atLocation edges. All edges are
    sourced at the section twin.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    section_id = _new_id()

    # Validate the payload against the CURRENT graph state BEFORE any writes,
    # so a 422 leaves the graph untouched (issue #172 — validate-then-write).
    day_ids = _trip_day_ids_by_index(graph, root["$dtId"])
    n_days = len(day_ids)
    days_prop: list[int] = []
    has_day_rows: list[tuple[str, str, int]] = []
    if payload.days is not None:
        first, last = _validate_section_days(payload.days, n_days)
        # Overlap guard against every existing section (the new one has none yet).
        for r in graph.get("relationships", []):
            if (r.get("$sourceId") == root["$dtId"]
                    and r.get("$relationshipName") == "hasSection"):
                other = _twin(graph, r.get("$targetId"))
                if other is None or _model_kind(other) != "TripSection":
                    continue
                covered = set(_section_day_indices(graph, r["$targetId"], day_ids))
                clash = sorted(set(range(first, last + 1)) & covered)
                if clash:
                    raise WriteError(
                        422,
                        f"Section days {payload.days} overlap '{other.get('title')}' "
                        f"(already covers day {clash[0]}) — sections must not share days",
                    )
        day_id_for = {i: tid for i, tid in enumerate(day_ids)}
        days_prop = [first, last]
        has_day_rows = [(section_id, day_id_for[i], i) for i in range(first, last + 1)]
    # locationRefs are validated up-front too (unknown location = 422, no write).
    location_names = payload.locationRefs or []
    _validate_location_refs_exist(graph, location_names)

    props: dict[str, Any] = {
        "$dtId": section_id,
        "$metadata": {"$model": SECTION_MODEL},
        "title": payload.title,
        "days": days_prop,
        "fold": [],
    }
    client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
    # hasSection edges carry `index` (chapter position) — the read path sorts
    # sections by it, defaulting a missing index to 0. Append = existing count.
    next_index = sum(
        1 for r in graph.get("relationships", [])
        if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasSection"
    )
    client.upsert_relationship(
        trip_dtid,
        {
            "$relationshipId": _rel_id(trip_dtid, "hasSection", section_id),
            "$sourceId": trip_dtid,
            "$relationshipName": "hasSection",
            "$targetId": section_id,
            "index": next_index,
        },
        x_user_id=actor["sub"],
    )

    # Write phase — validation already happened above, so these writes always
    # succeed on a valid payload (issue #172: validate-then-write atomicity).
    for section_day, day_tid, idx in has_day_rows:
        client.upsert_relationship(
            trip_dtid,
            {
                "$relationshipId": _rel_id(section_id, "hasDay", day_tid),
                "$sourceId": section_id,
                "$relationshipName": "hasDay",
                "$targetId": day_tid,
                "index": idx,
            },
            x_user_id=actor["sub"],
        )
    if days_prop:
        client.update_twin_props(
            trip_dtid, section_id,
            [{"op": "replace", "path": "/days", "value": days_prop}],
            x_user_id=actor["sub"],
        )

    if location_names:
        _sync_section_location_refs(
            client, trip_dtid, graph, section_id, location_names, actor["sub"]
        )

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


# ---------------------------------------------------------------- blocks
def _block_twin(graph: dict, block_id: str) -> dict:
    twin = _twin(graph, block_id)
    if twin is None or _model_kind(twin) != "Block":
        raise WriteError(404, "Block not found")
    return twin


def _container_twin(graph: dict, ref: ContainerRef, trip_dtid: str) -> dict:
    twin = _twin(graph, ref.id)
    if twin is None or _model_kind(twin) != ("Day" if ref.type == "day" else "TripSection"):
        raise WriteError(404, f"{ref.type} container not found")
    # Container must belong to this trip (reachable via root edges).
    root = _trip_twin(graph, trip_dtid)
    edges = {
        r.get("$targetId") for r in graph.get("relationships", [])
        if r.get("$sourceId") == root["$dtId"] and r.get("$relationshipName")
        in ("hasDay", "hasSection")
    }
    if ref.id not in edges:
        raise WriteError(404, f"{ref.type} container not found on this trip")
    return twin


def create_block(trip_dtid: str, actor: dict, payload: BlockCreate) -> Trip:
    _reject_media_urls(images=payload.images, items=payload.items, track=payload.track)
    if payload.track is not None:
        _validate_track(trip_dtid, payload.track)
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    _container_twin(graph, payload.container, trip_dtid)

    given = payload.model_dump(
        exclude_unset=True, by_alias=True, exclude={"kind", "container", "index", "items"}
    )
    _validate_block_kind_fields(
        payload.kind,
        set(given) | ({"items"} if "items" in payload.model_fields_set else set()),
    )
    fields = dict(given)
    if "items" in payload.model_fields_set:
        fields["items"] = _validate_items(payload.kind, payload.items or [])
    # `custom`-block HTML is sanitized once, at write (#196 phase B) — what is
    # stored is clean for every reader (bulk `fill` funnels through here too).
    if isinstance(fields.get("html"), str):
        fields["html"] = sanitize_custom_html(fields["html"])

    container_id = payload.container.id
    block_ids = _container_blocks(graph, container_id)
    insert_at = min(payload.index, len(block_ids)) if payload.index is not None else len(block_ids)

    block_id = _new_id()
    props: dict[str, Any] = {
        "$dtId": block_id,
        "$metadata": {"$model": BLOCK_MODEL},
        "kind": payload.kind,
        "order": insert_at,
    }
    for k, v in fields.items():
        if v is not None:
            props[k] = v
    client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
    client.upsert_relationship(
        trip_dtid,
        {
            "$relationshipId": _rel_id(container_id, "hasBlock", block_id),
            "$sourceId": container_id,
            "$relationshipName": "hasBlock",
            "$targetId": block_id,
        },
        x_user_id=actor["sub"],
    )
    # Insert at a position: shift the blocks after it up by one.
    if insert_at < len(block_ids):
        for i in range(insert_at, len(block_ids)):
            client.update_twin_props(
                trip_dtid, block_ids[i],
                [{"op": "replace", "path": "/order", "value": i + 1}],
                x_user_id=actor["sub"],
            )
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def update_block(trip_dtid: str, actor: dict, block_id: str, payload: BlockFields) -> Trip:
    _reject_media_urls(images=payload.images, items=payload.items, track=payload.track)
    if "track" in payload.model_fields_set and payload.track is not None:
        _validate_track(trip_dtid, payload.track)
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    twin = _block_twin(graph, block_id)
    kind = twin.get("kind")
    given = payload.model_dump(exclude_unset=True, by_alias=True, exclude={"items"})
    if "order" in given:
        raise WriteError(422, "'order' is managed by the server — use move/block-order")
    _validate_block_kind_fields(kind, set(given) | ({"items"} if "items" in payload.model_fields_set else set()))
    given = {
        k: (sanitize_custom_html(v) if k == "html" and isinstance(v, str) else v)
        for k, v in given.items()
    }
    ops = _scalar_ops(twin, [(k, v) for k, v in given.items()])
    if "items" in payload.model_fields_set:
        ops += [{
            "op": "replace" if "items" in twin else "add",
            "path": "/items",
            "value": _validate_items(kind, payload.items or []),
        }]
    if ops:
        client.update_twin_props(trip_dtid, block_id, ops, x_user_id=actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def delete_block(trip_dtid: str, actor: dict, block_id: str) -> Trip:
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    _block_twin(graph, block_id)
    container_id = None
    # The graph server does NOT cascade: a twin with edges refuses deletion
    # ("Cannot delete a vertex that has edge(s)"), so every edge touching the
    # block goes first — the incoming hasBlock (sourced at its container) and
    # any block-sourced edges (atLocation pins). FakeGraph cascades; the live
    # server does not (found by the #89 live smoke) — delete in the server's
    # order and the fake stays strict below.
    for r in graph.get("relationships", []):
        if r.get("$targetId") == block_id and r.get("$relationshipName") == "hasBlock":
            container_id = r.get("$sourceId")
            client.delete_relationship(
                r.get("$sourceId") or trip_dtid, r["$relationshipId"],
                x_user_id=actor["sub"],
            )
        elif r.get("$sourceId") == block_id:
            client.delete_relationship(
                block_id, r["$relationshipId"], x_user_id=actor["sub"]
            )
    client.delete_twin(trip_dtid, block_id, x_user_id=actor["sub"])
    if container_id:
        _renumber(client, trip_dtid, container_id, _container_blocks(
            _fetch(client, trip_dtid), container_id
        ), actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def move_block(trip_dtid: str, actor: dict, block_id: str, payload: BlockMove) -> Trip:
    """DESIGN §7.5 promote/demote + reposition: move a block between a day and
    a section (or within the same container) and renumber both containers."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    _block_twin(graph, block_id)
    target = _container_twin(graph, payload.container, trip_dtid)
    target_id = target["$dtId"]

    # Current container (source of the block's hasBlock edge). The edge id is
    # deterministic (<src>__hasBlock__<block>), so we derive it rather than
    # trust the fetched edge's $relationshipId.
    src_id = None
    for r in graph.get("relationships", []):
        if r.get("$relationshipName") == "hasBlock" and r.get("$targetId") == block_id:
            src_id = r.get("$sourceId")
            break
    if src_id is None:
        raise WriteError(404, "Block has no container edge")
    rel_id = _rel_id(src_id, "hasBlock", block_id)

    same_container = src_id == target_id
    if not same_container:
        # hasBlock edges are sourced at the CONTAINER (day/section), not the trip.
        client.delete_relationship(src_id, rel_id, x_user_id=actor["sub"])
        client.upsert_relationship(
            trip_dtid,
            {
                "$relationshipId": _rel_id(target_id, "hasBlock", block_id),
                "$sourceId": target_id,
                "$relationshipName": "hasBlock",
                "$targetId": block_id,
            },
            x_user_id=actor["sub"],
        )

    # Compute target order after the edge change. The block is already in the
    # target's edge list (kept edge or just moved), so exclude it and insert
    # at the requested position — never duplicate it.
    graph = _fetch(client, trip_dtid)
    target_blocks = [b for b in _container_blocks(graph, target_id) if b != block_id]
    insert_at = payload.index if payload.index is not None else len(target_blocks)
    insert_at = min(insert_at, len(target_blocks))
    target_blocks.insert(insert_at, block_id)
    _renumber(client, trip_dtid, target_id, target_blocks, actor["sub"])

    if not same_container:
        src_blocks = _container_blocks(_fetch(client, trip_dtid), src_id)
        _renumber(client, trip_dtid, src_id, src_blocks, actor["sub"])

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def order_blocks(trip_dtid: str, actor: dict, container: ContainerRef, body: BlockOrder) -> Trip:
    """Exact-set reorder of a container's blocks (order = list position)."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    target = _container_twin(graph, container, trip_dtid)
    current = _container_blocks(graph, target["$dtId"])
    if sorted(body.block_ids) != sorted(current):
        raise WriteError(422, "block_ids must be exactly the container's blocks")
    _renumber(client, trip_dtid, target["$dtId"], body.block_ids, actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def order_container_blocks(trip_dtid: str, actor: dict, container_id: str, body: BlockOrder) -> Trip:
    """Reorder endpoint variant: the container type is resolved server-side
    (day or section) from its membership of the trip's edges — the opaque id
    alone does not say which."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    kind = None
    for r in graph.get("relationships", []):
        if r.get("$targetId") == container_id and r.get("$sourceId") == root["$dtId"]:
            if r.get("$relationshipName") == "hasDay":
                kind = "day"
                break
            if r.get("$relationshipName") == "hasSection":
                kind = "section"
                break
    if kind is None:
        raise WriteError(404, "Container not found on this trip")
    return order_blocks(trip_dtid, actor, ContainerRef(type=kind, id=container_id), body)


# ---------------------------------------------------------------- crew
def _crew_member(graph: dict, trip_dtid: str, person_id: str) -> tuple[dict, dict]:
    """(person twin, hasCrew edge) for a crew member of this trip."""
    twin = _twin(graph, person_id)
    if twin is None or _model_kind(twin) not in ("Person", "User"):
        raise WriteError(404, "Crew member not found")
    edge = next(
        (r for r in graph.get("relationships", [])
         if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
         and r.get("$targetId") == person_id),
        None,
    )
    if edge is None:
        raise WriteError(404, "Crew member not found on this trip")
    return twin, edge


def patch_crew(trip_dtid: str, actor: dict, person_id: str, patch: CrewPatch) -> Trip:
    """Role/note ride the hasCrew edge (#80); contact rides the Person twin."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    twin, edge = _crew_member(graph, trip_dtid, person_id)

    if "role" in patch.model_fields_set and patch.role != edge.get("role"):
        if actor["role"] != "owner":
            raise WriteError(403, "Only the trip owner can change crew roles")
        client.update_relationship_props(
            edge.get("$sourceId") or trip_dtid, edge["$relationshipId"],
            [{"op": "replace", "path": "/role", "value": patch.role}],
            x_user_id=actor["sub"],
        )
    if "note" in patch.model_fields_set:
        note = patch.note
        ops = []
        if note is None:
            if "note" in edge:
                ops.append({"op": "remove", "path": "/note"})
        else:
            ops.append({
                "op": "replace" if "note" in edge else "add",
                "path": "/note",
                "value": note,
            })
        if ops:
            client.update_relationship_props(
                edge.get("$sourceId") or trip_dtid, edge["$relationshipId"], ops,
                x_user_id=actor["sub"],
            )
    if "contact" in patch.model_fields_set:
        client.update_twin_props(
            trip_dtid, person_id,
            _scalar_ops(twin, [("contact", patch.contact)]), x_user_id=actor["sub"],
        )

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def _crew_edges(graph: dict, trip_dtid: str) -> list[dict]:
    """Every ``hasCrew`` edge of this trip (in graph order)."""
    return [
        r for r in graph.get("relationships", [])
        if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
    ]


def _crew_names(graph: dict, trip_dtid: str) -> set[str]:
    """The names this trip's crew RENDERS as — the edge's ``displayName``
    (#196) with the twin's own name as the fallback, exactly as the read path
    resolves it. Two crew members must never render the same label, so both
    add paths refuse a duplicate here (not against raw twin names, which are
    not what the Crew page shows)."""
    out: set[str] = set()
    for r in _crew_edges(graph, trip_dtid):
        twin = _twin(graph, r.get("$targetId") or "")
        if twin is None:
            continue
        name = crew_edge_name(r) or twin.get("displayName") or twin.get("name")
        if isinstance(name, str) and name:
            out.add(name)
    return out


def _next_crew_index(graph: dict, trip_dtid: str) -> int:
    """Display order for a new crew edge: max+1, never a count (an edge PATCH
    reorders storage, so a count could collide)."""
    used: list[int] = []
    for r in _crew_edges(graph, trip_dtid):
        index = r.get("index")
        if isinstance(index, int):
            used.append(index)
    return max(used) + 1 if used else 0


def _person_crew_edges(client, person_id: str) -> list[dict]:
    """Every trip a placeholder Person is crew on (#322).

    A placeholder is a shared twin: one Person, one ``hasCrew`` edge per trip.
    The trip-scoped bundle cannot answer "who else crews them" — the sibling
    trip is outside this trip's closure — so this is a graph read. Returns an
    empty list when the client cannot answer, which callers read as "no other
    trip" (the pre-#322 world, where a placeholder belonged to one trip).
    """
    getter = getattr(client, "crew_edges_for_person", None)
    if not callable(getter):
        return []
    edges = getter(person_id)
    return [e for e in edges if isinstance(e, dict)] if isinstance(edges, list) else []


def _owner_placeholders(client, user_dtid: str) -> list[dict]:
    """Unclaimed placeholders on the trips ``user_dtid`` OWNS (#322).

    Both the reuse picker and its authorization gate (see ``add_crew``): the
    caller sees exactly the placeholders they are allowed to link. Empty list
    when the client cannot answer — reuse then refuses rather than guessing.
    """
    getter = getattr(client, "placeholders_for_owner", None)
    if not callable(getter):
        return []
    rows = getter(user_dtid)
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def add_crew(trip_dtid: str, actor: dict, body: CrewAdd) -> Trip:
    """Add a crew member: an unclaimed placeholder, an existing account, or an
    existing placeholder reused across trips.

    ``sub`` absent (#6): a Person twin + hasCrew edge they claim later through
    the invite — it grants nobody access until then, so editor+ may add one.

    ``sub`` present (#198 follow-up): the crew entry attaches to that
    account's ``User`` twin, i.e. they are crew the moment the edge lands. That
    is access granted outright — the same thing the owner hands out when they
    share the join link — so it is OWNER-only, and only for an account the
    caller already FOLLOWS: the follow graph is the picker's source, so no
    arbitrary ``sub`` can be attached to a trip.

    ``personId`` present (#322): the SAME action, one step earlier in the
    lifecycle — the entry attaches to a placeholder that is already crew on
    another trip the caller owns, so the invitee claims ONE identity and the
    claim cascade lands them on every linked trip. OWNER-only on this trip AND
    the placeholder must sit on a trip the caller owns (``placeholders_for_owner``
    is both the picker and the gate): linking two trips' crew means a claim
    through either grants both, which is the owner's call on both sides.
    Deliberately explicit and id-based — never name-matched, because a name is
    a label two different people can share, and a wrong merge would hand a
    stranger the other trip.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)

    if body.role == "owner" and actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can grant the owner role")

    if body.sub and body.personId:
        raise WriteError(422, "`sub` and `personId` are mutually exclusive")

    if body.sub:
        if actor["role"] != "owner":
            raise WriteError(
                403, "Only the trip owner can add an existing account to the crew"
            )
        if body.contact:
            raise WriteError(
                422,
                "`contact` is not accepted with `sub` — that account's contact "
                "belongs to their own profile, and this trip never edits someone "
                "else's identity",
            )
        if not client.user_twin_exists(body.sub):
            raise WriteError(404, "Unknown user")
        if body.sub not in client.following_of(actor["sub"]):
            raise WriteError(403, "You can only add people you follow")
        if any(r.get("$targetId") == body.sub for r in _crew_edges(graph, trip_dtid)):
            raise WriteError(409, f"{body.name!r} is already on this trip's crew")

    if body.personId:
        if actor["role"] != "owner":
            raise WriteError(
                403, "Only the trip owner can link a placeholder from another trip"
            )
        if body.contact:
            raise WriteError(
                422,
                "`contact` is not accepted with `personId` — that placeholder is "
                "shared across trips, so its contact is not this trip's to edit",
            )
        if any(r.get("$targetId") == body.personId for r in _crew_edges(graph, trip_dtid)):
            raise WriteError(409, f"{body.name!r} is already on this trip's crew")
        owner_placeholders = [
            p for p in _owner_placeholders(client, actor["sub"])
            # Only an UNCLAIMED placeholder travels this path: a claimed twin is
            # a real account and goes through `sub`'s follow-gated route.
            if p.get("personModel") == PERSON_MODEL
        ]
        match = next(
            (p for p in owner_placeholders if p.get("personId") == body.personId),
            None,
        )
        if match is None:
            # 404 when nothing on the caller's OWN trips matches: the id is
            # either unknown to them or not theirs to reuse. Never widened to a
            # probe of other people's trips.
            raise WriteError(404, "Unknown placeholder on your trips")

    if body.name in _crew_names(graph, trip_dtid):
        raise WriteError(409, f"{body.name!r} is already on this trip's crew")

    person_id = body.sub or body.personId or _new_id()
    if not body.sub and not body.personId:
        # Placeholder identity — the account (if any) is created at claim time.
        props: dict[str, Any] = {
            "$dtId": person_id,
            "$metadata": {"$model": PERSON_MODEL},
            "name": body.name,
        }
        if body.contact:
            props["contact"] = body.contact
        client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
    # A reused placeholder (#322) is NOT re-upserted: its twin (and its name and
    # contact) is shared with the trips that already crew it, so this trip only
    # adds its own edge. The trip-relative label rides that edge's displayName
    # below, which is exactly why one twin can be "Nick" on one trip and
    # "Nicholas" on another.

    rel: dict[str, Any] = {
        "$relationshipId": _rel_id(trip_dtid, "hasCrew", person_id),
        "$sourceId": trip_dtid,
        "$relationshipName": "hasCrew",
        "$targetId": person_id,
        "role": body.role,
        "index": _next_crew_index(graph, trip_dtid),
        # The crew's OWN name for this trip rides the edge (#196) — the read
        # path renders Person.name from here, so a later claim (which swaps
        # the twin to the account's User) never renames the crew member.
        "displayName": body.name,
    }
    if body.note:
        rel["note"] = body.note
    client.upsert_relationship(trip_dtid, rel, x_user_id=actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def reusable_placeholders(trip_dtid: str, actor: dict) -> dict:
    """Placeholders the caller can LINK into this trip (#322).

    Owner-only. The list is exactly what ``add_crew`` with ``personId``
    accepts — placeholders already crew on another trip the caller OWNS, minus
    anyone already on this crew — so the picker and the write gate cannot drift
    apart: both read ``_owner_placeholders``.

    Grouped per person (a placeholder on three trips is ONE entry listing the
    three), with the other trips' titles so the picker can label the choice
    ("Nick — also on Canada 2027") instead of offering a bare name that looks
    like a duplicate of whatever the owner just typed.
    """
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can link a placeholder from another trip")
    client = _client()
    graph = _fetch(client, trip_dtid)
    _trip_twin(graph, trip_dtid)  # presence check (404 when unknown)

    on_this_crew = {
        str(r.get("$targetId")) for r in _crew_edges(graph, trip_dtid)
    }
    grouped: dict[str, dict] = {}
    for row in _owner_placeholders(client, actor["sub"]):
        if row.get("personModel") != PERSON_MODEL:
            continue  # a claimed account rides the `sub` path, not this one
        if row.get("tripId") == trip_dtid:
            continue  # already on THIS trip's crew — nothing to offer
        person_id = str(row.get("personId") or "")
        if not person_id or person_id in on_this_crew:
            continue
        entry = grouped.setdefault(person_id, {
            "personId": person_id,
            "name": (row.get("displayName") or row.get("name") or ""),
            "trips": [],
        })
        if not entry["name"]:
            entry["name"] = row.get("displayName") or row.get("name") or ""
        if row.get("tripId") not in {t["id"] for t in entry["trips"]}:
            entry["trips"].append({
                "id": row.get("tripId"),
                "title": row.get("tripTitle") or "",
                "role": row.get("role") or "viewer",
            })
    placeholders = sorted(
        grouped.values(), key=lambda p: (str(p["name"]).lower(), p["personId"])
    )
    return {"placeholders": placeholders}


def remove_crew(trip_dtid: str, actor: dict, person_id: str) -> Trip:
    """Owner-only: remove a crew member. Placeholder Person twins are deleted
    when this trip held their last crew edge; a placeholder still crewing
    ANOTHER trip survives (#322, one Person serves every trip that added them),
    and a claimed User twin always survives — only the crew edge goes."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    twin, edge = _crew_member(graph, trip_dtid, person_id)
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can remove crew")
    client.delete_relationship(
        edge.get("$sourceId") or trip_dtid, edge["$relationshipId"], x_user_id=actor["sub"]
    )
    if _model_kind(twin) == "Person":
        others = [
            e for e in _person_crew_edges(client, person_id)
            if e.get("tripId") != trip_dtid
        ]
        if not others:
            client.delete_twin(trip_dtid, person_id, x_user_id=actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


# ---------------------------------------------------------------- locations
def put_locations(trip_dtid: str, actor: dict, body: LocationsPut) -> Trip:
    """Full-array replace of the trip's location registry (marker order = list
    position). Diff by name: kept locations are patched, gone ones deleted,
    new ones created, root atLocation edges rebuilt with index = position.
    Explicit-clear: a present ``null`` (or ``[]``) clears that field on a kept
    location; absent fields keep their stored value."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)

    entries = body.locations
    names = [e.name for e in entries]
    if len(names) != len(set(names)):
        raise WriteError(422, "Location names must be unique")

    locations = {
        t.get("name"): t for t in graph.get("twins", []) if _model_kind(t) == "Location"
    }
    root_at = [
        r for r in graph.get("relationships", [])
        if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "atLocation"
    ]
    old_by_name = {locations[r.get("$targetId")]["name"]: r.get("$targetId")
                   for r in root_at if r.get("$targetId") in locations}

    # Deletes: old locations no longer in the list. The graph server does not
    # cascade twin deletes, and every fetched root atLocation edge is replaced
    # below anyway — so drop ALL of the old root edges first, then delete the
    # removed Location twins edge-free (same no-cascade rule as delete_block,
    # issue #89 smoke), then re-upsert the new edge set at the end.
    keep_names = set(names)
    for r in root_at:
        if r.get("$relationshipId"):
            client.delete_relationship(
                r.get("$sourceId") or trip_dtid, r["$relationshipId"],
                x_user_id=actor["sub"],
            )
    for name, lid in old_by_name.items():
        if name not in keep_names:
            client.delete_twin(trip_dtid, lid, x_user_id=actor["sub"])
            locations.pop(name, None)

    # Upserts (new) + patches (existing).
    current_ids: dict[str, str] = {}  # name -> Location $dtId
    for entry in entries:
        twin = locations.get(entry.name)
        if twin is None:
            lid = _new_id()
            props: dict[str, Any] = {
                "$dtId": lid,
                "$metadata": {"$model": LOCATION_MODEL},
                "name": entry.name,
            }
            for prop, value in _location_pairs(entry):
                if value is not None:
                    props[prop] = value
            client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
            current_ids[entry.name] = lid
        else:
            lid = twin["$dtId"]
            current_ids[entry.name] = lid
            ops = _scalar_ops(twin, _location_pairs(entry))
            if ops:
                client.update_twin_props(trip_dtid, lid, ops, x_user_id=actor["sub"])

    # (Re)create the root atLocation edges: index = position (marker order).
    # The old edge set was deleted above (before the Location twin deletes).
    for i, entry in enumerate(entries):
        lid = current_ids[entry.name]
        client.upsert_relationship(
            trip_dtid,
            {
                "$relationshipId": _rel_id(trip_dtid, "atLocation", lid),
                "$sourceId": trip_dtid,
                "$relationshipName": "atLocation",
                "$targetId": lid,
                "index": i,
            },
            x_user_id=actor["sub"],
        )

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


# Location twin props the incremental PATCH may touch — the full registry
# field set (same as PUT): coordinates, display keys, durable place metadata
# (#15/#95) and the short-lived rating. Anything else is not a Location prop.
_LOCATION_PATCH_PROPS = _LOCATION_PROPS


def _location_upsert_pairs(entry: LocationUpsert) -> list[tuple[str, Any]]:
    """(prop, value) pairs to patch for one upsert entry.

    Only fields PRESENT in the payload are returned (exclude_unset
    semantics); absent fields keep their stored value. A present ``null``
    emits ``(prop, None)`` so ``_scalar_ops`` removes the prop from the
    twin; a present list — including ``[]`` — is written verbatim.
    """
    pairs = []
    for prop in _LOCATION_PATCH_PROPS:
        if prop not in entry.model_fields_set:
            continue
        value = getattr(entry, prop)
        pairs.append((prop, list(value) if isinstance(value, list) else value))
    return pairs


def patch_locations(trip_dtid: str, actor: dict, body: LocationsPatch) -> Trip:
    """Named upserts only — the safe incremental complement to put_locations.

    Each entry matches by ``id`` when supplied, otherwise by ``name``. Only
    the supplied fields are patched; locations not mentioned are untouched
    (no deletes, no edge rebuild — marker order of existing locations never
    moves). New names are appended to the registry in payload order.
    Duplicate names (or duplicate ids) in the payload are a 409; an
    unknown ``id`` is a 404; renaming onto another location's name is a 409.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)

    entries = body.locations
    names = [e.name for e in entries]
    if len(names) != len(set(names)):
        raise WriteError(409, "Location names must be unique")
    given_ids = [e.id for e in entries if e.id is not None]
    if len(given_ids) != len(set(given_ids)):
        raise WriteError(409, "Location ids must be unique")

    by_id = {
        t["$dtId"]: t for t in graph.get("twins", []) if _model_kind(t) == "Location"
    }
    by_name = {t.get("name"): t for t in by_id.values()}
    root_at = [
        r for r in graph.get("relationships", [])
        if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "atLocation"
    ]
    used = [r.get("index") for r in root_at if isinstance(r.get("index"), int)]
    next_index = (max(used) + 1) if used else 0

    for entry in entries:
        if entry.id is not None:
            twin = by_id.get(entry.id)
            if twin is None:
                raise WriteError(404, f"Unknown location id {entry.id!r}")
            if entry.name != twin.get("name") and entry.name in by_name:
                raise WriteError(409, f"{entry.name!r} is already a location on this trip")
            ops = _scalar_ops(twin, [("name", entry.name)] if entry.name != twin.get("name") else [])
            ops += _scalar_ops(twin, _location_upsert_pairs(entry))
            if ops:
                client.update_twin_props(trip_dtid, twin["$dtId"], ops, x_user_id=actor["sub"])
            old_name = twin.get("name")
            if entry.name != old_name:
                del by_name[old_name]
                by_name[entry.name] = twin
        else:
            twin = by_name.get(entry.name)
            if twin is None:
                lid = _new_id()
                props: dict[str, Any] = {
                    "$dtId": lid,
                    "$metadata": {"$model": LOCATION_MODEL},
                    "name": entry.name,
                }
                for prop, value in _location_upsert_pairs(entry):
                    if value is not None:
                        props[prop] = value
                client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
                client.upsert_relationship(
                    trip_dtid,
                    {
                        "$relationshipId": _rel_id(trip_dtid, "atLocation", lid),
                        "$sourceId": trip_dtid,
                        "$relationshipName": "atLocation",
                        "$targetId": lid,
                        "index": next_index,
                    },
                    x_user_id=actor["sub"],
                )
                next_index += 1
                # Keep the in-memory maps in sync so a later entry in the
                # same payload matching this name patches instead of re-creating.
                # (Duplicate payload names are a 409 above, so this only
                # matters for id-matched renames onto a just-created name.)
                by_name[entry.name] = {"$dtId": lid, "name": entry.name}
                by_id[lid] = by_name[entry.name]
            else:
                ops = _scalar_ops(twin, _location_upsert_pairs(entry))
                if ops:
                    client.update_twin_props(trip_dtid, twin["$dtId"], ops, x_user_id=actor["sub"])

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


# ---------------------------------------------------------------- features
# Feature twin props managed by put_features/patch_features (issue #178).
# `title` is written on create + rename only (it is the match key); the rest
# follow the explicit-clear contract. `id` maps to $dtId, never a property.
_FEATURE_PROPS = (
    "kicker", "description", "image", "images", "chips", "cards", "map", "links",
)


def _feature_pairs(entry: FeatureWrite, *, include_title: bool) -> list[tuple[str, Any]]:
    """(prop, value) pairs to write for one feature entry.

    Explicit-clear contract (``model_fields_set``): absent fields are left
    untouched; a present ``null`` emits ``(prop, None)`` so ``_scalar_ops``
    removes the prop from the twin; a present list — including ``[]`` — is
    written verbatim. Nested cards/links serialize as plain dicts (the twin
    stores object arrays; the read path re-validates into the model).
    """
    pairs: list[tuple[str, Any]] = []
    if include_title:
        pairs.append(("title", entry.title))
    for prop in _FEATURE_PROPS:
        if prop not in entry.model_fields_set:
            continue
        value = getattr(entry, prop)
        if value is None:
            pairs.append((prop, None))
        elif prop in ("cards", "links"):
            pairs.append((prop, [
                (c.model_dump(exclude_none=True, by_alias=True)
                 if not isinstance(c, dict) else c)
                for c in value
            ]))
        else:
            pairs.append((prop, value))
    return pairs


def _feature_features(graph: dict) -> dict[str, dict]:
    """Feature twins keyed by $dtId."""
    return {
        t["$dtId"]: t for t in graph.get("twins", [])
        if _model_kind(t) == "Feature"
    }


def _has_feature_edges(graph: dict, trip_dtid: str) -> list[dict]:
    return [
        r for r in graph.get("relationships", [])
        if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasFeature"
    ]


def put_features(trip_dtid: str, actor: dict, body: FeaturesPut) -> Trip:
    """Full-array replace of the trip's editorial overview cards (issue #178).

    Diff by title: kept features are patched, gone ones deleted, new ones
    created; the hasFeature edge set is rebuilt with ``index`` = list position
    (card order). Deleting a removed Feature twin requires its edges gone
    first — the graph server refuses a non-cascade twin delete (#89 rule) —
    so ALL old edges are dropped before the twin deletes, then the new edge
    set is upserted (the same order put_locations established).
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)

    entries = body.features
    titles = [e.title for e in entries]
    if len(titles) != len(set(titles)):
        raise WriteError(422, "Feature titles must be unique")
    _reject_feature_media(entries)

    features = _feature_features(graph)
    old_edges = _has_feature_edges(graph, trip_dtid)
    keep_titles = set(titles)
    # Survivors: explicit ids AND twins currently holding a payload title —
    # an id-matched entry that RENAMES its feature keeps the twin even though
    # its old title is gone from the payload.
    survivor_ids = {e.id for e in entries if e.id is not None} | {
        f["$dtId"] for f in features.values() if f.get("title") in keep_titles
    }

    # Deletes: old features no longer in the list. Drop every old edge first
    # (they are replaced below anyway), then the removed twins are edge-free.
    for r in old_edges:
        if r.get("$relationshipId"):
            client.delete_relationship(
                r.get("$sourceId") or trip_dtid, r["$relationshipId"],
                x_user_id=actor["sub"],
            )
    for r in old_edges:
        fid = r.get("$targetId")
        if not isinstance(fid, str):
            continue
        if fid not in survivor_ids and fid in features:
            client.delete_twin(trip_dtid, fid, x_user_id=actor["sub"])
            features.pop(fid, None)

    # Upserts (new) + patches (existing) in payload order.
    current_ids: list[str] = []
    for entry in entries:
        matched = next(
            (f for f in features.values() if f.get("title") == entry.title), None
        )
        if entry.id is not None:
            twin = features.get(entry.id)
            if twin is None:
                raise WriteError(404, f"Unknown feature id {entry.id!r}")
            if entry.title != twin.get("title") and matched is not None:
                raise WriteError(409, f"{entry.title!r} is already a feature on this trip")
        else:
            twin = matched
        if twin is None:
            fid = _new_id()
            props: dict[str, Any] = {
                "$dtId": fid,
                "$metadata": {"$model": FEATURE_MODEL},
                "title": entry.title,
            }
            for prop, value in _feature_pairs(entry, include_title=False):
                if value is not None:
                    props[prop] = value
            client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
            twin = {"$dtId": fid, "title": entry.title}
            features[fid] = twin
        else:
            fid = twin["$dtId"]
            ops = _scalar_ops(twin, _feature_pairs(entry, include_title=(
                entry.title != twin.get("title")
            )))
            if ops:
                client.update_twin_props(trip_dtid, fid, ops, x_user_id=actor["sub"])
            twin["title"] = entry.title
        current_ids.append(fid)

    # (Re)create the hasFeature edges: index = position (card order).
    for i, fid in enumerate(current_ids):
        client.upsert_relationship(
            trip_dtid,
            {
                "$relationshipId": _rel_id(trip_dtid, "hasFeature", fid),
                "$sourceId": trip_dtid,
                "$relationshipName": "hasFeature",
                "$targetId": fid,
                "index": i,
            },
            x_user_id=actor["sub"],
        )

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def patch_features(trip_dtid: str, actor: dict, body: FeaturesPatch) -> Trip:
    """Incremental feature edits — the safe complement to put_features (#178).

    Each entry matches by ``id`` when supplied, otherwise by ``title``. Only
    the supplied fields are patched; features not mentioned are untouched (no
    deletes, no edge rebuild — card order of existing features never moves).
    New titles are appended (edge index = current count). Duplicate titles
    (or ids) in the payload are a 409; an unknown ``id`` is a 404; retitling
    onto another feature's title is a 409.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)

    entries = body.features
    titles = [e.title for e in entries]
    if len(titles) != len(set(titles)):
        raise WriteError(409, "Feature titles must be unique")
    _reject_feature_media(entries)
    given_ids = [e.id for e in entries if e.id is not None]
    if len(given_ids) != len(set(given_ids)):
        raise WriteError(409, "Feature ids must be unique")

    by_id = _feature_features(graph)
    by_title = {t.get("title"): t for t in by_id.values()}
    used = [
        r["index"] for r in _has_feature_edges(graph, trip_dtid)
        if isinstance(r.get("index"), int)
    ]
    next_index = (max(used) + 1) if used else 0

    for entry in entries:
        if entry.id is not None:
            twin = by_id.get(entry.id)
            if twin is None:
                raise WriteError(404, f"Unknown feature id {entry.id!r}")
            if entry.title != twin.get("title") and entry.title in by_title \
                    and by_title[entry.title] is not twin:
                raise WriteError(409, f"{entry.title!r} is already a feature on this trip")
            ops = _scalar_ops(twin, [("title", entry.title)]
                              if entry.title != twin.get("title") else [])
            ops += _scalar_ops(twin, _feature_pairs(entry, include_title=False))
            if ops:
                client.update_twin_props(trip_dtid, twin["$dtId"], ops, x_user_id=actor["sub"])
            old_title = twin.get("title")
            if entry.title != old_title:
                del by_title[old_title]
                by_title[entry.title] = twin
        else:
            twin = by_title.get(entry.title)
            if twin is None:
                fid = _new_id()
                props: dict[str, Any] = {
                    "$dtId": fid,
                    "$metadata": {"$model": FEATURE_MODEL},
                    "title": entry.title,
                }
                for prop, value in _feature_pairs(entry, include_title=False):
                    if value is not None:
                        props[prop] = value
                client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
                client.upsert_relationship(
                    trip_dtid,
                    {
                        "$relationshipId": _rel_id(trip_dtid, "hasFeature", fid),
                        "$sourceId": trip_dtid,
                        "$relationshipName": "hasFeature",
                        "$targetId": fid,
                        "index": next_index,
                    },
                    x_user_id=actor["sub"],
                )
                next_index += 1
                # Keep the in-memory maps in sync so a later entry in the same
                # payload matching this title patches instead of re-creating
                # (duplicate payload titles are a 409 above; an id-matched
                # retitle onto a just-created title is the only path here).
                by_title[entry.title] = {"$dtId": fid, "title": entry.title}
                by_id[fid] = by_title[entry.title]
            else:
                ops = _scalar_ops(twin, _feature_pairs(entry, include_title=False))
                if ops:
                    client.update_twin_props(trip_dtid, twin["$dtId"], ops, x_user_id=actor["sub"])

    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)
