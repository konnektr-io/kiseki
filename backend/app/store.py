"""Trip store — Konnektr Graph is the ONLY source of truth in production.

Trip data lives in the graph as DTDL twins and relationships and is
updated via the SDK PATCH path (#46) on individual twins, not as
whole-file reseeds. ``backend/data/trips/*/trip.json`` and
``backend/data/seed/*.graph.json`` are git-ignored scratch files for
local authoring only (see ``backend/data/trips/README.md``).

Local/CI without a live graph
------------------------------
When ``KISEKI_GRAPH_URL`` is not set the store serves the **anonymized**
fixtures under ``backend/data/mocks/*.graph.anon.json`` (committed, no
secrets). This keeps ``uv run pytest`` and local preview useful without
a running graph, while never serving real PII or claim tokens. In
production the graph is always wired, so this fallback is never hit.
"""

from __future__ import annotations

import json
from pathlib import Path

from .models import Trip

BACKEND_DIR = Path(__file__).resolve().parent.parent
_ANON_DIR = BACKEND_DIR / "data" / "mocks"

_GRAPH_CLIENT = None
_GRAPH_CLIENT_READY = False


def _reset_store_cache() -> None:
    """Test helper — clear the cached graph client so env changes take effect."""
    global _GRAPH_CLIENT, _GRAPH_CLIENT_READY
    _GRAPH_CLIENT = None
    _GRAPH_CLIENT_READY = False


def _graph_client():
    """Lazily build (and cache) the graph client; None if not configured."""
    global _GRAPH_CLIENT, _GRAPH_CLIENT_READY
    if _GRAPH_CLIENT_READY:
        return _GRAPH_CLIENT
    _GRAPH_CLIENT_READY = True
    try:
        from .graph.client import GraphWriteClient

        c = GraphWriteClient()
        _GRAPH_CLIENT = c if c.is_enabled() else None
    except Exception:  # pragma: no cover - defensive
        _GRAPH_CLIENT = None
    return _GRAPH_CLIENT


def get_graph_client():
    """Public access to the shared graph client (read + claim write ops)."""
    return _graph_client()


# ------------------------------------------------------------------ fallback
# Anonymized mocks are the only file source the tests/CI ever see.


def _anon_trips() -> list[Trip]:
    trips: list[Trip] = []
    if not _ANON_DIR.is_dir():
        return trips
    from .graph.convert import graph_to_trip

    for p in sorted(_ANON_DIR.glob("*.graph.anon.json")):
        try:
            g = json.loads(p.read_text(encoding="utf-8"))
            trips.append(graph_to_trip(g))
        except Exception as exc:  # pragma: no cover - keep the app up
            print(f"[kiseki] skipping broken anon mock {p}: {exc}")
    return trips


def load_trips() -> list[Trip]:
    """Compatibility alias for tests.

    Loads the anonymized fixtures (not real trip data). Prefer the
    graph-backed ``get_trip_by_id`` / ``list_trips_for_user`` in new code.
    """
    client = _graph_client()
    if client is not None:
        # In graph mode the file list is not authoritative — but for
        # callers that still iterate (e.g. legacy tests) return the
        # anonymized set so collection doesn't break; the graph remains
        # the authority for single-trip reads.
        return _anon_trips()
    return _anon_trips()


def get_trip_by_slug(slug: str) -> Trip | None:
    for t in _anon_trips():
        if t.slug == slug:
            return t
    return None


def get_trip_by_id(trip_dtid: str) -> Trip | None:
    """Resolve a trip by its twin ``$dtId``.

    Graph is the authority; when not configured, falls back to the
    anonymized mocks (so ``uv run pytest`` works without a live graph).

    A Trip-less bundle IS "absent" (issue #171): the live graph answers an
    unknown ``$dtId`` with a non-empty bundle (empty ``twins`` list — the
    Cypher ``collect()`` over zero matches), so the falsy check below does
    not fire and ``graph_to_trip`` raises ``GraphNotFound``. Mapping it to
    ``None`` here is what turns every 404 gate (GET, ACL, delete, tricount,
    chat) into a clean 404 instead of a 500.
    """
    client = _graph_client()
    if client is not None:
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            return None
        from .graph.convert import GraphNotFound, graph_to_trip

        try:
            return graph_to_trip(graph)
        except GraphNotFound:
            return None
    for t in _anon_trips():
        if t.id == trip_dtid:
            return t
    return None


def list_trips_for_user(user_dtid: str) -> list[dict]:
    """Trip summaries for the logged-in landing ('my trips', issue #7).

    Graph-backed; when the graph is not configured returns the anonymized
    fixtures without a role (dev/CI convenience).
    """
    client = _graph_client()
    if client is not None:
        return client.list_trips_for_user(user_dtid)
    return [
        {
            "dtId": t.id,
            "visibility": t.visibility,
            "title": t.title,
            "subtitle": t.subtitle,
            "stage": t.stage,
            "startDate": t.startDate,
            "endDate": t.endDate,
            "slug": t.slug,
            "cover": t.cover,
        }
        for t in _anon_trips()
    ]


def list_showcase_trips(limit: int | None = None) -> list[dict]:
    """Public, discoverable trips for the signed-out landing (#249).

    Graph-backed, with the anonymised fixtures standing in when no graph is
    wired — and they are held to the SAME rule, so a dev box never shows a
    listing production would hide. Cards only: no crew edge, no token, no
    ``practical`` is read on this path, because an anonymous caller reaches it.
    """
    from .graph.client import SHOWCASE_LIMIT_DEFAULT, clamp_showcase_limit

    cap = clamp_showcase_limit(SHOWCASE_LIMIT_DEFAULT if limit is None else limit)
    client = get_graph_client()
    if client is not None:
        return client.list_showcase_trips(cap)
    out: list[dict] = []
    for trip in _anon_trips():
        if trip.visibility != "public" or not trip.discoverable:
            continue
        out.append(
            {
                "dtId": trip.id,
                "title": trip.title,
                "subtitle": trip.subtitle,
                "stage": trip.stage,
                "startDate": trip.startDate,
                "endDate": trip.endDate,
                "cover": trip.cover,
            }
        )
        if len(out) >= cap:
            break
    return out


def get_trip_role_for_user(
    trip_dtid: str,
    user_dtid: str,
) -> str | None:
    """ACL: the role a user holds on a trip (None = no access)."""
    client = _graph_client()
    if client is None:
        return None
    return client.role_for_user_on_trip(trip_dtid, user_dtid)
