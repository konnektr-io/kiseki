"""The signed-in home's trip geo read (issue #249, E2 — the gate).

Slices 3 (map canvas) and 5 (global trip map) both need one thing that does
not exist yet: the anchor coordinates of the trips the viewer may LIST.
``GET /api/trips/geo`` is that read — one row per listable trip, cards not
documents.

The tests pin the pin-half of the acceptance rule:

* the list rule is ``discoverable`` OR the viewer already has a role
  (``_profile_trips``), re-checked in Python, never trusted to WHERE alone —
  a non-discoverable trip the viewer is not on appears in NO row;
* each row carries exactly one anchor — the first located registry entry —
  and trips with no located place are omitted (never null-island 0,0);
* the shape is an allowlist (no crew, no tokens, no ``practical``, no
  booking/cost fields);
* graph disabled or graph down → ``[]``, never 500 — the home collapses the
  map, same soft-load discipline as the showcase.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.graph import client as graph_client_mod
from app.graph.client import GraphReadClient
from app.main import app
from app.store import list_geo_trips
from conftest import CLIENT_ID, TENANT, _claims, _sign

SUB = "google-oauth2|1234567890"
TRIP_MINE = "aaaaaaaa-1111-4111-8111-111111111111"
TRIP_DISC = "bbbbbbbb-2222-4222-8222-222222222222"
TRIP_HIDDEN = "cccccccc-3333-4333-8333-333333333333"
TRIP_NOGEO = "dddddddd-4444-4444-8444-444444444444"


def _mine_row(dtid=TRIP_MINE, places=None):
    return {
        "dtId": dtid,
        "title": "My trip",
        "stage": "booked",
        "places": places
        if places is not None
        else [["Revelstoke", 50.9981, -118.1957, 0]],
    }


def _disc_row(dtid=TRIP_DISC, places=None, discoverable=True,
              visibility="public"):
    return {
        "dtId": dtid,
        "title": "A discoverable trip",
        "stage": "planned",
        "visibility": visibility,
        "discoverable": discoverable,
        "places": places
        if places is not None
        else [["Chamonix", 45.9237, 6.8694, 0]],
    }


class _RecordingClient:
    """Minimal SDK stand-in: yields canned rows per query kind."""

    def __init__(self, mine=None, disc=None, boom: bool = False) -> None:
        self.mine = mine if mine is not None else []
        self.disc = disc if disc is not None else []
        self.boom = boom
        self.calls: list[tuple[str, dict]] = []

    def query_twins(self, query: str, query_parameters: dict | None = None):
        self.calls.append((query, query_parameters or {}))
        if self.boom:
            raise RuntimeError("graph down")
        yield from self.mine if "hasCrew" in query else self.disc


def _client_with(monkeypatch, mine=None, disc=None, boom: bool = False):
    fake = _RecordingClient(mine=mine, disc=disc, boom=boom)
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_URL", "http://graph.test")
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_TOKEN", "t")
    c = graph_client_mod.GraphReadClient()
    c._client = fake  # type: ignore[attr-defined]
    return c, fake


# --------------------------------------------------------------------------
# The queries
# --------------------------------------------------------------------------


def test_mine_query_is_crew_scoped_with_a_bound_sub() -> None:
    assert "MATCH (t:Twin)-[crew:hasCrew]->(u:Twin)" in graph_client_mod._Q_GEO_MINE
    assert "u.`$dtId` = $uid" in graph_client_mod._Q_GEO_MINE
    assert "OPTIONAL MATCH (t)-[a:atLocation]->(l:Twin)" in graph_client_mod._Q_GEO_MINE


def test_discoverable_query_filters_and_carries_the_flag() -> None:
    """The flag rides along so Python can re-check it — never trusted to WHERE."""
    assert "t.discoverable = true" in graph_client_mod._Q_GEO_DISCOVERABLE
    assert "t.discoverable AS discoverable" in graph_client_mod._Q_GEO_DISCOVERABLE
    # Same leak class as the feed stream-2 gate: `discoverable` alone is
    # listed-by-default since #228, so the query filters public too and
    # carries visibility for the Python re-check.
    assert "t.visibility = 'public'" in graph_client_mod._Q_GEO_DISCOVERABLE
    assert "t.visibility AS visibility" in graph_client_mod._Q_GEO_DISCOVERABLE


# --------------------------------------------------------------------------
# The row mapper
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "row",
    [
        pytest.param(None, id="not-a-row"),
        pytest.param([], id="list-row"),
        pytest.param({"title": "No id"}, id="no-dtid"),
        pytest.param({"dtId": "x", "places": []}, id="no-places"),
        pytest.param({"dtId": "x", "places": [[None, None, None, None]]}, id="null-padded-collect"),
        pytest.param({"dtId": "x", "places": [["Nowhere", None, None, 0]]}, id="unlocated"),
        pytest.param({"dtId": "x", "places": [["Null Island", 0, None, 0]]}, id="half-located"),
        pytest.param({"dtId": "x", "places": [["True Island", True, -118.0, 0]]}, id="bool-lat"),
    ],
)
def test_mapper_omits_anything_without_a_located_place(row) -> None:
    assert GraphReadClient._geo_row_from_dict(row, origin="mine") is None


def test_mapper_takes_the_first_located_registry_entry() -> None:
    row = {
        "dtId": "x",
        "title": "T",
        "stage": "booked",
        "places": [
            ["Unlocated", None, None, 0],
            ["Second", 46.0, 7.0, 1],
            ["First", 50.9981, -118.1957, 2],
        ],
    }
    geo = GraphReadClient._geo_row_from_dict(row, origin="mine")
    assert geo is not None
    # Edge order (the trip's own marker order), not coordinate order.
    assert geo["anchor"] == {"lat": 46.0, "lng": 7.0, "name": "Second"}


def test_mapper_sorts_indexless_entries_last() -> None:
    row = {
        "dtId": "x",
        "title": "T",
        "stage": "booked",
        "places": [
            ["NoIndex", 46.0, 7.0, None],
            ["First", 50.9981, -118.1957, 0],
        ],
    }
    geo = GraphReadClient._geo_row_from_dict(row, origin="mine")
    assert geo is not None
    assert geo["anchor"]["name"] == "First"


def test_mapper_returns_an_allowlist_not_the_row() -> None:
    geo = GraphReadClient._geo_row_from_dict(
        {
            "dtId": "trip-1",
            "title": "A trip",
            "stage": "booked",
            "discoverable": True,
            "places": [["Here", 1.0, 2.0, 0]],
            # none of these are part of the read, but a query edit could add
            # them — the mapper is what stops them leaving the process:
            "claimToken": "secret",
            "followToken": "secret-2",
            "crew": [{"name": "someone"}],
            "practical": {"notes": "private"},
            "cost": 42,
        },
        origin="discover",
    )
    assert geo is not None
    assert set(geo) == {"dtId", "title", "stage", "anchor", "origin"}
    assert set(geo["anchor"]) == {"lat", "lng", "name"}
    assert geo["origin"] == "discover"


# --------------------------------------------------------------------------
# The merge (list rule + dedupe)
# --------------------------------------------------------------------------


def test_merge_lists_mine_and_discoverable_with_origins(monkeypatch) -> None:
    c, fake = _client_with(monkeypatch, mine=[_mine_row()], disc=[_disc_row()])
    rows = c.list_geo_trips(SUB)
    assert [(r["dtId"], r["origin"]) for r in rows] == [
        (TRIP_MINE, "mine"),
        (TRIP_DISC, "discover"),
    ]
    assert rows[0]["anchor"] == {"lat": 50.9981, "lng": -118.1957, "name": "Revelstoke"}
    # The sub is a bound parameter, never inlined.
    assert fake.calls[0][1] == {"uid": SUB}


def test_merge_refuses_a_non_discoverable_stranger(monkeypatch) -> None:
    """The pin-half of the acceptance rule: a trip the viewer may not list
    appears in NO row — even when the query hands it over."""
    c, _ = _client_with(
        monkeypatch,
        mine=[_mine_row()],
        disc=[_disc_row(TRIP_HIDDEN, discoverable=False)],
    )
    assert [r["dtId"] for r in c.list_geo_trips(SUB)] == [TRIP_MINE]


def test_merge_refuses_an_absent_flag(monkeypatch) -> None:
    """Absence is not consent — same strictness as the showcase mapper."""
    row = _disc_row(TRIP_HIDDEN)
    del row["discoverable"]
    c, _ = _client_with(monkeypatch, disc=[row])
    assert c.list_geo_trips(SUB) == []


def test_merge_refuses_a_private_but_discoverable_stranger(monkeypatch) -> None:
    """The feed leak's map half: a private trip that is still `discoverable`
    (the #228 default) pins NOBODY's map but its crew's — its anchor (first
    located place) is location data, not a listing."""
    c, _ = _client_with(
        monkeypatch,
        mine=[_mine_row()],
        disc=[_disc_row(TRIP_HIDDEN, visibility="private", discoverable=True)],
    )
    assert [r["dtId"] for r in c.list_geo_trips(SUB)] == [TRIP_MINE]


def test_merge_refuses_an_absent_visibility(monkeypatch) -> None:
    """Fail closed on the second half too: no visibility flag, no pin."""
    row = _disc_row(TRIP_HIDDEN)
    del row["visibility"]
    c, _ = _client_with(monkeypatch, disc=[row])
    assert c.list_geo_trips(SUB) == []


def test_merge_dedupes_mine_first(monkeypatch) -> None:
    """A discoverable trip the viewer is also crew on reads as mine, once."""
    c, _ = _client_with(
        monkeypatch, mine=[_mine_row(TRIP_MINE)], disc=[_disc_row(TRIP_MINE)]
    )
    rows = c.list_geo_trips(SUB)
    assert [(r["dtId"], r["origin"]) for r in rows] == [(TRIP_MINE, "mine")]


def test_merge_omits_unlocated_trips(monkeypatch) -> None:
    c, _ = _client_with(
        monkeypatch,
        mine=[_mine_row(TRIP_NOGEO, places=[["Nowhere", None, None, 0]])],
        disc=[],
    )
    assert c.list_geo_trips(SUB) == []


def test_graph_disabled_or_down_returns_no_rows(monkeypatch, capsys) -> None:
    c = graph_client_mod.GraphReadClient()  # no URL/token in tests
    assert c.list_geo_trips(SUB) == []
    c, _ = _client_with(monkeypatch, boom=True)
    assert c.list_geo_trips(SUB) == []
    assert "geo read failed" in capsys.readouterr().out


def test_malformed_sub_returns_no_rows(monkeypatch) -> None:
    c, fake = _client_with(monkeypatch, mine=[_mine_row()], disc=[_disc_row()])
    assert c.list_geo_trips("bad' OR '1'='1") == []
    assert fake.calls == []


def test_the_write_client_inherits_the_read() -> None:
    """``store`` builds a GraphWriteClient, so the read must live where it sees it."""
    assert hasattr(graph_client_mod.GraphWriteClient, "list_geo_trips")


# --------------------------------------------------------------------------
# The fixture fallback (dev / CI — the same rule, no graph)
# --------------------------------------------------------------------------


def _anon(dtid, *, discoverable, places, visibility="public"):
    return SimpleNamespace(
        id=dtid,
        title="T",
        stage="planned",
        visibility=visibility,
        discoverable=discoverable,
        locations=[SimpleNamespace(name=n, lat=la, lng=ln) for n, la, ln in places],
    )


def test_fallback_lists_discoverable_located_fixtures(monkeypatch) -> None:
    monkeypatch.setattr(
        store_mod, "_anon_trips",
        lambda: [
            _anon(TRIP_DISC, discoverable=True, places=[("Chamonix", 45.9237, 6.8694)]),
            # A discoverable PRIVATE trip pins nobody's map but its crew's —
            # the fallback holds the same public-AND-listed rule as the graph
            # path, so a dev box never shows a pin production would hide.
            _anon(TRIP_MINE, discoverable=True, visibility="private",
                  places=[("Revelstoke", 50.9981, -118.1957)]),
            _anon(TRIP_HIDDEN, discoverable=False, places=[("Hidden", 1.0, 2.0)]),
            _anon(TRIP_NOGEO, discoverable=True, places=[("Nowhere", None, None)]),
        ],
    )
    rows = list_geo_trips(SUB)
    assert [(r["dtId"], r["origin"]) for r in rows] == [
        (TRIP_DISC, "discover"),
    ]
    assert rows[0]["anchor"] == {"lat": 45.9237, "lng": 6.8694, "name": "Chamonix"}


def test_fallback_is_empty_without_the_flag(monkeypatch) -> None:
    """Committed fixtures carry no ``discoverable``: absence is not consent."""
    monkeypatch.setattr(
        store_mod, "_anon_trips",
        lambda: [_anon(TRIP_DISC, discoverable=False, places=[("Chamonix", 45.9237, 6.8694)])],
    )
    assert list_geo_trips(SUB) == []


# --------------------------------------------------------------------------
# The endpoint
# --------------------------------------------------------------------------


@pytest.fixture()
def client(monkeypatch, jwks_url) -> TestClient:
    """Same fixture as test_acl.py: the route through the real token path."""
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    return TestClient(app)


def _auth(rsa_keypair, **claims_overrides) -> dict:
    return {"Authorization": f"Bearer {_sign(rsa_keypair, _claims(**claims_overrides))}"}


def test_endpoint_requires_a_token(client) -> None:
    assert client.get("/api/trips/geo").status_code == 401


def test_endpoint_returns_pins_and_is_per_viewer_cached(client, rsa_keypair, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.main.list_geo_trips",
        lambda sub: [
            {
                "dtId": TRIP_MINE,
                "title": "My trip",
                "stage": "booked",
                "anchor": {"lat": 50.9981, "lng": -118.1957, "name": "Revelstoke"},
                "origin": "mine",
            }
        ],
    )
    r = client.get("/api/trips/geo", headers=_auth(rsa_keypair))
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, max-age=60"
    body = r.json()
    assert body["trips"][0]["anchor"]["name"] == "Revelstoke"
    blob = r.text
    for forbidden in ("claimToken", "followToken", "crew", "practical", "cost", "$metadata"):
        assert forbidden not in blob


def test_endpoint_collapses_without_a_graph(client, rsa_keypair) -> None:
    """No graph in tests → ``[]``, never 500 (the home collapses the map)."""
    r = client.get("/api/trips/geo", headers=_auth(rsa_keypair))
    assert r.status_code == 200
    assert r.json() == {"trips": []}
