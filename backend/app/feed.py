"""The activity feed (#199): the graph's own write times, gathered and described.

No events, no notifications, no second store. The feed is a poll over
``$metadata.$lastUpdateTime`` — the reads live in ``app/graph/client.py`` — and
this module owns only the product rules: which rows may be listed, how they are
ranked and capped, and how a write is put into words.

Kept deliberately thin:

* **Nothing here caches.** The reads are ``@_cached_graph`` (60 s) in the
  client, so a layer here would be a second staleness rule to reason about.
* **``at`` stays the raw ISO-8601 string** the graph returned. Ordering is
  string comparison, and ISO-8601 UTC sorts lexicographically = chronologically,
  so a timestamp is never re-derived through a parsed datetime of a different
  precision.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.graph.client import FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX, clamp_feed_limit
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
    slug = row.get("slug") or ""
    return {
        "kind": "trip",
        "tripId": row.get("dtId"),
        "tripTitle": row.get("title") or "",
        "tripSlug": slug,
        "source": source,
        "at": row.get("at"),
        "by": row.get("by"),
        "changes": changed_properties(row.get("meta") or {}),
        "href": f"/t/{slug}",
    }


def _rank(entries: list[dict]) -> list[dict]:
    """Newest write first; unstamped entries last; deterministic on ties.

    A ``None`` ``at`` means the graph never stamped that twin, so it cannot be
    placed in time at all — it sorts last and ``build_feed`` only ever shows it
    on the first page.
    """
    stamped = [e for e in entries if e.get("at")]
    unstamped = [e for e in entries if not e.get("at")]
    order = lambda e: (e.get("tripSlug") or "", e.get("kind") or "")  # noqa: E731
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
    before: Optional[str] = None,
    client: Optional[Any] = None,
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
    if graph is not None:
        for row in graph.trips_for_user_ordered(sub, limit=cap):
            entries.append(_row_entry(row, "my-trip"))
        for row in graph.trips_of_followed(sub, limit=cap):
            # The listing rule (#196) lives HERE and not in the query: a
            # followed person's private trip must never surface in the feed.
            if row.get("discoverable") is True:
                entries.append(_row_entry(row, "followed-user"))
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
