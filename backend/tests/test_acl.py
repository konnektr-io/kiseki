"""ACL enforcement tests (issue #5 — protected read path).

Covers the graph role query (``role_for_user_on_trip``), the userinfo profile
fetch, and the protected endpoint ``GET /api/trips/{trip_id}`` end to end:
401 unauthenticated → 403 no role → 200 with role, with the public token route
untouched.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app.auth import Auth0JWTValidator
from app.graph import client as graph_client_mod
from app.main import app
from app.store import load_trips

from conftest import CLIENT_ID, TENANT, _claims, _sign


def _uuid() -> str:
    trip = load_trips()[0]
    assert trip.id, "trip data has no id field"
    return trip.id


def _token_of(rsa_keypair, **claims_overrides: object) -> str:
    return _sign(rsa_keypair, _claims(**claims_overrides))


# ---------------------------------------------------------------- graph role


class _FakeClient:
    """Minimal stand-in for the SDK client: records calls, returns rows."""

    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows = rows or []
        self.calls: list[tuple[str, dict]] = []

    def query_twins(self, query: str, query_parameters: dict | None = None):
        self.calls.append((query, query_parameters or {}))
        yield from self.rows


def _client_with(
    monkeypatch: pytest.MonkeyPatch, rows: list[dict] | None = None
) -> graph_client_mod.GraphReadClient:
    fake = _FakeClient(rows)
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_URL", "http://graph.test")
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_TOKEN", "t")
    c = graph_client_mod.GraphReadClient()
    c._client = fake  # type: ignore[attr-defined]
    return c


def _calls(c: graph_client_mod.GraphReadClient) -> list:
    return c._client.calls  # type: ignore[attr-defined]


def test_role_for_user_returns_role(monkeypatch) -> None:
    c = _client_with(monkeypatch, rows=[{"role": "owner"}])
    got = c.role_for_user_on_trip(_uuid(), "google-oauth2|1")
    assert got == "owner"
    _, params = _calls(c)[0]
    assert params == {"dtid": _uuid(), "uid": "google-oauth2|1"}


def test_role_for_user_none_when_no_rows(monkeypatch) -> None:
    c = _client_with(monkeypatch, rows=[])
    assert c.role_for_user_on_trip(_uuid(), "google-oauth2|1") is None


def test_role_for_user_rejects_bad_input(monkeypatch) -> None:
    c = _client_with(monkeypatch)
    # malformed trip dtid / user id → None WITHOUT any SDK call
    assert c.role_for_user_on_trip("not-a-uuid", "google-oauth2|1") is None
    assert c.role_for_user_on_trip(_uuid(), "bad|id|'quote") is None
    assert _calls(c) == []


def test_role_for_user_none_when_graph_disabled(monkeypatch) -> None:
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_URL", "")
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_TOKEN", "")
    c = graph_client_mod.GraphReadClient()
    assert c.is_enabled() is False
    assert c.role_for_user_on_trip(_uuid(), "google-oauth2|1") is None


def test_role_for_user_none_on_sdk_error(monkeypatch) -> None:
    def boom(*_a, **_k):
        raise RuntimeError("graph down")

    c = _client_with(monkeypatch)
    c._client.query_twins = boom  # type: ignore[attr-defined]
    assert c.role_for_user_on_trip(_uuid(), "google-oauth2|1") is None


# ---------------------------------------------------------------- userinfo


def test_fetch_userinfo_caches(monkeypatch) -> None:
    calls: list[str] = []

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a) -> None:
            pass

        def read(self) -> bytes:
            return b'{"email": "niko@example.com", "name": "Niko Raes"}'

    def fake_urlopen(req, timeout=5):
        calls.append(req.full_url)
        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    auth_module._USERINFO_CACHE.clear()

    p1 = auth_module.fetch_userinfo("tok-1")
    p2 = auth_module.fetch_userinfo("tok-1")
    assert p1["email"] == "niko@example.com"
    assert p1 == p2
    assert len(calls) == 1  # second call served from cache


def test_fetch_userinfo_failure_returns_empty(monkeypatch) -> None:
    def fake_urlopen(req, timeout=5):
        raise OSError("network down")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    auth_module._USERINFO_CACHE.clear()
    assert auth_module.fetch_userinfo("tok-2") == {}


# ---------------------------------------------------------------- endpoint


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
def role(monkeypatch: pytest.MonkeyPatch):
    """Set the ACL role the graph returns for the current user (None = no role)."""

    def _set(value: str | None) -> None:
        monkeypatch.setattr(
            acl_module,
            "get_trip_role_for_user",
            lambda *a, **k: value,
        )

    return _set


def test_protected_requires_token(client: TestClient) -> None:
    r = client.get(f"/api/trips/{_uuid()}")
    assert r.status_code == 401


def test_protected_rejects_invalid_token(client: TestClient, rsa_keypair) -> None:
    bad = _sign(rsa_keypair, _claims(exp=int(time.time()) - 60))
    r = client.get(f"/api/trips/{_uuid()}", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


def test_protected_forbidden_without_role(client: TestClient, rsa_keypair, role) -> None:
    role(None)
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_uuid()}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_protected_forbidden_below_min_role(client: TestClient, rsa_keypair, role) -> None:
    # viewer is below the editor threshold used here — but the endpoint uses
    # the default (viewer), so this exercises the rank comparison at 403.
    role("follower")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_uuid()}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_protected_ok_with_role(client: TestClient, rsa_keypair, role) -> None:
    role("viewer")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_uuid()}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == _uuid()
    assert body["slug"]  # same shape as the token route
    assert body["token"]  # secret link still rides along (share feature)
    assert body["myRole"] == "viewer"  # caller's role reported on the protected path
    assert "claimToken" not in body  # the claim secret never ships in documents


def test_protected_404_unknown_trip(client: TestClient, rsa_keypair, role) -> None:
    role("viewer")
    token = _token_of(rsa_keypair)
    unknown = "00000000-0000-4000-8000-000000000000"
    r = client.get(f"/api/trips/{unknown}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 404


def test_public_token_route_still_anonymous(client: TestClient) -> None:
    trip = load_trips()[0]
    r = client.get(f"/api/trips/{trip.token}")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == trip.slug
    assert "claimToken" not in body  # never leaked on the anonymous route


def test_public_token_route_ignores_bad_auth(client: TestClient, rsa_keypair) -> None:
    trip = load_trips()[0]
    bad = _sign(rsa_keypair, _claims(exp=int(time.time()) - 60))
    r = client.get(
        f"/api/trips/{trip.token}",
        headers={"Authorization": f"Bearer {bad}"},
    )
    assert r.status_code == 200  # anonymous-by-link: auth header is irrelevant


# ---------------------------------------------------------------- join link


def test_join_link_requires_token(client: TestClient) -> None:
    r = client.get(f"/api/trips/{_uuid()}/join-link")
    assert r.status_code == 401


def test_join_link_forbidden_for_viewer(client: TestClient, rsa_keypair, role) -> None:
    role("viewer")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_uuid()}/join-link", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_join_link_ok_for_owner(client: TestClient, rsa_keypair, role) -> None:
    role("owner")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_uuid()}/join-link", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["joinUrl"].startswith("/join/")
    assert len(body["joinUrl"]) > len("/join/")
