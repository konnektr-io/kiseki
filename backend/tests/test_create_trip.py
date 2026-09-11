"""POST /api/trips — create an empty trip (issue #9 / M4).

The chat agent spawns an empty trip, then fills it via the existing write
API. The creator becomes ``owner`` via a ``hasCrew`` edge; the response is
the same public-trip dict the SPA navigates to ``/t/<id>`` with.

Auth follows the chat relay (``acl.resolve_request_actor_sub``): a real
end-user token (mode 1) or the sanctioned M2M client + request act-as sub
(mode 2). A bare M2M token is rejected. Identity provisioning follows #142:
only the user's OWN token may create their User twin — act-as never
provisions a twin for the mapped user behind their back.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.main import app
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
ACT_AS_SUB = "auth0|niko-1"
M2M_CLIENT = "agent-m2m-client-xyz"
PROFILE = {"email": "agent@test.local", "name": "Test Owner"}


def _token_of(rsa_keypair, **overrides: object) -> str:
    return _sign(rsa_keypair, _claims(**overrides))


def _m2m_token_of(rsa_keypair, **overrides: object) -> str:
    claims = _claims(**overrides)
    claims.update(azp=M2M_CLIENT, gty="client-credentials")
    return _sign(rsa_keypair, claims)


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
    monkeypatch.setattr(auth_module, "fetch_userinfo", lambda token: dict(PROFILE))
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", M2M_CLIENT)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "")
    return TestClient(app)


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch):
    """A FakeGraph the test user has NO crew role on (creation needs none)."""
    g = FakeGraph("canada-2027.graph.anon.json")
    monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
    yield g
    store_mod._reset_store_cache()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------------ create
def test_create_trip_201_owner_and_readable(client, graph, rsa_keypair) -> None:
    token = _token_of(rsa_keypair)
    r = client.post(
        "/api/trips",
        headers=_auth(token),
        json={"title": "Japan 2028", "subtitle": "Powder pilimage"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["title"] == "Japan 2028"
    assert body["subtitle"] == "Powder pilimage"
    assert body["stage"] == "idea"
    assert body["visibility"] == "private"
    assert body["slug"] == "japan-2028"
    assert body["myRole"] == "owner"
    assert "claimToken" not in body
    new_id = body["id"]

    # The creator holds the owner role …
    assert graph.role_for_user_on_trip(new_id, SUB) == "owner"
    # … the trip reads back like any other trip …
    got = client.get(f"/api/trips/{new_id}", headers=_auth(token))
    assert got.status_code == 200
    assert got.json()["title"] == "Japan 2028"
    # … and it shows up in the creator's trip list.
    mine = client.get("/api/trips", headers=_auth(token))
    assert mine.status_code == 200
    assert new_id in {t["dtId"] for t in mine.json()["trips"]}


def test_create_trip_provisions_user_twin(client, graph, rsa_keypair) -> None:
    """A first-time user (no User twin yet) gets one from their own token."""
    assert graph.twin(SUB) is None
    token = _token_of(rsa_keypair)
    r = client.post("/api/trips", headers=_auth(token), json={"title": "Chile 2027"})
    assert r.status_code == 201, r.text
    twin = graph.twin(SUB)
    assert twin is not None
    assert twin["email"] == "agent@test.local"


def test_create_trip_owner_row_names_the_owner_never_the_sub(
    client, graph, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#213: a token whose profile carries no name/email (no userinfo — the
    ordinary Auth0 access token) still labels the owner's crew row with the
    account name, which the existing User twin holds. The opaque auth sub is
    never a crew label."""
    graph.twins.append({
        "$dtId": SUB,
        "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
        "name": "Niko Raes",
        "email": "niko@example.com",
        "displayName": "Niko Raes",
        "authProvider": "google",
    })
    monkeypatch.setattr(auth_module, "fetch_userinfo", lambda token: {})
    token = _token_of(rsa_keypair)  # claims carry no email/name
    r = client.post("/api/trips", headers=_auth(token), json={"title": "Burning Man 2027"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert [c["name"] for c in body["crew"]] == ["Niko Raes"]
    edge = next(
        x for x in graph.rels
        if x.get("$relationshipName") == "hasCrew" and x.get("$targetId") == SUB
    )
    assert edge.get("displayName") == "Niko Raes"

    # … and a re-read renders the same name (the bug was the rendered row).
    got = client.get(f"/api/trips/{body['id']}", headers=_auth(token))
    assert got.status_code == 200
    assert [c["name"] for c in got.json()["crew"]] == ["Niko Raes"]


def test_create_trip_title_required(client, graph, rsa_keypair) -> None:
    token = _token_of(rsa_keypair)
    assert client.post("/api/trips", headers=_auth(token), json={}).status_code == 422
    assert client.post(
        "/api/trips", headers=_auth(token), json={"title": "   "}
    ).status_code == 422


def test_create_trip_unauthenticated_401(client, graph) -> None:
    r = client.post("/api/trips", json={"title": "Japan 2028"})
    assert r.status_code == 401


def test_create_trip_bare_m2m_rejected(client, graph, rsa_keypair) -> None:
    """A sanctioned M2M token with no act-as anywhere has no user identity."""
    token = _m2m_token_of(rsa_keypair)
    r = client.post("/api/trips", headers=_auth(token), json={"title": "Japan 2028"})
    assert r.status_code in (401, 403)


def test_create_trip_m2m_act_as_existing_user(client, graph, rsa_keypair) -> None:
    """Mode 2: M2M + act-as header for a user that already has a twin."""
    graph.twins.append({
        "$dtId": ACT_AS_SUB,
        "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
        "name": "Niko",
        "email": "niko@example.com",
        "displayName": "Niko",
        "authProvider": "auth0",
    })
    token = _m2m_token_of(rsa_keypair)
    headers = {**_auth(token), "X-Act-As-Sub": ACT_AS_SUB}
    r = client.post("/api/trips", headers=headers, json={"title": "Japan 2028"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["myRole"] == "owner"
    assert graph.role_for_user_on_trip(body["id"], ACT_AS_SUB) == "owner"
    # The M2M service principal itself gains nothing.
    assert graph.role_for_user_on_trip(body["id"], _claims()["sub"]) is None


def test_create_trip_act_as_unknown_user_forbidden(client, graph, rsa_keypair) -> None:
    """Act-as must never provision a twin for the mapped user behind their back."""
    token = _m2m_token_of(rsa_keypair)
    headers = {**_auth(token), "X-Act-As-Sub": "auth0|stranger-9"}
    r = client.post("/api/trips", headers=headers, json={"title": "Japan 2028"})
    assert r.status_code == 403


def test_create_trip_user_token_without_email_forbidden(
    client, graph, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user token that carries no email (claims or userinfo) cannot be
    provisioned — the server invents no identity."""
    monkeypatch.setattr(auth_module, "fetch_userinfo", lambda token: {})
    token = _token_of(rsa_keypair)  # conftest claims carry no email
    # Fresh graph: SUB has no twin, so provisioning would be required.
    assert graph.twin(SUB) is None
    r = client.post("/api/trips", headers=_auth(token), json={"title": "Japan 2028"})
    assert r.status_code == 403
