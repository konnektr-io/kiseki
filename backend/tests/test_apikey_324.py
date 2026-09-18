"""Admin API-key auth (issue #324) — the quota-independent agent credential.

Auth0 meters EVERY client_credentials grant tenant-wide (~1 000/month); a
spent quota kills all agent paths until the reset. API keys bypass Auth0
entirely: `X-API-Key` validates against sha256 digests in KISEKI_API_KEYS
and resolves to a synthetic service user that `acl` treats EXACTLY like the
sanctioned M2M token (act-as-anyone, refused on provisioning routes).
"""

from __future__ import annotations

import hashlib

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app.acl import _is_agent_credential, require_user_token, resolve_actor_sub, resolve_request_actor_sub
from app.auth import api_key_user, parse_api_keys, resolve_api_key
from app.main import app

from conftest import CLIENT_ID, TENANT

KEY = "ksk_test_admin_key_do_not_use"
DIGEST = hashlib.sha256(KEY.encode()).hexdigest()
KEYS_ENV = f"agent:{DIGEST}"


@pytest.fixture
def keyed(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(auth_module, "KISEKI_API_KEYS", KEYS_ENV)
    return TestClient(app)


# ------------------------------------------------------------------- parsing


def test_parse_api_keys_accepts_pairs_and_skips_garbage() -> None:
    parsed = parse_api_keys(f"agent:{DIGEST}, broken, :{DIGEST}, name:xyz, other:{DIGEST}")
    assert parsed == {"agent": DIGEST, "other": DIGEST}


def test_parse_api_keys_empty_is_no_keys() -> None:
    assert parse_api_keys("") == {}
    assert parse_api_keys(None) == {}


def test_resolve_api_key_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_module, "KISEKI_API_KEYS", KEYS_ENV)
    assert resolve_api_key(KEY) == "agent"
    assert resolve_api_key("ksk_wrong_key") is None
    assert resolve_api_key("") is None
    assert resolve_api_key(None) is None


def test_api_key_user_is_namespaced_service_identity() -> None:
    user = api_key_user("agent")
    assert user == {"sub": "apikey:agent@agents", "api_key": "agent"}
    # Never collides with a real Auth0 sub shape.
    assert "google-oauth2" not in user["sub"]
    assert "|" not in user["sub"]


# ----------------------------------------------------------------- HTTP layer


def test_me_rejects_unknown_api_key(keyed: TestClient) -> None:
    resp = keyed.get("/api/auth/me", headers={"X-API-Key": "ksk_nope"})
    assert resp.status_code == 401


def test_me_rejects_api_key_without_act_as(keyed: TestClient) -> None:
    """An API key MUST always impersonate a user — no pin/owner fallback."""
    resp = keyed.get("/api/auth/me", headers={"X-API-Key": KEY})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Admin API key requires X-Act-As-Sub for user-scoped routes"


def test_me_key_with_header_returns_impersonated_sub(keyed: TestClient) -> None:
    """The header's sub echoes back — no twin exists for the key, none is made."""
    resp = keyed.get(
        "/api/auth/me",
        headers={"X-API-Key": KEY, "X-Act-As-Sub": "google-oauth2|jane"},
    )
    assert resp.status_code == 200
    assert resp.json()["sub"] == "google-oauth2|jane"


def test_me_key_ignores_pin_for_explicit_header(
    keyed: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The request-scoped sub wins over the static M2M pin for API keys."""
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "google-oauth2|niko")
    resp = keyed.get(
        "/api/auth/me",
        headers={"X-API-Key": KEY, "X-Act-As-Sub": "google-oauth2|jane"},
    )
    assert resp.status_code == 200
    assert resp.json()["sub"] == "google-oauth2|jane"


def test_bearer_still_wins_over_api_key(keyed: TestClient) -> None:
    """An invalid bearer is a 401 even with a valid key present (fail closed)."""
    resp = keyed.get(
        "/api/auth/me",
        headers={"Authorization": "Bearer garbage", "X-API-Key": KEY},
    )
    assert resp.status_code == 401


# -------------------------------------------------------------- acl parity


def test_is_agent_credential_covers_both_service_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", "agent-client")
    m2m = {"sub": "agent-client@clients", "azp": "agent-client", "gty": "client-credentials"}
    assert _is_agent_credential(m2m) is True
    assert _is_agent_credential(api_key_user("agent")) is True
    assert _is_agent_credential({"sub": "google-oauth2|123"}) is False


def test_request_actor_sub_key_requires_header_not_pin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = api_key_user("agent")
    assert resolve_request_actor_sub(user, "google-oauth2|jane") == "google-oauth2|jane"
    assert resolve_actor_sub(user, "google-oauth2|jane") == "google-oauth2|jane"
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "google-oauth2|niko")
    with pytest.raises(HTTPException) as exc:
        resolve_request_actor_sub(user, None)
    assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        resolve_actor_sub(user, None)
    assert exc.value.status_code == 401


def test_require_user_token_refuses_api_key_like_m2m() -> None:
    with pytest.raises(HTTPException) as exc:
        require_user_token(api_key_user("agent"))
    assert exc.value.status_code == 403
    assert exc.value.detail == "Service principals cannot claim or follow trips"


# ------------------------------------------------- trip-path gates (#324 fix)

PIN_SUB = "google-oauth2|1234567890"


@pytest.fixture
def trip_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(auth_module, "KISEKI_API_KEYS", KEYS_ENV)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", PIN_SUB)
    return TestClient(app)


@pytest.fixture
def owned_trip(monkeypatch: pytest.MonkeyPatch):
    from app import store as store_mod

    from fake_graph import FakeGraph
    from app.graph.convert import graph_to_trip

    g = FakeGraph("canada-2027.graph.anon.json")
    g.add_user_role(g.root, PIN_SUB, "owner")
    g.twin(g.root)["visibility"] = "private"  # the anon fixture trip is public; the agent's trips are not
    monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
    yield graph_to_trip(g.fetch_graph(g.root)), g
    store_mod._reset_store_cache()


def _key(act_as: str | None = PIN_SUB) -> dict:
    headers = {"X-API-Key": KEY}
    if act_as is not None:
        headers["X-Act-As-Sub"] = act_as
    return headers


def test_trip_get_with_key_resolves_explicit_owner(trip_client: TestClient, owned_trip) -> None:
    trip, _ = owned_trip
    resp = trip_client.get(f"/api/trips/{trip.id}", headers=_key())
    assert resp.status_code == 200, resp.text[:300]
    assert resp.json()["myRole"] == "owner"


def test_trip_get_with_key_and_no_act_as_is_401(trip_client: TestClient, owned_trip) -> None:
    """No pin or owner fallback for API keys — even when the pin is configured."""
    trip, _ = owned_trip
    resp = trip_client.get(f"/api/trips/{trip.id}", headers=_key(None))
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Admin API key requires X-Act-As-Sub for user-scoped routes"


def test_trip_get_with_key_for_non_crew_sub_is_403(trip_client: TestClient, owned_trip) -> None:
    trip, _ = owned_trip
    resp = trip_client.get(
        f"/api/trips/{trip.id}", headers=_key("google-oauth2|stranger")
    )
    assert resp.status_code == 403


def test_trip_list_with_key_uses_explicit_identity(trip_client: TestClient, owned_trip) -> None:
    trip, _ = owned_trip
    resp = trip_client.get("/api/trips", headers=_key())
    assert resp.status_code == 200, resp.text[:300]
    rows = resp.json()["trips"]
    assert trip.id in {row.get("dtId") for row in rows}
    assert trip_client.get("/api/trips", headers=_key(None)).status_code == 401


def test_trip_get_with_unknown_key_is_401(trip_client: TestClient, owned_trip) -> None:
    trip, _ = owned_trip
    resp = trip_client.get(
        f"/api/trips/{trip.id}", headers={"X-API-Key": "ksk_nope"}
    )
    assert resp.status_code == 401


def test_trip_put_with_key_writes_as_explicit_owner(
    trip_client: TestClient, owned_trip
) -> None:
    trip, g = owned_trip
    resp = trip_client.put(
        f"/api/trips/{trip.id}", headers=_key(), json={"title": "Key Title"}
    )
    assert resp.status_code == 200, resp.text[:300]
    assert resp.json()["title"] == "Key Title"
    assert resp.json()["myRole"] == "owner"
    # Graph attribution is the impersonated user — never the key itself.
    assert any(h.get("x-user-id") == PIN_SUB for h in g.write_headers)
    assert all(h.get("x-user-id") != "apikey:agent@agents" for h in g.write_headers)


def test_trip_put_with_key_and_no_act_as_is_401(
    trip_client: TestClient, owned_trip
) -> None:
    trip, g = owned_trip
    before = len(g.write_headers)
    resp = trip_client.put(
        f"/api/trips/{trip.id}", headers=_key(None), json={"title": "No Write"}
    )
    assert resp.status_code == 401
    assert len(g.write_headers) == before


def test_trip_delete_with_key_then_gone(
    trip_client: TestClient, owned_trip
) -> None:
    trip, _ = owned_trip
    url = f"/api/trips/{trip.id}"
    assert trip_client.delete(url, headers=_key(None)).status_code == 401
    assert trip_client.delete(url, headers=_key()).status_code == 204
    assert trip_client.get(url, headers=_key()).status_code == 404
