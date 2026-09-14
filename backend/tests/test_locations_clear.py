"""Explicit-clear semantics for the location registry (PUT + PATCH /locations).

Contract under test (absent / value / null / empty-list):

- field absent from the payload  -> stored value untouched (no op);
- field present with a value      -> patched;
- field present as ``null``       -> cleared (prop ``remove``d on the twin,
  serialized back as ``null``);
- list field present as ``[]``    -> cleared as an explicit empty list
  (stored ``[]``, serialized back as ``[]`` — never skipped).

``marker: null`` clears to the positional default (marker is optional —
it was never rejected, so there is no 422 to preserve).
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


def _seed(client, token, url):
    """One location with scalar + list metadata set; returns its response entry."""
    body = {"locations": [{
        "name": "Banff",
        "lat": 51.18, "lng": -115.57,
        "website": "https://banff.example",
        "phone": "+1 403-555-0100",
        "types": ["lodging"],
    }]}
    r = _authz(client, "put", url, token, json=body)
    assert r.status_code == 200, r.text
    locs = r.json()["locations"]
    assert [loc["name"] for loc in locs] == ["Banff"]
    out = locs[0]
    assert out["types"] == ["lodging"]
    assert out["website"] == "https://banff.example"
    return r.json()


def _loc_of(doc, name="Banff"):
    return next(loc for loc in doc["locations"] if loc["name"] == name)


# (a) PUT with an entry where `types: null` clears a previously-set `types`.
def test_put_null_clears_list_field(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    _seed(client, token, url)

    r = _authz(client, "put", url, token, json={"locations": [
        {"name": "Banff", "types": None},
    ]})
    assert r.status_code == 200, r.text
    out = _loc_of(r.json())
    # cleared == omitted from the payload (#220 strips unset optionals), so
    # read it as absence rather than a literal null
    assert out.get("types") is None
    # absent siblings stay untouched by the same PUT
    assert out["website"] == "https://banff.example"
    assert out["phone"] == "+1 403-555-0100"
    assert out["lat"] == 51.18 and out["lng"] == -115.57


# (b) PUT with `types: []` clears (stored as an explicit empty list).
def test_put_empty_list_clears_list_field(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    _seed(client, token, url)

    r = _authz(client, "put", url, token, json={"locations": [
        {"name": "Banff", "types": []},
    ]})
    assert r.status_code == 200, r.text
    out = _loc_of(r.json())
    assert out["types"] == []


# (c) PUT where `types` is absent leaves the stored value.
def test_put_absent_field_leaves_stored_value(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    _seed(client, token, url)

    r = _authz(client, "put", url, token, json={"locations": [
        {"name": "Banff"},
    ]})
    assert r.status_code == 200, r.text
    out = _loc_of(r.json())
    assert out["types"] == ["lodging"]
    assert out["website"] == "https://banff.example"
    assert out["phone"] == "+1 403-555-0100"


# (d) PATCH (named upsert) with `website: null` clears only that field.
def test_patch_null_clears_single_field(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    _seed(client, token, url)

    r = _authz(client, "patch", url, token, json={"locations": [
        {"name": "Banff", "website": None},
    ]})
    assert r.status_code == 200, r.text
    out = _loc_of(r.json())
    # cleared == omitted from the payload (#220 strips unset optionals)
    assert out.get("website") is None
    # everything else on the twin survives the single-field clear
    assert out["phone"] == "+1 403-555-0100"
    assert out["types"] == ["lodging"]
    assert out["lat"] == 51.18 and out["lng"] == -115.57
    # and the registry order is untouched (no delete, no append)
    assert [loc["name"] for loc in r.json()["locations"]] == ["Banff"]


# (e) absent fields on PATCH remain untouched.
def test_patch_absent_fields_untouched(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    _seed(client, token, url)

    r = _authz(client, "patch", url, token, json={"locations": [
        {"name": "Banff", "marker": 5},
    ]})
    assert r.status_code == 200, r.text
    out = _loc_of(r.json())
    assert out["marker"] == 5
    assert out["website"] == "https://banff.example"
    assert out["phone"] == "+1 403-555-0100"
    assert out["types"] == ["lodging"]
    assert out["lat"] == 51.18 and out["lng"] == -115.57
