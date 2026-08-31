"""Trip store — Konnektr Graph is the single source of truth (P1, issue #4).

When ``KISEKI_GRAPH_URL`` + ``KISEKI_GRAPH_TOKEN`` are set, the graph is the
ONLY source trips are served from. There is deliberately NO file fallback: if
the graph read fails (token unknown, twin missing, API error) the request
returns 404/500 as it should, rather than silently serving a stale
``trip.json``. That silent fallback previously masked a production outage, so
it is gone by design.

When the graph is NOT configured (local dev / CI, no env vars), the store
reads ``trip.json`` files directly as the local source of truth. This is the
configured primary path in that mode — not a fallback — so it stays useful for
development and tests.

Read flow for a token (graph enabled):
  1. ``find_trip_dtid_by_token`` → Trip ``$dtId`` (None if unknown)
  2. ``fetch_graph`` → ADT twin/relationship bundle (source-agnostic shape)
  3. ``graph_to_trip`` rebuilds the ``Trip`` model
"""

from __future__ import annotations

from pathlib import Path

from .config import TRIPS_DIR
from .models import Trip

_GRAPH_CLIENT = None
_GRAPH_CLIENT_READY = False


def _graph_client():
    """Lazily build (and cache) the graph read client; None if not configured."""
    global _GRAPH_CLIENT, _GRAPH_CLIENT_READY
    if _GRAPH_CLIENT_READY:
        return _GRAPH_CLIENT
    _GRAPH_CLIENT_READY = True
    try:
        from .graph.client import GraphReadClient

        c = GraphReadClient()
        _GRAPH_CLIENT = c if c.is_enabled() else None
    except Exception:  # pragma: no cover - defensive
        _GRAPH_CLIENT = None
    return _GRAPH_CLIENT


def load_trips() -> list[Trip]:
    """Read every trip.json file from the trips directory (local dev source).

    Used when the graph is not configured. One file per trip, re-read on every
    call so content updates are immediate. Trip files are tiny.
    """
    trips: list[Trip] = []
    if not TRIPS_DIR.is_dir():
        return trips
    for d in sorted(p for p in TRIPS_DIR.iterdir() if p.is_dir()):
        f = d / "trip.json"
        if f.is_file():
            try:
                trips.append(Trip.model_validate_json(f.read_text(encoding="utf-8")))
            except Exception as exc:  # keep the app up if one trip file is broken
                print(f"[kiseki] skipping broken trip file {f}: {exc}")
    return trips


def get_trip_by_token(token: str) -> Trip | None:
    """Resolve a share token to a Trip.

    Graph is the source of truth when configured; on any graph failure the
    token simply isn't served (no file fallback). When the graph is not
    configured, the local ``trip.json`` files are the source.
    """
    client = _graph_client()
    if client is not None:
        dtid = client.find_trip_dtid_by_token(token)
        if not dtid:
            return None
        graph = client.fetch_graph(dtid)
        if not graph:
            return None
        from .graph.convert import graph_to_trip

        return graph_to_trip(graph)
    # Graph not configured → local trip.json is the source of truth.
    for t in load_trips():
        if t.token == token:
            return t
    return None


def get_trip_by_slug(slug: str) -> Trip | None:
    for t in load_trips():
        if t.slug == slug:
            return t
    return None


def get_trip_by_id(trip_dtid: str) -> Trip | None:
    """Resolve a trip by its twin ``$dtId`` (the protected, ACL'd read path).

    Mirrors ``get_trip_by_token`` but keyed on the opaque GUID — used by
    ``GET /api/trips/{trip_id}`` after the ACL dependency has authorized the
    caller. In local-dev mode (graph not configured) trips are matched by the
    ``id`` field of the trip.json files.
    """
    client = _graph_client()
    if client is not None:
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            return None
        from .graph.convert import graph_to_trip

        return graph_to_trip(graph)
    for t in load_trips():
        if t.id == trip_dtid:
            return t
    return None


def get_trip_role_for_user(
    trip_dtid: str,
    user_dtid: str,
) -> str | None:
    """ACL: the role a user holds on a trip (None = no access).

    Graph-backed (``hasCrew`` edge to the User twin identified by the auth
    ``sub``). Returns None when the graph is not configured — callers must
    treat that as 'no role' (fail closed).
    """
    client = _graph_client()
    if client is None:
        return None
    return client.role_for_user_on_trip(trip_dtid, user_dtid)
