"""P1 graph read-path tests (issue #4).

These prove the acceptance criteria without needing a live Konnektr Graph:
  * ``graph_to_trip`` faithfully inverts the seeded graph fixtures
    (source-agnostic — identical shape whether from the live SDK or a seed file).
  * ``store.get_trip_by_token`` serves the graph when enabled, and falls back
    to baked trip.json on any graph failure / when unconfigured — the P0 API
    contract stays byte-stable either way.
"""

import json
from pathlib import Path

import pytest

from app import models as M
from app.graph import client as graph_client_mod
from app.graph.convert import _collapse_day_range, graph_to_trip

SEED_DIR = Path(__file__).resolve().parent.parent / "data" / "seed"
TRIPS_DIR = Path(__file__).resolve().parent.parent / "data" / "trips"
SLUGS = ["canada-2027", "chile-peru-2027", "japan-campervan-2028"]


def _load_trip(slug: str) -> M.Trip:
    return M.Trip.model_validate_json((TRIPS_DIR / slug / "trip.json").read_text(encoding="utf-8"))


def _load_graph(slug: str) -> dict:
    return json.loads((SEED_DIR / f"{slug}.graph.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("slug", SLUGS)
def test_graph_to_trip_roundtrip_faithful(slug: str) -> None:
    """Rebuilding a Trip from its seeded graph is byte-identical to trip.json."""
    orig = _load_trip(slug)
    rebuilt = graph_to_trip(_load_graph(slug))
    assert rebuilt.model_dump(by_alias=True) == orig.model_dump(by_alias=True)


def test_graph_to_trip_preserves_block_location_alias() -> None:
    """A block's own ``location`` (e.g. alias 'Hillcrest') is kept, not the
    canonical resolved name from the atLocation edge ('Revelstoke')."""
    canada = graph_to_trip(_load_graph("canada-2027"))
    # find the block whose source location is the 'Hillcrest' alias
    hillcrest = next(
        b for d in canada.days for b in d.blocks if b.location == "Hillcrest"
    )
    assert hillcrest is not None


def test_collapse_day_range() -> None:
    assert _collapse_day_range([]) == []
    assert _collapse_day_range([9]) == [9, 9]          # single-day section
    assert _collapse_day_range([2, 3, 4]) == [2, 4]     # inclusive range
    assert _collapse_day_range([0, 1, 3]) == [0, 1, 3]  # non-contiguous preserved


def test_graph_client_disabled_without_env(monkeypatch) -> None:
    monkeypatch.delenv("KISEKI_GRAPH_URL", raising=False)
    monkeypatch.delenv("KISEKI_GRAPH_TOKEN", raising=False)
    # reset the module-level singleton (lives in store.py) so the env change is observed
    import app.store as store_mod

    store_mod._GRAPH_CLIENT = None
    store_mod._GRAPH_CLIENT_READY = False
    from app.graph import client as graph_client_mod

    c = graph_client_mod.GraphReadClient()
    assert c.is_enabled() is False


class _FakeGraph:
    """Stand-in for GraphReadClient that returns a fixed seed graph."""

    def __init__(self, graph: dict) -> None:
        self._graph = graph
        self.calls = 0

    def find_trip_dtid_by_token(self, token: str):
        self.calls += 1
        return self._graph["$dtId"]

    def fetch_graph(self, trip_dtid: str) -> dict:
        return self._graph


def test_store_serves_from_graph_when_enabled(monkeypatch) -> None:
    """With the graph enabled, the store returns the graph-rebuilt trip and the
    P0 contract (token/slug/stage/structure) is intact."""
    import app.store as store_mod

    slug = "canada-2027"
    trip = _load_trip(slug)
    fake = _FakeGraph(_load_graph(slug))
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT", fake)
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT_READY", True)

    got = store_mod.get_trip_by_token(trip.token)
    assert got is not None
    assert got.token == trip.token
    assert got.slug == trip.slug
    assert got.stage == trip.stage
    assert got.model_dump(by_alias=True) == trip.model_dump(by_alias=True)


def test_store_falls_back_on_graph_failure(monkeypatch) -> None:
    """If the graph read raises, the store still serves the baked trip.json."""
    import app.store as store_mod

    slug = "japan-campervan-2028"
    trip = _load_trip(slug)

    class _Boom:
        def find_trip_dtid_by_token(self, token):
            raise RuntimeError("graph down")

    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT", _Boom())
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT_READY", True)

    got = store_mod.get_trip_by_token(trip.token)
    assert got is not None
    assert got.slug == slug  # came from the file fallback, not the graph


def test_client_uses_parameterized_queries(monkeypatch) -> None:
    """The token / dtid / uid are passed as Cypher query parameters, never
    interpolated into the query string (SDK >= 0.3.8). The queries must contain
    `$token` / `$dtid` / `$uid` placeholders and NO f-string-style inlining,
    and query_twins must be called with a non-empty ``query_parameters`` dict."""
    import app.graph.client as client_mod

    # The module-level query constants must use parameter placeholders, not
    # str.format() interpolation residues.
    assert "$token" in client_mod._Q_FIND_TRIP
    assert "$dtid" in client_mod._Q_NODES
    assert "$dtid" in client_mod._Q_RELS
    assert "$uid" in client_mod._Q_TRIPS_FOR_USER
    # No leftover `{token}` / `{dtid}` / `{uid}` str.format placeholders.
    assert "{token}" not in client_mod._Q_FIND_TRIP
    assert "{dtid}" not in client_mod._Q_NODES
    assert "{uid}" not in client_mod._Q_TRIPS_FOR_USER

    captured = {}

    class _FakeClient:
        def query_twins(self, query, query_parameters=None, **kwargs):
            captured.setdefault("calls", []).append((query, query_parameters))
            return iter([])

    monkeypatch.setenv("KISEKI_GRAPH_URL", "http://localhost:8080")
    monkeypatch.setenv("KISEKI_GRAPH_TOKEN", "test-token")
    c = client_mod.GraphReadClient()
    # is_enabled() requires a real KonnektrGraphClient import; replace the
    # instance's underlying client with our fake that captures the calls.
    c._client = _FakeClient()
    monkeypatch.setattr(client_mod.GraphReadClient, "is_enabled", lambda self: True)

    c.find_trip_dtid_by_token("abc123")
    c.fetch_graph("bf29a027-2ed2-46b3-b869-d9d81bbcf237")
    c.list_trips_for_user("user:auth0|niko")

    assert len(captured["calls"]) == 4
    for query, params in captured["calls"]:
        assert params, f"query called without query_parameters: {query}"
        assert isinstance(params, dict)
    # Token value must travel in the parameter binding, not the string.
    find_params = captured["calls"][0][1]
    assert find_params.get("token") == "abc123"
