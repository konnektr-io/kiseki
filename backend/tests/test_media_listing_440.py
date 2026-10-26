"""Trip media listing (#440) — the agent's recovery affordance.

``GET /api/trips/{id}/media`` enumerates what the store ACTUALLY holds for
the trip (orphan included) and reports ``referencedBy`` per item, so an
uploaded-but-never-attached photo is recoverable instead of invisible. The
route is editor+ (a listing hands out every capability URL in the namespace
at once), read-only, newest-first, capped.

Route tests run against FakeGraph with the REAL ACL + store code, media
bytes in a tmp LocalMediaStore — the same shape as test_photos.py.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import media as media_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.main import app
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
OTHER = "google-oauth2|999"

JPEG = b"\xff\xd8\xff\xe0" + (b"\x42" * 2048) + b"\xff\xd9"


def _token_of(rsa_keypair, sub: str = SUB) -> str:
    return _sign(rsa_keypair, _claims(sub=sub))


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

    def _make(role: str = "editor", fixture: str = "canada-2027.graph.anon.json") -> FakeGraph:
        g = FakeGraph(fixture)
        g.add_user_role(g.root, SUB, role)
        monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
        made.append(g)
        return g

    yield _make
    for _ in made:
        store_mod._reset_store_cache()


class _FakeConfig:
    """Point the media store at a tmp dir (mirrors test_chat.py)."""

    def __init__(self, root) -> None:
        from app import config as _config

        self.KISEKI_S3_ENDPOINT = None
        self.KISEKI_S3_BUCKET = None
        self.KISEKI_S3_ACCESS_KEY = None
        self.KISEKI_S3_SECRET_KEY = None
        self.KISEKI_S3_REGION = _config.KISEKI_S3_REGION
        self.ASSETS_DIR = root


@pytest.fixture
def media_store(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    yield tmp_path
    media_module.clear_media_store()


def _upload(client: TestClient, token: str, trip_id: str, name: str) -> str:
    """Upload unique bytes (names are content-addressed — same bytes = same key)."""
    raw = JPEG + name.encode() + b"\x00" * (32 - len(name) % 32)
    resp = client.post(
        "/api/files",
        data={"trip_id": trip_id},
        files={"file": (name, io.BytesIO(raw), "image/jpeg")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["name"]


def _get(client: TestClient, token: str, trip_id: str, **params):
    return client.get(
        f"/api/trips/{trip_id}/media",
        params=params or None,
        headers={"Authorization": f"Bearer {token}"},
    )


# --------------------------------------------------------------------------- #
# The recovery contract
# --------------------------------------------------------------------------- #


def test_lists_orphan_and_referenced(client, rsa_keypair, graph, media_store) -> None:
    """An unattached upload shows up with referencedBy []; nothing is hidden."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)

    attached = _upload(client, token, trip_id, "attached.jpg")
    orphan = _upload(client, token, trip_id, "orphan.jpg")
    # Reference one of them in the document (trip cover).
    g.set_twin_prop(trip_id, "cover", attached)

    resp = _get(client, token, trip_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    names = {item["name"]: item for item in body["items"]}
    assert attached in names and orphan in names
    assert names[attached]["referencedBy"] == [trip_id.lower()]
    assert names[orphan]["referencedBy"] == []
    for item in body["items"]:
        assert item["url"].startswith(f"/media/{trip_id.lower()}/")
        assert item["bytes"] > 0
        assert item["contentType"].startswith("image/")
        assert item["uploaded"] is not None


def test_follower_is_forbidden(client, rsa_keypair, graph, media_store) -> None:
    """A listing hands out every capability URL — editor+ only."""
    g = graph(role="follower")
    token = _token_of(rsa_keypair)
    resp = _get(client, token, g.root)
    assert resp.status_code == 403


def test_anonymous_unauthorized(client, graph, media_store) -> None:
    g = graph(role="editor")
    resp = client.get(f"/api/trips/{g.root}/media")
    assert resp.status_code in (401, 403)


def test_unknown_trip_404(client, rsa_keypair, graph, media_store) -> None:
    graph(role="editor")
    resp = _get(client, _token_of(rsa_keypair), "00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


def test_limit_caps_and_sorts(client, rsa_keypair, graph, media_store) -> None:
    """Newest first, capped by limit — a recovery affordance, not a gallery."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    for i in range(4):
        _upload(client, token, trip_id, f"p{i}.jpg")
    resp = _get(client, token, trip_id, limit=2)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["count"] == 2
    assert len(body["items"]) == 2
    uploaded = [item["uploaded"] for item in body["items"]]
    assert uploaded == sorted(uploaded, reverse=True)


def test_no_store_503(client, rsa_keypair, graph) -> None:
    """No configured store → 503, not an empty list pretending all is well."""
    g = graph(role="editor")
    media_module.clear_media_store()
    resp = _get(client, _token_of(rsa_keypair), g.root)
    assert resp.status_code == 503


def test_local_store_list_keys_prefix(media_store) -> None:
    """list_keys enumerates only the asked prefix, with sizes + timestamps."""
    from datetime import datetime, timezone

    from app.media import LocalMediaStore

    (media_store / "trip-a").mkdir()
    (media_store / "trip-a" / "one.jpg").write_bytes(JPEG)
    (media_store / "trip-b").mkdir()
    (media_store / "trip-b" / "two.jpg").write_bytes(JPEG)
    entries = LocalMediaStore(media_store).list_keys("trip-a/")
    assert [e.key for e in entries] == ["trip-a/one.jpg"]
    assert entries[0].size == len(JPEG)
    assert isinstance(entries[0].uploaded, datetime)
    assert entries[0].uploaded.tzinfo is not None
    assert LocalMediaStore(media_store).list_keys("missing/") == []


def test_s3_store_list_keys(monkeypatch) -> None:
    """The S3 listing strips the media/ prefix and passes it through."""
    from app.media import S3MediaStore

    class _Obj:
        def __init__(self, name: str) -> None:
            self.object_name = name
            self.size = 7
            self.last_modified = None

    class _Client:
        def __init__(self) -> None:
            self.seen: list[str] = []

        def list_objects(self, bucket, prefix, recursive=False):
            self.seen.append(prefix)
            assert bucket == "kiseki" and recursive is True
            return [_Obj("media/trip-a/one.jpg")]

    store = S3MediaStore("http://garage:3900", "kiseki", "a", "b")
    monkeypatch.setattr(store, "_client", _Client())
    entries = store.list_keys("trip-a/")
    assert [e.key for e in entries] == ["trip-a/one.jpg"]
    assert store._client.seen == ["media/trip-a/"]
