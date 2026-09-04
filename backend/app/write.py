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
import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .graph.client import GraphWriteError, _invalidate_graph_cache
from .graph.convert import graph_to_trip
from .models import (
    BlockKind,
    BlockStatus,
    Contact,
    Link,
    Practical,
    Role,
    Stage,
    Theme,
    TodoItem,
    Trip,
    Visibility,
)
from .store import get_graph_client

# DTMI of the interfaces this service creates/patches (client.py exports the
# trip/user/person ones; the rest are needed verbatim here).
BLOCK_MODEL = "dtmi:kiseki:travel:Block;1"
LOCATION_MODEL = "dtmi:kiseki:travel:Location;1"
PERSON_MODEL = "dtmi:kiseki:travel:Person;1"

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


class PracticalPut(_Strict):
    """Whole-object replace of the trip's practical value object."""

    todos: list[TodoItem] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)
    notes: Optional[str] = None
    contacts: list[Contact] = Field(default_factory=list)


class TodoToggle(_Strict):
    done: bool


class TodoAdd(_Strict):
    label: str
    done: bool = False
    when: Optional[str] = None
    links: list[Link] = Field(default_factory=list)


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
    mapsQuery: Optional[str] = None
    images: Optional[list[str]] = None


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


class SectionPatch(_Strict):
    title: Optional[str] = None
    locationRefs: Optional[list[str]] = None


class CrewPatch(_Strict):
    role: Optional[Role] = None
    note: Optional[str] = None
    contact: Optional[str] = None


class CrewAdd(_Strict):
    name: str = Field(min_length=1)
    role: Role = "viewer"
    note: Optional[str] = None
    contact: Optional[str] = None


class LocationWrite(_Strict):
    id: Optional[str] = None
    name: str = Field(min_length=1)
    marker: Optional[int] = None
    alias: list[str] = Field(default_factory=list)
    lat: Optional[float] = None
    lng: Optional[float] = None


class LocationsPut(_Strict):
    locations: list[LocationWrite]


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
    # gallery: bare media filenames (or full URLs kept verbatim)
    if not all(isinstance(x, str) for x in items):
        raise WriteError(422, "gallery items must be media filenames/URLs")
    return list(items)


def _validate_iso_date(value: Optional[str], what: str) -> None:
    if value is None:
        return
    try:
        _dt.date.fromisoformat(value)
    except ValueError as exc:
        raise WriteError(422, f"{what} must be ISO YYYY-MM-DD, got {value!r}") from exc


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
    ops: list[dict] = []
    cur = existing.get("theme") if isinstance(existing.get("theme"), dict) else {}
    for prop in ("primary", "accent", "font"):
        value = getattr(theme, prop)
        if value is None:
            continue  # partial theme: absent keys untouched
        ops.append({
            "op": "replace" if isinstance(cur, dict) and prop in cur else "add",
            "path": f"/theme/{prop}",
            "value": value,
        })
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


def _rebuild(client, trip_dtid: str, graph: dict | None = None) -> Trip:
    """Return the canonical Trip document (fresh read after the write)."""
    if graph is None:
        _invalidate_graph_cache(trip_dtid=trip_dtid)
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            raise WriteError(503, "Trip could not be re-read after write")
    return graph_to_trip(graph)


def _trip_of(graph: dict) -> Trip:
    return graph_to_trip(graph)


# ---------------------------------------------------------------- trip level
def update_trip(trip_dtid: str, actor: dict, patch: TripPatch) -> Trip:
    """Trip scalar edits + stage machine + owner-only visibility.

    Actor role gates are enforced HERE (not just by the route), so the service
    is safe to call from anywhere: visibility + stage transitions per the
    approved rules; ``claimToken`` is not in the payload model at all.
    """
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    trip = _trip_of(graph)
    ops: list[dict] = []

    fields = patch.model_dump(exclude_unset=True, exclude={"theme", "visibility", "stage"})
    for prop in ("title", "subtitle", "summary", "cover", "coverCredit", "map"):
        if prop in fields:
            ops += _scalar_ops(trip_twin, [(prop, fields[prop])])
    for prop in ("startDate", "endDate"):
        if prop in fields:
            _validate_iso_date(fields[prop], prop)
            ops += _scalar_ops(trip_twin, [(prop, fields[prop])])
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

    ops += _scalar_ops(trip_twin, [("updated", _today())])
    if ops:
        client.update_twin_props(trip_dtid, trip_dtid, ops, x_user_id=actor["sub"])
    return _rebuild(client, trip_dtid)


# ---------------------------------------------------------------- practical
def put_practical(trip_dtid: str, actor: dict, body: PracticalPut) -> Trip:
    client = _client()
    graph = _fetch(client, trip_dtid)
    trip_twin = _trip_twin(graph, trip_dtid)
    value = Practical.model_validate(body.model_dump()).model_dump(exclude_none=True)
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


# ---------------------------------------------------------------- days
def update_day(trip_dtid: str, actor: dict, day_id: str, patch: DayPatch) -> Trip:
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


# ---------------------------------------------------------------- sections
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

    if "locationRefs" in patch.model_fields_set:
        names = patch.locationRefs or []
        # Every referenced place must exist in the trip's location registry.
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
            client.delete_relationship(
                trip_dtid, _rel_id(section_id, "atLocation", target), x_user_id=actor["sub"]
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
                    x_user_id=actor["sub"],
                )

    if ops:
        client.update_twin_props(trip_dtid, section_id, ops, x_user_id=actor["sub"])
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
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    twin = _block_twin(graph, block_id)
    kind = twin.get("kind")
    given = payload.model_dump(exclude_unset=True, by_alias=True, exclude={"items"})
    if "order" in given:
        raise WriteError(422, "'order' is managed by the server — use move/block-order")
    _validate_block_kind_fields(kind, set(given) | ({"items"} if "items" in payload.model_fields_set else set()))
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
    for r in graph.get("relationships", []):
        if r.get("$relationshipName") == "hasBlock" and r.get("$targetId") == block_id:
            container_id = r.get("$sourceId")
            break
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
        client.delete_relationship(trip_dtid, rel_id, x_user_id=actor["sub"])
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
            trip_dtid, edge["$relationshipId"],
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
                trip_dtid, edge["$relationshipId"], ops, x_user_id=actor["sub"]
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


def add_crew(trip_dtid: str, actor: dict, body: CrewAdd) -> Trip:
    """Add an unclaimed placeholder Person + hasCrew edge (they claim later, #6)."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)

    if body.role == "owner" and actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can grant the owner role")
    existing_names = {
        t.get("name") for t in graph.get("twins", [])
        if (r := next((
            r for r in graph.get("relationships", [])
            if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
            and r.get("$targetId") == t.get("$dtId")
        ), None)) is not None
    }
    if body.name in existing_names:
        raise WriteError(409, f"{body.name!r} is already on this trip's crew")

    person_id = _new_id()
    props: dict[str, Any] = {
        "$dtId": person_id,
        "$metadata": {"$model": PERSON_MODEL},
        "name": body.name,
    }
    if body.contact:
        props["contact"] = body.contact
    client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])

    used = [
        r.get("index") for r in graph.get("relationships", [])
        if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
        and isinstance(r.get("index"), int)
    ]
    index = max(used) + 1 if used else 0
    rel: dict[str, Any] = {
        "$relationshipId": _rel_id(trip_dtid, "hasCrew", person_id),
        "$sourceId": trip_dtid,
        "$relationshipName": "hasCrew",
        "$targetId": person_id,
        "role": body.role,
        "index": index,
    }
    if body.note:
        rel["note"] = body.note
    client.upsert_relationship(trip_dtid, rel, x_user_id=actor["sub"])
    client.update_twin_props(
        trip_dtid, trip_dtid,
        _scalar_ops(root, [("updated", _today())]), x_user_id=actor["sub"],
    )
    return _rebuild(client, trip_dtid)


def remove_crew(trip_dtid: str, actor: dict, person_id: str) -> Trip:
    """Owner-only: remove a crew member. Placeholder Person twins are deleted;
    claimed User twins keep their identity, only the hasCrew edge goes."""
    client = _client()
    graph = _fetch(client, trip_dtid)
    root = _trip_twin(graph, trip_dtid)
    twin, edge = _crew_member(graph, trip_dtid, person_id)
    if actor["role"] != "owner":
        raise WriteError(403, "Only the trip owner can remove crew")
    client.delete_relationship(trip_dtid, edge["$relationshipId"], x_user_id=actor["sub"])
    if _model_kind(twin) == "Person":
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
    new ones created, root atLocation edges rebuilt with index = position."""
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

    # Deletes: old locations no longer in the list.
    keep_names = set(names)
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
            if entry.marker is not None:
                props["marker"] = entry.marker
            if entry.alias:
                props["alias"] = list(entry.alias)
            if entry.lat is not None:
                props["lat"] = entry.lat
            if entry.lng is not None:
                props["lng"] = entry.lng
            client.upsert_twin(trip_dtid, props, x_user_id=actor["sub"])
            current_ids[entry.name] = lid
        else:
            lid = twin["$dtId"]
            current_ids[entry.name] = lid
            pairs = []
            if entry.marker is not None:
                pairs.append(("marker", entry.marker))
            if entry.alias:
                pairs.append(("alias", list(entry.alias)))
            if entry.lat is not None:
                pairs.append(("lat", entry.lat))
            if entry.lng is not None:
                pairs.append(("lng", entry.lng))
            ops = _scalar_ops(twin, pairs)
            if ops:
                client.update_twin_props(trip_dtid, lid, ops, x_user_id=actor["sub"])

    # Rebuild the root atLocation edges: index = position (marker order).
    for r in root_at:
        client.delete_relationship(
            trip_dtid, r["$relationshipId"], x_user_id=actor["sub"]
        )
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
