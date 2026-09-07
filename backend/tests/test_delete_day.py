"""Delete-day endpoint tests (DELETE /api/trips/{trip_id}/days/{day_id}).

Complement to test_insert_day.py: every test runs against the in-memory
``FakeGraph`` (seeded from the committed canada anon fixture) with the REAL
ACL + store + service code, asserting the full write → re-read roundtrip:

    auth token → require_trip_role (role from the fake's hasCrew edge)
               → delete_day (twin + edge deletes, re-index, section re-tile)
               → fake graph applies the ops
               → response rebuilt from the fake

The tiling invariant under test: every remaining trip day is covered by
exactly one section before AND after the delete.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.graph.convert import graph_to_trip
from app.main import app
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"


def _token_of(rsa_keypair, **overrides: object) -> str:
    return _sign(rsa_keypair, _claims(**overrides))


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    return TestClient(app)


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch):
    """Factory: stage a FakeGraph + give the test user a crew role on it."""
    made: list[FakeGraph] = []

    def _make(role: str = "owner", fixture: str = "canada-2027.graph.anon.json",
              sub: str = SUB) -> FakeGraph:
        g = FakeGraph(fixture)
        g.add_user_role(g.root, sub, role)
        monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
        made.append(g)
        return g

    yield _make
    for g in made:
        store_mod._reset_store_cache()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _trip_of(g: FakeGraph):
    return graph_to_trip(g.fetch_graph(g.root))


def _authz(client, method, url, token, json=None):
    return client.request(method, url, headers=_auth(token), json=json)


def _tiling(sections: list) -> list[int]:
    """Every covered day index, sorted — full tiling is range(n_days)."""
    covered: list[int] = []
    for s in sections:
        days = list(s["days"])
        if not days:
            continue  # ideation section — covers nothing
        assert len(days) == 2, f"section {s['title']!r} has non-range days {days}"
        covered += list(range(days[0], days[1] + 1))
    return sorted(covered)


def test_delete_day_middle_shifts_sections(client, rsa_keypair, graph) -> None:
    """Delete day index 2 (first Revelstoke day): days after it shift -1,
    Revelstoke shrinks to [2, 3], later chapters shift -1/-1, tiling kept."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    assert len(trip.days) == 16
    doomed = trip.days[2]
    doomed_block_ids = {b.id for b in doomed.blocks}
    assert doomed_block_ids, "fixture day 2 should carry blocks"
    before_ids = [d.id for d in trip.days]
    before_refs = {s.id: list(s.locationRefs) for s in trip.sections}

    r = _authz(client, "delete", f"/api/trips/{trip.id}/days/{doomed.id}", token)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert len(body["days"]) == 15
    assert "claimToken" not in body

    # The doomed day is gone; neighbors are now adjacent.
    after_ids = [d["id"] for d in body["days"]]
    assert doomed.id not in after_ids
    assert after_ids == before_ids[:2] + before_ids[3:]

    # Section ranges: Arrival untouched, Revelstoke shrunk, rest shifted.
    by_title = {s["title"]: s for s in body["sections"]}
    assert by_title["Arrival & First Turns"]["days"] == [0, 1]
    assert by_title["Revelstoke"]["days"] == [2, 3]
    assert by_title["The Heli Block"]["days"] == [4, 7]
    assert by_title["Kicking Horse"]["days"] == [8, 10]
    assert by_title["Lake Louise"]["days"] == [11, 14]
    assert _tiling(body["sections"]) == list(range(15))

    # locationRefs are place references — the shift must not touch them.
    for s in body["sections"]:
        assert s["locationRefs"] == before_refs[s["id"]]

    # The day's blocks went with it — no orphan Block twins left behind.
    remaining_block_ids = {b["id"] for d in body["days"] for b in d["blocks"]}
    remaining_block_ids |= {b["id"] for s in body["sections"] for b in s.get("blocks", [])}
    assert not (doomed_block_ids & remaining_block_ids)
    twin_ids = {t["$dtId"] for t in g.twins}
    assert doomed.id not in twin_ids
    assert not (doomed_block_ids & twin_ids)

    # x-user-id attribution reached the graph client.
    assert any(h.get("x-user-id") == SUB for h in g.write_headers)


def test_delete_day_first_shifts_everything(client, rsa_keypair, graph) -> None:
    """Delete day index 0: the first chapter shrinks to [0, 0], every other
    chapter shifts -1/-1, tiling kept."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    first_id = trip.days[0].id

    r = _authz(client, "delete", f"/api/trips/{trip.id}/days/{first_id}", token)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert len(body["days"]) == 15
    assert body["days"][0]["id"] != first_id
    by_title = {s["title"]: s for s in body["sections"]}
    assert by_title["Arrival & First Turns"]["days"] == [0, 0]
    assert by_title["Revelstoke"]["days"] == [1, 3]
    assert by_title["The Heli Block"]["days"] == [4, 7]
    assert by_title["Kicking Horse"]["days"] == [8, 10]
    assert by_title["Lake Louise"]["days"] == [11, 14]
    assert _tiling(body["sections"]) == list(range(15))


def test_delete_day_last_shrinks_trailer(client, rsa_keypair, graph) -> None:
    """Delete the final day: only the trailer chapter shrinks, the rest stay."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    last_id = trip.days[-1].id

    r = _authz(client, "delete", f"/api/trips/{trip.id}/days/{last_id}", token)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert len(body["days"]) == 15
    assert last_id not in [d["id"] for d in body["days"]]
    by_title = {s["title"]: s for s in body["sections"]}
    assert by_title["Arrival & First Turns"]["days"] == [0, 1]
    assert by_title["Revelstoke"]["days"] == [2, 4]
    assert by_title["The Heli Block"]["days"] == [5, 8]
    assert by_title["Kicking Horse"]["days"] == [9, 11]
    assert by_title["Lake Louise"]["days"] == [12, 14]
    assert _tiling(body["sections"]) == list(range(15))


def test_delete_day_only_day_rejected(client, rsa_keypair, graph) -> None:
    """A trip must keep >= 1 day: deleting the last remaining day is a 422,
    and deleting an unknown day is a 404."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)

    # Unknown day id → 404.
    r = _authz(client, "delete", f"/api/trips/{trip.id}/days/does-not-exist", token)
    assert r.status_code == 404

    # Shrink the trip to a single day via the API itself.
    while len(_trip_of(g).days) > 1:
        cur = _trip_of(g)
        r = _authz(client, "delete", f"/api/trips/{cur.id}/days/{cur.days[0].id}", token)
        assert r.status_code == 200, r.text[:300]

    last = _trip_of(g)
    assert len(last.days) == 1
    r = _authz(client, "delete", f"/api/trips/{last.id}/days/{last.days[0].id}", token)
    assert r.status_code == 422
    # The day survived the rejected delete.
    assert len(_trip_of(g).days) == 1


def test_delete_day_roles(client, rsa_keypair, graph) -> None:
    """Role gating like the rest of the write API: anonymous 401,
    viewer/follower 403, editor+owner 200."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/days/{trip.days[5].id}"

    assert client.delete(url).status_code == 401

    gv = graph(role="viewer")
    tripv = _trip_of(gv)
    tv = _token_of(rsa_keypair)
    urlv = f"/api/trips/{tripv.id}/days/{tripv.days[5].id}"
    assert _authz(client, "delete", urlv, tv).status_code == 403

    gv.add_user_role(tripv.id, SUB, "follower")
    assert _authz(client, "delete", urlv, tv).status_code == 403

    gv.add_user_role(tripv.id, SUB, "editor")
    r = _authz(client, "delete", urlv, tv)
    assert r.status_code == 200, r.text[:300]
    assert len(r.json()["days"]) == 15
