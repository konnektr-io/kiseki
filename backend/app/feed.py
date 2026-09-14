"""The activity feed (#199): the graph's own write times, gathered and described.

No events, no notifications, no second store. The feed is a poll over
``$metadata.$lastUpdateTime`` — the reads live in ``app/graph/client.py`` — and
this module owns only the product rules: which rows may be listed, how they are
ranked and capped, and how a write is put into words.

Kept deliberately thin:

* **Nothing here caches.** The reads are ``@_cached_graph`` (60 s) in the
  client, so a layer here would be a second staleness rule to reason about.
* **Item rows read the RAW bundle.** ``convert.py`` strips ``$metadata`` (the
  write times), so a followed trip's items are built from the twins
  ``fetch_graph`` returns — the same cached copy the trip page reads.
* **``at`` stays the raw ISO-8601 string** the graph returned. Ordering is
  string comparison, and ISO-8601 UTC sorts lexicographically = chronologically,
  so a timestamp is never re-derived through a parsed datetime of a different
  precision.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.graph.client import FEED_LIMIT_DEFAULT, clamp_feed_limit
from app.media import canonicalize_media
from app.store import get_graph_client

#: Property -> the words the feed uses for it. A property nobody mapped falls
#: back to its own name, so a new field is reported rather than silently lost.
NARRATABLE = {
    "title": "title", "subtitle": "subtitle", "summary": "summary", "stage": "stage",
    "cover": "cover photo", "theme": "theme", "startDate": "start date",
    "endDate": "end date", "crew": "crew", "locations": "locations",
    "practical": "practical info", "features": "features", "images": "photos",
    "description": "description",
}

#: App-managed, derived and metadata keys — never text. ``stats`` and ``updated``
#: are recomputed by the app, so their write time says nothing about what a
#: person changed; ranking uses the twin-level ``$lastUpdateTime`` instead.
IGNORED = {"stats", "updated", "$model", "$dtId", "$etag", "$lastUpdateTime",
           "$lastUpdatedBy"}

#: How many "changed" labels one entry may name.
CHANGES_CAP = 3


def changed_properties(meta: dict[str, Any], cap: int = CHANGES_CAP) -> list[str]:
    """Human labels for the properties whose own write time is newest.

    ``meta`` is a twin's raw ``$metadata`` as the feed query returns it: every
    property the server stamped carries its own ``$lastUpdateTime``, which is
    exactly what lets the feed say *what* changed rather than merely that
    something did. Ties are broken by label so a page is stable.
    """
    stamped: list[tuple[str, str]] = []
    for prop, value in (meta or {}).items():
        if prop in IGNORED or not isinstance(value, dict):
            continue
        at = value.get("$lastUpdateTime")
        if not at:
            continue
        stamped.append((str(at), NARRATABLE.get(prop, prop)))
    # Two passes so equal timestamps fall back to label order (ascending).
    stamped.sort(key=lambda pair: pair[1])
    stamped.sort(key=lambda pair: pair[0], reverse=True)
    return [label for _at, label in stamped[:cap]]


def _row_entry(row: dict, source: str) -> dict:
    """One trip-level feed entry (stream 1 or 2).

    ``changes`` names what moved. A trip with no stamped properties — an older
    twin, or a write that touched only the twin itself — still makes an entry;
    it just cannot say what changed.
    """
    return {
        "kind": "trip",
        "tripId": row.get("dtId"),
        "tripTitle": row.get("title") or "",
        "source": source,
        "at": row.get("at"),
        "by": row.get("by"),
        "changes": changed_properties(row.get("meta") or {}),
        # Routes carry the trip's $dtId — the durable identity. The
        # repo-folder slug is organizational and can collide.
        "href": f"/t/{row.get('dtId')}",
    }


#: Block properties that hold pictures: a gallery writes ``items``, a card
#: strip writes ``images``. Either one moving means "photos added".
MEDIA_PROPS = ("items", "images")

#: How many item rows one trip may contribute, and how many thumbnails a row
#: carries. The row IS the point (#199): a follower reads the photos in the
#: FEED, so three inline pictures beat a link to them.
ITEMS_PER_TRIP = 3
THUMBS_PER_ITEM = 3

#: How many trips the feed walks for item rows — my own and followed alike.
#: The bundle read is the expensive one (~540 ms walk, cached 60 s — the same
#: copy the trip page reads), so a worst-case first paint stays bounded. Trips
#: beyond this contribute their trip row only.
ITEMS_TRIPS = 3


def _index_bundle(bundle: dict) -> tuple[dict[str, dict], dict[str, list[dict]]]:
    """``{$dtId: raw twin}`` and ``{$sourceId: [raw relationship]}``.

    Deliberately the RAW bundle: ``convert.py`` strips ``$metadata`` when it
    builds the document model, and the write times are exactly what the feed is
    made of.
    """
    twins: dict[str, dict] = {}
    for twin in bundle.get("twins") or []:
        if isinstance(twin, dict) and twin.get("$dtId"):
            twins[str(twin["$dtId"])] = twin
    rels: dict[str, list[dict]] = {}
    for rel in bundle.get("relationships") or []:
        if isinstance(rel, dict):
            rels.setdefault(str(rel.get("$sourceId")), []).append(rel)
    return twins, rels


def _edge_targets(rels: dict[str, list[dict]], source: str, name: str) -> list[str]:
    """Edge targets in the order the edge's ``index`` gives (AGE row order is
    not stable — an edge PATCH reshuffles it, as the crew ordering found)."""
    found = [r for r in rels.get(source, []) if r.get("$relationshipName") == name]
    if any("index" in r for r in found):
        found.sort(key=lambda r: r.get("index") or 0)
    return [str(r.get("$targetId")) for r in found if r.get("$targetId")]


def _stamp(twin: dict, prop: str | None = None) -> tuple[str | None, str | None]:
    """``(at, by)`` for a twin — or for one property of it.

    The property-level stamps are what let a row say "4 photos added" with a
    time of its own: the graph records when ``images``/``items`` last moved, not
    merely when the block did.
    """
    meta = twin.get("$metadata") or {}
    if prop is not None:
        value = meta.get(prop)
        meta = value if isinstance(value, dict) else {}
    return meta.get("$lastUpdateTime"), meta.get("$lastUpdatedBy")


def _photos(twin: dict, trip_id: str) -> list[str]:
    """Every picture on the block as a renderable URL, in model order.

    Bare filenames (the data model) become ``/media/<trip_id>/<file>`` through
    the same canonicalizer the trip document uses, so the feed inherits its
    traversal guard instead of inventing a second media path. Non-media values —
    a todo's ``[{label, done}]``, a custom block's HTML — are simply not
    pictures and drop out.
    """
    out: list[str] = []
    for prop in MEDIA_PROPS:
        for value in twin.get(prop) or []:
            if not isinstance(value, str) or not value:
                continue
            url = canonicalize_media(value, trip_id)
            if url.startswith("/media/") and url not in out:
                out.append(url)
    return out


def items_of_trip(
    bundle: dict,
    *,
    trip_id: str,
    trip_title: str,
    source: str,
    cap: int = ITEMS_PER_TRIP,
) -> list[dict]:
    """What changed ON a trip's days, newest write first, at most ``cap`` rows.

    One row per block write, so a gallery of four photos is ONE row ("4 photos
    added") with its thumbnails inline and never four rows. A block whose own
    stamp is newer than its pictures is a content row instead ("description
    updated") and claims no photos — the row says what actually moved.

    Every row also carries the BLOCK's own ``title`` (``blockTitle``): a day is
    typically several blocks, so "updated" without the block's name cannot be
    told apart from its neighbour.
    """
    twins, rels = _index_bundle(bundle or {})
    root = str((bundle or {}).get("$dtId") or "")
    rows: list[dict] = []
    for day_index, day_id in enumerate(_edge_targets(rels, root, "hasDay")):
        day_title = (twins.get(day_id) or {}).get("title") or ""
        for block_id in _edge_targets(rels, day_id, "hasBlock"):
            block = twins.get(block_id)
            if not block:
                continue
            at, by = _stamp(block)
            photos = _photos(block, trip_id)
            media = sorted(
                (stamp for stamp in (_stamp(block, prop) for prop in MEDIA_PROPS)
                 if stamp[0]),
                key=lambda stamp: stamp[0] or "",
                reverse=True,
            )
            media_at, media_by = media[0] if media else (None, None)
            if photos and media_at and (not at or media_at >= at):
                label = f"{len(photos)} photo{'s' if len(photos) != 1 else ''} added"
                thumbs = photos[:THUMBS_PER_ITEM]
                row_at, row_by = media_at, media_by or by
            else:
                changed = changed_properties(block.get("$metadata") or {}, cap=1)
                label = f"{changed[0]} updated" if changed else "updated"
                thumbs = []
                row_at, row_by = at, by
            rows.append({
                "kind": "item",
                "tripId": trip_id,
                "tripTitle": trip_title,
                "source": source,
                "dayIndex": day_index,
                "dayTitle": day_title,
                "blockTitle": block.get("title") or "",
                "label": label,
                "thumbs": thumbs,
                "at": row_at,
                "by": row_by,
                "href": f"/t/{trip_id}/day/{day_index}",
            })
    # Newest first; the day's own order breaks ties, so a page is stable.
    rows.sort(key=lambda row: (row["dayIndex"], row["label"]))
    rows.sort(key=lambda row: row["at"] or "", reverse=True)
    return rows[:cap]


def _item_entries(graph: Any, trips: list[dict], limit: int = ITEMS_TRIPS) -> list[dict]:
    """Item rows for the newest ``limit`` trips the feed lists — either stream.

    ``trips`` are the trip-level entries whose listing the caller has ALREADY
    decided (stream 1 is mine; stream 2 passed #196's listing rule), so nothing
    private is walked here. Walking my OWN trips matters as much as followed
    ones: a bare "Updated" on my trip row says nothing, while its blocks name
    what actually moved. The bundle read reuses the 60 s cached copy the trip
    page pays for; a trip whose bundle is missing or unreadable contributes no
    items and keeps its trip row, because the optional half of the feed must
    never be able to empty it.
    """
    fetch = getattr(graph, "fetch_graph", None)
    if fetch is None or not trips:
        return []
    out: list[dict] = []
    for entry in _rank(trips)[:limit]:
        trip_id = entry.get("tripId")
        if not trip_id:
            continue
        try:
            bundle = fetch(trip_id)
        except Exception as exc:  # noqa: BLE001 — the feed degrades, never 500s
            print(f"[kiseki] feed item read({trip_id}) failed: {exc}")
            continue
        if not bundle:
            continue
        out.extend(items_of_trip(
            bundle,
            trip_id=str(trip_id),
            trip_title=entry.get("tripTitle") or "",
            source=entry.get("source") or "my-trip",
        ))
    return out


def _rank(entries: list[dict]) -> list[dict]:
    """Newest write first; unstamped entries last; deterministic on ties.

    A ``None`` ``at`` means the graph never stamped that twin, so it cannot be
    placed in time at all — it sorts last and ``build_feed`` only ever shows it
    on the first page.
    """
    stamped = [e for e in entries if e.get("at")]
    unstamped = [e for e in entries if not e.get("at")]
    order = lambda e: (e.get("tripId") or "", e.get("kind") or "")
    stamped.sort(key=order)
    stamped.sort(key=lambda e: e["at"], reverse=True)
    unstamped.sort(key=order)
    return stamped + unstamped


def _now_iso() -> str:
    """UTC now in the same ISO shape as ``at``."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def is_iso_timestamp(value: str) -> bool:
    """True when ``value`` is an ISO-8601 timestamp — the ``before`` cursor's
    shape. The route turns anything else into a 422."""
    if not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    return True


def build_feed(
    sub: str,
    *,
    limit: int = FEED_LIMIT_DEFAULT,
    before: str | None = None,
    client: Any | None = None,
) -> dict:
    """The caller's own feed: both streams, newest write first, capped, paged.

    ``before`` is the ``nextBefore`` cursor of the previous page. Entries are
    compared as ISO-8601 strings, so pages are contiguous and nothing repeats;
    entries with no write time are shown on the first page only, because there
    is no timestamp to resume from.

    ``client`` is for tests; by default the shared read client is used (the same
    one the trip pages use, cached 60 s per read).
    """
    graph = client if client is not None else get_graph_client()
    cap = clamp_feed_limit(limit)
    entries: list[dict] = []
    trips: list[dict] = []
    own_ids: set[str] = set()
    if graph is not None:
        for row in graph.trips_for_user_ordered(sub, limit=cap):
            entry = _row_entry(row, "my-trip")
            entries.append(entry)
            trips.append(entry)
            if entry.get("tripId"):
                own_ids.add(str(entry["tripId"]))
        for row in graph.trips_of_followed(sub, limit=cap):
            # The listing rule (#196) lives HERE and not in the query: a
            # followed person's private trip must never surface in the feed —
            # and gating before the walk is also what keeps a private trip's
            # items out of it.
            if row.get("discoverable") is not True:
                continue
            # A trip I am already crew on is a stream-1 row: the same trip must
            # never be listed twice, and my own row wins — it carries the full
            # write metadata the followed row omits.
            if str(row.get("dtId") or "") in own_ids:
                continue
            entry = _row_entry(row, "followed-user")
            entries.append(entry)
            trips.append(entry)
    entries.extend(_item_entries(graph, trips))
    if before:
        entries = [e for e in entries if e.get("at") and e["at"] < before]
    ranked = _rank(entries)
    page = ranked[:cap]
    last_at = page[-1].get("at") if page else None
    return {
        "generatedAt": _now_iso(),
        "nextBefore": last_at if (last_at and len(ranked) > len(page)) else None,
        "items": page,
    }
