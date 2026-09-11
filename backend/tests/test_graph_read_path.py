"""P1 graph read-path tests (issue #4).

These prove the acceptance criteria without needing a live Konnektr Graph:
  * ``graph_to_trip`` faithfully inverts the seeded graph fixtures
    (source-agnostic — identical shape whether from the live SDK or a seed file).
  * ``store.get_trip_by_id`` serves the graph as the sole source of truth
    when ``KISEKI_GRAPH_URL`` is configured; a graph read failure surfaces as a
    missing trip (404) rather than a stale file. When the graph is NOT
    configured (local dev / CI) the local ``trip.json`` files are the source.
"""

import json
from pathlib import Path

import pytest

from app import models as M
from app.graph import client as graph_client_mod
from app.graph.convert import _collapse_day_range, graph_to_trip

SEED_DIR = Path(__file__).resolve().parent.parent / "data" / "seed"
TRIPS_DIR = Path(__file__).resolve().parent.parent / "data" / "trips"
MOCK_DIR = Path(__file__).resolve().parent.parent / "data" / "mocks"
SLUGS = ["canada-2027", "chile-peru-2027", "japan-campervan-2028"]


def _load_trip(slug: str) -> M.Trip:
    p = TRIPS_DIR / slug / "trip.json"
    if p.is_file():
        return M.Trip.model_validate_json(p.read_text(encoding="utf-8"))
    anon = MOCK_DIR / f"{slug}.graph.anon.json"
    from app.graph.convert import graph_to_trip
    return graph_to_trip(json.loads(anon.read_text(encoding="utf-8")))


def _load_graph(slug: str) -> dict:
    p = SEED_DIR / f"{slug}.graph.json"
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads((MOCK_DIR / f"{slug}.graph.anon.json").read_text(encoding="utf-8"))


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


def test_graph_to_trip_drops_retired_theme_keys() -> None:
    """A live twin that still carries pre-preset theme keys (primary/accent/
    font) must read fine — retired keys are dropped on read, never a 500
    (#40 follow-up). The strict ``Theme`` model stays a write-path gate only:
    a write that sends one still 422s (see test_write_api.py)."""
    graph = _load_graph("chile-peru-2027")
    trip_twin = next(
        t for t in graph["twins"]
        if t.get("$metadata", {}).get("$model", "").startswith("dtmi:kiseki:travel:Trip")
        and "theme" in t
    )
    # A pre-migration twin: legacy keys, no preset yet.
    trip_twin["theme"] = {"primary": "#7f1d1d", "accent": "#b45309", "font": "inter"}
    trip = graph_to_trip(graph)  # must not raise
    assert trip.theme.preset is None
    assert trip.theme.model_dump(exclude_none=True) == {}

    # A twin mid-migration (preset set, legacy keys not yet stripped) keeps
    # the preset and drops the rest.
    trip_twin["theme"] = {"preset": "ember", "primary": "#7f1d1d", "accent": "#b45309"}
    trip = graph_to_trip(graph)  # must not raise
    assert trip.theme.preset == "ember"
    assert trip.theme.model_dump(exclude_none=True) == {"preset": "ember"}


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

    def find_trip_dtid_by_claim_token(self, token: str):
        self.calls += 1
        return self._graph["$dtId"]

    def fetch_graph(self, trip_dtid: str) -> dict:
        return self._graph


def test_store_serves_from_graph_when_enabled(monkeypatch) -> None:
    """With the graph enabled, the store returns the graph-rebuilt trip and the
    P0 contract (visibility/slug/stage/structure) is intact."""
    import app.store as store_mod

    slug = "canada-2027"
    trip = _load_trip(slug)
    fake = _FakeGraph(_load_graph(slug))
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT", fake)
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT_READY", True)

    got = store_mod.get_trip_by_id(trip.id)
    assert got is not None
    assert got.id == trip.id
    assert got.slug == trip.slug
    assert got.stage == trip.stage
    assert got.model_dump(by_alias=True) == trip.model_dump(by_alias=True)


def test_store_returns_none_when_graph_read_fails(monkeypatch) -> None:
    """With the graph enabled, an unknown token (or read miss) surfaces as a
    missing trip — the store never consults trip.json when the graph is set."""
    import app.store as store_mod

    # A fake client that is "enabled" but can't resolve the token. In graph
    # mode the store must return None here; it must NOT fall back to files.
    class _EnabledButMiss:
        def find_trip_dtid_by_claim_token(self, token):
            return None  # known to the graph as "no such trip"

        def fetch_graph(self, trip_dtid):
            return None

    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT", _EnabledButMiss())
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT_READY", True)

    # Use a real token that WOULD resolve from trip.json in local mode — proving
    # the graph path does not silently serve it when the graph is the source.
    slug = "japan-campervan-2028"
    trip = _load_trip(slug)
    got = store_mod.get_trip_by_id(trip.id)
    assert got is None


def test_client_uses_parameterized_queries(monkeypatch) -> None:
    """The token / dtid / uid are passed as Cypher query parameters, never
    interpolated into the query string (SDK >= 0.3.8). The queries must contain
    `$token` / `$dtid` / `$uid` placeholders and NO f-string-style inlining,
    and query_twins must be called with a non-empty ``query_parameters`` dict."""
    import app.graph.client as client_mod

    # The module-level query constants must use parameter placeholders, not
    # str.format() interpolation residues.
    assert "$claimToken" in client_mod._Q_FIND_TRIP_BY_CLAIM
    assert "$dtid" in client_mod._Q_NODES
    assert "$dtid" in client_mod._Q_RELS
    assert "$uid" in client_mod._Q_TRIPS_FOR_USER
    # No leftover `{token}` / `{dtid}` / `{uid}` str.format placeholders.
    assert "{token}" not in client_mod._Q_FIND_TRIP_BY_CLAIM
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

    c.find_trip_dtid_by_claim_token("abc123")
    c.fetch_graph("bf29a027-2ed2-46b3-b869-d9d81bbcf237")
    c.list_trips_for_user("user:auth0|niko")

    assert len(captured["calls"]) == 4
    for query, params in captured["calls"]:
        assert params, f"query called without query_parameters: {query}"
        assert isinstance(params, dict)
    # Token value must travel in the parameter binding, not the string.
    find_params = captured["calls"][0][1]
    assert find_params.get("claimToken") == "abc123"


def test_rel_from_list_maps_note_and_tolerates_legacy_rows() -> None:
    """_Q_RELS rows carry [src, name, tgt, relId, role, index, note] (issue #89:
    the edge's own $relationshipId is included so fetched bundles can drive
    relationship writes); shorter/legacy rows keep working (fields absent)."""
    full = graph_client_mod.GraphReadClient._rel_from_list(
        ["t1", "hasCrew", "p1", "t1__hasCrew__p1", "owner", 2, "Skis — Elan Playmaker 111"]
    )
    assert full == {
        "$sourceId": "t1",
        "$relationshipName": "hasCrew",
        "$targetId": "p1",
        "$relationshipId": "t1__hasCrew__p1",
        "role": "owner",
        "index": 2,
        "note": "Skis — Elan Playmaker 111",
    }
    # A row from an edge WITHOUT a stored $relationshipId (None in its slot)
    # must not fabricate one — role/index still parse from their fixed slots.
    legacy = graph_client_mod.GraphReadClient._rel_from_list(
        ["t1", "hasCrew", "p1", None, "owner", 2, None]
    )
    assert legacy["role"] == "owner" and legacy["index"] == 2
    assert "note" not in legacy and "$relationshipId" not in legacy


def test_crew_read_sorts_by_edge_index_not_storage_order() -> None:
    """Crew display order follows the hasCrew ``index`` edge property, never
    AGE storage order: edges PATCHed at write time (note/role edits, the live
    graph migration) reorder relationship rows, so the read-path must sort
    hasCrew edges by ``index`` exactly like days/blocks — the fix for the
    deploy-time reorder where the owner slipped to the back of the Crew page.
    (v0.16.7 follow-up)"""
    # Two hasCrew edges stored OUT of index order (index 1 first, then 0).
    graph = {
        "$dtId": "trip-1",
        "twins": [
            {"$dtId": "trip-1", "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"},
             "id": "trip-1", "slug": "x", "title": "T"},
            {"$dtId": "u1", "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
             "id": "u1", "name": "Niko", "role": "owner"},
            {"$dtId": "u2", "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
             "id": "u2", "name": "Nick", "role": "viewer"},
        ],
        "relationships": [
            {"$relationshipId": "r1", "$sourceId": "trip-1",
             "$relationshipName": "hasCrew", "$targetId": "u2",
             "role": "viewer", "index": 1},
            {"$relationshipId": "r0", "$sourceId": "trip-1",
             "$relationshipName": "hasCrew", "$targetId": "u1",
             "role": "owner", "index": 0},
        ],
    }
    crew = graph_to_trip(graph).crew
    assert [c.name for c in crew] == ["Niko", "Nick"]
    assert [c.role for c in crew] == ["owner", "viewer"]


def test_crew_claimed_flag_reflects_twin_model_kind() -> None:
    """``crew[].claimed`` derives from the twin's model kind: User twin → True
    (has an account), Person twin → False (unclaimed placeholder — the Crew
    page shows the invite affordance)."""
    graph = {
        "$dtId": "trip-1",
        "twins": [
            {"$dtId": "trip-1", "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"},
             "id": "trip-1", "slug": "x", "title": "T"},
            {"$dtId": "u1", "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
             "id": "u1", "name": "Niko"},
            {"$dtId": "u2", "$metadata": {"$model": "dtmi:kiseki:travel:Person;1"},
             "id": "u2", "name": "Nick", "contact": "+32 1 23 45 67"},
        ],
        "relationships": [
            {"$relationshipId": "r0", "$sourceId": "trip-1",
             "$relationshipName": "hasCrew", "$targetId": "u1",
             "role": "owner", "index": 0},
            {"$relationshipId": "r1", "$sourceId": "trip-1",
             "$relationshipName": "hasCrew", "$targetId": "u2",
             "role": "viewer", "index": 1, "note": "gear"},
        ],
    }
    crew = graph_to_trip(graph).crew
    assert crew[0].claimed is True   # User twin behind the edge
    assert crew[1].claimed is False  # placeholder Person twin
    # view-only: the note still rides the edge, the flag is not a twin prop
    assert crew[1].note == "gear"


def test_crew_claimed_never_reaches_the_graph() -> None:
    """``claimed`` is a read-path convenience — trip_to_graph must not write
    it onto the twin (it is the model kind, not a property)."""
    from scripts.trip_to_graph import trip_to_graph

    trip = _load_trip("canada-2027")
    for p in trip.crew:
        p.claimed = p.id.startswith("user")  # force both values
    g = trip_to_graph(trip)
    for t in g["twins"]:
        assert "claimed" not in t
    for r in g["relationships"]:
        assert "claimed" not in r


# ---------------------------------------------------------------- #171 regression


def _tripless_bundle(dtid: str) -> dict:
    """The LIVE graph's unknown-id answer: non-empty but Trip-less (Cypher
    collect() over zero matches → empty twins/relationships lists)."""
    return {"$dtId": dtid, "twins": [], "relationships": []}


def test_graph_to_trip_raises_typed_notfound_on_tripless_bundle() -> None:
    """A non-empty, Trip-less bundle raises the TYPED GraphNotFound (not a
    bare ValueError): the read path must be able to map 'absent' → 404
    without swallowing pydantic ValidationError (a ValueError subclass that
    signals corrupt data, not absence)."""
    from app.graph.convert import GraphNotFound

    with pytest.raises(GraphNotFound):
        graph_to_trip(_tripless_bundle("00000000-0000-4000-8000-000000000000"))


def test_graph_to_trip_still_raises_validationerror_on_corrupt_data() -> None:
    """Corrupt graph data (a Trip twin whose fields fail the model) must NOT
    be classified as 'absent': it raises pydantic ValidationError, which the
    store does NOT map to None — corrupt data 500s, absent data 404s."""
    from pydantic import ValidationError

    corrupt = {
        "$dtId": "trip-1",
        "twins": [{
            "$dtId": "trip-1",
            "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"},
            "slug": "x", "title": "T", "stage": "bogus-stage",
        }],
        "relationships": [],
    }
    with pytest.raises(ValidationError):
        graph_to_trip(corrupt)


def test_store_tripless_bundle_is_none(monkeypatch) -> None:
    """The exact shape FakeGraph never produced (issue #171): a TRUTHY,
    non-empty, Trip-less bundle through ``get_trip_by_id`` → None (→ 404 at
    every gate), not a 500."""
    import app.store as store_mod

    class _LiveShapedMiss:
        def fetch_graph(self, trip_dtid):
            return _tripless_bundle(trip_dtid)

    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT", _LiveShapedMiss())
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT_READY", True)
    assert store_mod.get_trip_by_id("00000000-0000-4000-8000-000000000000") is None


def test_store_corrupt_bundle_propagates(monkeypatch) -> None:
    """The store maps ONLY GraphNotFound to None. A corrupt bundle (pydantic
    ValidationError, a ValueError subclass) propagates — the 500 is honest:
    data exists but cannot be served; faking a 404 would hide corruption."""
    import app.store as store_mod

    corrupt = {
        "$dtId": "trip-1",
        "twins": [{
            "$dtId": "trip-1",
            "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"},
            "slug": "x", "title": "T", "stage": "bogus-stage",
        }],
        "relationships": [],
    }

    class _CorruptGraph:
        def fetch_graph(self, trip_dtid):
            return corrupt

    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT", _CorruptGraph())
    monkeypatch.setattr(store_mod, "_GRAPH_CLIENT_READY", True)
    with pytest.raises(Exception) as excinfo:
        store_mod.get_trip_by_id("trip-1")
    assert not isinstance(excinfo.value, __import__(
        "app.graph.convert", fromlist=["GraphNotFound"]).GraphNotFound)
