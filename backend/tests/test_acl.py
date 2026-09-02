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
from app.ratelimit import reset as reset_rate_limits
from app.store import load_trips

from conftest import CLIENT_ID, TENANT, _claims, _sign


def _uuid() -> str:
    trip = load_trips()[0]
    assert trip.id, "trip data has no id field"
    return trip.id


def _private_uuid() -> str:
    for tr in load_trips():
        if tr.visibility == "private":
            return tr.id
    raise AssertionError("no private trip in fixtures")


def _public_trip():
    for tr in load_trips():
        if tr.visibility == "public":
            return tr
    raise AssertionError("no public trip")


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


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    """The booklet limiter is per-client and process-global; TestClient is
    always the same client. Without this, one test's requests spend another
    test's budget and the failure depends on collection order."""
    reset_rate_limits()
    yield
    reset_rate_limits()


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
    r = client.get(f"/api/trips/{_private_uuid()}")
    assert r.status_code == 401


def test_protected_rejects_invalid_token(client: TestClient, rsa_keypair) -> None:
    bad = _sign(rsa_keypair, _claims(exp=int(time.time()) - 60))
    r = client.get(f"/api/trips/{_private_uuid()}", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


def test_protected_forbidden_without_role(client: TestClient, rsa_keypair, role) -> None:
    role(None)
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_private_uuid()}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_protected_forbidden_below_min_role(client: TestClient, rsa_keypair, role) -> None:
    # follower is below viewer, but follower+ can now read private (#65) — so this should 200.
    # To exercise 403 we need no role at all.
    role(None)
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_private_uuid()}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_protected_ok_with_role(client: TestClient, rsa_keypair, role) -> None:
    role("viewer")
    token = _token_of(rsa_keypair)
    pid = _private_uuid()
    r = client.get(f"/api/trips/{pid}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == pid
    assert body["slug"]
    assert "claimToken" not in body  # the claim secret never ships in documents
    assert body["visibility"] == "private"
    assert body["myRole"] == "viewer"  # caller's role reported on the protected path


def test_private_readable_by_follower(client: TestClient, rsa_keypair, role) -> None:
    """#65: follower is the LOWEST role that can read a private trip."""
    role("follower")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_private_uuid()}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["myRole"] == "follower"


def test_protected_404_unknown_trip(client: TestClient, rsa_keypair, role) -> None:
    role("viewer")
    token = _token_of(rsa_keypair)
    unknown = "00000000-0000-4000-8000-000000000000"
    r = client.get(f"/api/trips/{unknown}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 404


def test_public_token_route_still_anonymous(client: TestClient) -> None:
    trip = _public_trip()
    r = client.get(f"/api/trips/{trip.id}")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == trip.slug
    assert body["visibility"] == "public"
    assert "claimToken" not in body  # never leaked on the anonymous route


def test_public_token_route_ignores_bad_auth(client: TestClient, rsa_keypair) -> None:
    trip = _public_trip()
    bad = _sign(rsa_keypair, _claims(exp=int(time.time()) - 60))
    r = client.get(
        f"/api/trips/{trip.id}",
        headers={"Authorization": f"Bearer {bad}"},
    )
    assert r.status_code == 200  # anonymous-by-link: auth header is irrelevant


# ------------------------------------------------------------- my trips (#7)


def test_my_trips_requires_token(client: TestClient) -> None:
    r = client.get("/api/trips")
    assert r.status_code == 401


def test_my_trips_local_mode_lists_all(client: TestClient, rsa_keypair) -> None:
    # Graph is not configured in tests → store returns every baked trip.
    token = _token_of(rsa_keypair)
    r = client.get("/api/trips", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    trips = r.json()["trips"]
    assert len(trips) == len(load_trips())
    first = trips[0]
    assert first["dtId"]
    assert first["title"]
    assert "visibility" in first


def test_my_trips_role_from_graph(
    client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Graph mode: summaries carry the caller's role from the hasCrew edge."""
    fake_rows = [
        {
            "dtId": "t-1",
            "token": "tok",
            "title": "T1",
            "subtitle": "s",
            "stage": "booked",
            "startDate": "2027-02-15",
            "endDate": "2027-03-02",
            "slug": "t1",
            "cover": "/media/t1/c.jpg",
            "role": "owner",
        }
    ]
    monkeypatch.setattr("app.main.list_trips_for_user", lambda sub: fake_rows)
    token = _token_of(rsa_keypair)
    r = client.get("/api/trips", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    trips = r.json()["trips"]
    assert len(trips) == 1
    assert trips[0]["role"] == "owner"
    assert trips[0]["dtId"] == "t-1"


# ---------------------------------------------------------------- booklet


def test_booklet_requires_auth(client: TestClient) -> None:
    r = client.get(f"/api/trips/{_private_uuid()}/booklet.pdf")
    assert r.status_code == 401


def test_booklet_forbidden_without_role(client: TestClient, rsa_keypair, role) -> None:
    role(None)  # no hasCrew edge
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_private_uuid()}/booklet.pdf", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_booklet_renders_with_role(
    client: TestClient, rsa_keypair, role, monkeypatch: pytest.MonkeyPatch
) -> None:
    role("viewer")
    captured: dict = {}
    async def fake_render(base_url, key, out_path, access_token=None):
        captured["key"] = key
        captured["token"] = access_token
        out_path.write_bytes(b"%PDF-fake")
    monkeypatch.setattr("app.main.render_booklet_pdf", fake_render)
    token = _token_of(rsa_keypair)
    trip = load_trips()[0]
    r = client.get(
        f"/api/trips/{trip.id}/booklet.pdf",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF-")
    assert captured["key"] == trip.id
    assert captured["token"] == token


def test_booklet_public_trip_is_anonymous(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#64: a public trip's booklet needs no account — the id IS the link.

    Pinned deliberately: this is the one path that reaches the 40s/2GiB
    renderer with no credential, so a change here should break a test.
    """
    async def fake_render(base_url, key, out_path, access_token=None):
        out_path.write_bytes(b"%PDF-fake")

    monkeypatch.setattr("app.main.render_booklet_pdf", fake_render)
    trip = _public_trip()
    r = client.get(f"/api/trips/{trip.id}/booklet.pdf")
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF-")


def test_booklet_rate_limited(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A render is the most expensive request the pod serves and the public
    path is unauthenticated, so one client cannot loop it."""
    renders = {"n": 0}

    async def fake_render(base_url, key, out_path, access_token=None):
        renders["n"] += 1
        out_path.write_bytes(b"%PDF-fake")

    monkeypatch.setattr("app.main.render_booklet_pdf", fake_render)
    url = f"/api/trips/{_public_trip().id}/booklet.pdf"
    for _ in range(5):
        assert client.get(url).status_code == 200
    assert client.get(url).status_code == 429
    assert renders["n"] == 5  # the 429 never reached the renderer


# ------------------------------------------------------------- #58 pdf render bypass


def test_pdf_render_flag_constant() -> None:
    """Bug #58: the renderer flags the page so TripLayout skips its UI auth gate."""
    import app.pdf as pdf

    assert pdf._PDF_RENDER_FLAG == "window.__KISEKI_PDF_RENDER__ = true;"
    assert "__KISEKI_PDF_RENDER__" in pdf._PDF_RENDER_FLAG


def test_pdf_module_has_no_auth0_seed(monkeypatch) -> None:
    """Bug #58: the auth0 cache-seed approach was removed; the renderer no longer
    imports AUTH0_CLIENT_ID/AUTH0_AUDIENCE or defines _auth0_cache_seed."""
    import app.pdf as pdf

    assert not hasattr(pdf, "_auth0_cache_seed")
    assert not hasattr(pdf, "AUTH0_CLIENT_ID")
    assert not hasattr(pdf, "AUTH0_AUDIENCE")
    assert not hasattr(pdf, "_AUTH0_SCOPE")


def test_spa_route_injects_access_token(client: TestClient) -> None:
    """Bug #58: the /t/<key> catch-all injects the Bearer token from the
    Authorization header as window.__KISEKI_ACCESS_TOKEN__ in the HTML shell,
    so the SPA can attach it to API fetches without Auth0 login."""
    # Requires the built SPA to be present (STATIC_DIR/index.html).
    from app.config import STATIC_DIR
    if not (STATIC_DIR / "index.html").is_file():
        pytest.skip("built SPA not present (CI without frontend build)")

    r = client.get("/t/test-123/booklet", headers={"Authorization": "Bearer eyJhbGciOi.eyJzdWIiOiJhYmMifQ.fake-sig"})
    # 200 (HTML shell) — the trip route catch-all always serves the shell.
    assert r.status_code == 200
    assert "window.__KISEKI_ACCESS_TOKEN__" in r.text
    assert "eyJhbGciOi" in r.text
    # The token must be inside a <script>, not dangling in <title> plain text.
    assert "<title>eyJ" not in r.text


# ---------------------------------------------------------------- join link


def test_join_link_requires_token(client: TestClient) -> None:
    r = client.get(f"/api/trips/{_private_uuid()}/join-link")
    assert r.status_code == 401


def test_join_link_forbidden_for_viewer(client: TestClient, rsa_keypair, role) -> None:
    role("viewer")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_private_uuid()}/join-link", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_join_link_ok_for_owner(client: TestClient, rsa_keypair, role) -> None:
    role("owner")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/trips/{_private_uuid()}/join-link", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["joinUrl"].startswith("/join/")
    assert len(body["joinUrl"]) > len("/join/")
