"""Insert-day endpoint tests (POST /api/trips/{trip_id}/days).

Same pattern as test_write_api.py: every test runs against the in-memory
``FakeGraph`` (seeded from the committed canada anon fixture) with the REAL
ACL + store + service code, asserting the full write → re-read roundtrip:

    auth token → require_trip_role (role from the fake's hasCrew edge)
               → create_day (validation, twin + edge writes, section shift)
               → fake graph applies the ops
               → response rebuilt from the fake

The tiling invariant under test: every trip day is covered by exactly one
section before AND after the insert (mirroring the closing-chapter test in
test_write_api.py).
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
        assert len(days) == 2, f"section {s['title']!r} has non-range days {days}"
        covered += list(range(days[0], days[1] + 1))
    return sorted(covered)


def test_post_day_insert_middle_shifts_sections(client, rsa_keypair, graph) -> None:
    """Insert at index 2: the new day lands in Revelstoke [2, 4] → [2, 5],
    earlier chapters untouched, later chapters shifted +1/+1, tiling kept."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    assert len(trip.days) == 16
    before_ids = [d.id for d in trip.days]
    before_refs = {s.id: list(s.locationRefs) for s in trip.sections}

    r = _authz(client, "post", f"/api/trips/{trip.id}/days", token, json={
        "index": 2, "date": "2027-02-17", "title": "Extra powder day",
    })
    assert r.status_code == 201, r.text[:300]
    body = r.json()
    assert len(body["days"]) == 17
    assert "claimToken" not in body

    # The new day sits at position 2 with its date/title; old days shifted.
    new = body["days"][2]
    assert new["date"] == "2027-02-17"
    assert new["title"] == "Extra powder day"
    assert new["blocks"] == []
    after_ids = [d["id"] for d in body["days"]]
    assert after_ids[:2] == before_ids[:2]
    assert after_ids[3:] == before_ids[2:]

    # Section ranges: Arrival untouched, Revelstoke extended, rest shifted.
    by_title = {s["title"]: s for s in body["sections"]}
    assert by_title["Arrival & First Turns"]["days"] == [0, 1]
    assert by_title["Revelstoke"]["days"] == [2, 5]
    assert by_title["The Heli Block"]["days"] == [6, 9]
    assert by_title["Kicking Horse"]["days"] == [10, 12]
    assert by_title["Lake Louise"]["days"] == [13, 16]
    assert _tiling(body["sections"]) == list(range(17))

    # locationRefs are place references — the shift must not touch them.
    for s in body["sections"]:
        assert s["locationRefs"] == before_refs[s["id"]]

    # x-user-id attribution reached the graph client.
    assert any(h.get("x-user-id") == SUB for h in g.write_headers)


def test_post_day_append_extends_trailer(client, rsa_keypair, graph) -> None:
    """Append (explicit index == n, and omitted index) grows the trip; the
    chapter covering the old last day absorbs the new final day."""
    for payload in ({"index": 16, "date": "2027-03-03"}, {"date": "2027-03-03"}):
        g = graph()
        trip = _trip_of(g)
        token = _token_of(rsa_keypair)
        r = _authz(client, "post", f"/api/trips/{trip.id}/days", token, json=payload)
        assert r.status_code == 201, r.text[:300]
        body = r.json()
        assert len(body["days"]) == 17
        assert body["days"][-1]["date"] == "2027-03-03"
        assert [d["id"] for d in body["days"]][:-1] == [d.id for d in trip.days]
        by_title = {s["title"]: s for s in body["sections"]}
        assert by_title["Lake Louise"]["days"] == [12, 16]
        assert by_title["Arrival & First Turns"]["days"] == [0, 1]
        assert _tiling(body["sections"]) == list(range(17))


def test_post_day_prepend_joins_first_chapter(client, rsa_keypair, graph) -> None:
    """Insert at 0: the first chapter extends to cover the new first day,
    every other chapter shifts +1/+1."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    r = _authz(client, "post", f"/api/trips/{trip.id}/days", token, json={
        "index": 0, "date": "2027-02-14", "title": "Early arrival",
    })
    assert r.status_code == 201, r.text[:300]
    body = r.json()
    assert body["days"][0]["date"] == "2027-02-14"
    by_title = {s["title"]: s for s in body["sections"]}
    assert by_title["Arrival & First Turns"]["days"] == [0, 2]
    assert by_title["Revelstoke"]["days"] == [3, 5]
    assert by_title["Lake Louise"]["days"] == [13, 16]
    assert _tiling(body["sections"]) == list(range(17))


def test_post_day_defaults_and_boundary_insert(client, rsa_keypair, graph) -> None:
    """Omitted title → untitled; omitted date → previous day + 1. A boundary
    insert (first day of a chapter) joins the chapter starting there."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    # Index 5 is the first Heli day — the new day joins The Heli Block.
    r = _authz(client, "post", f"/api/trips/{trip.id}/days", token,
               json={"index": 5})
    assert r.status_code == 201, r.text[:300]
    body = r.json()
    assert body["days"][5]["title"] == ""
    assert body["days"][5]["date"] == "2027-02-20"  # Feb 19 (day 4) + 1
    by_title = {s["title"]: s for s in body["sections"]}
    assert by_title["Revelstoke"]["days"] == [2, 4]
    assert by_title["The Heli Block"]["days"] == [5, 9]
    assert _tiling(body["sections"]) == list(range(17))


def test_post_day_validation_and_roles(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/days"
    # Out of range / negative / wrong-typed index, bad date, unknown field.
    assert _authz(client, "post", url, token,
                 json={"index": 17}).status_code == 422
    assert _authz(client, "post", url, token,
                 json={"index": -1}).status_code == 422
    assert _authz(client, "post", url, token,
                 json={"index": "two"}).status_code == 422
    assert _authz(client, "post", url, token,
                 json={"index": 2, "date": "Feb 17"}).status_code == 422
    assert _authz(client, "post", url, token,
                 json={"index": 2, "bogus": 1}).status_code == 422
    # Role gating like the rest of the write API: anonymous 401,
    # viewer/follower 403, editor 201.
    assert client.post(url, json={"index": 0}).status_code == 401
    gv = graph(role="viewer")
    tripv = _trip_of(gv)
    tv = _token_of(rsa_keypair)
    assert _authz(client, "post", f"/api/trips/{tripv.id}/days", tv,
                 json={"index": 0}).status_code == 403
    gv.add_user_role(tripv.id, SUB, "follower")
    assert _authz(client, "post", f"/api/trips/{tripv.id}/days", tv,
                 json={"index": 0}).status_code == 403
    gv.add_user_role(tripv.id, SUB, "editor")
    r = _authz(client, "post", f"/api/trips/{tripv.id}/days", tv,
               json={"index": 0, "date": "2027-02-14"})
    assert r.status_code == 201
