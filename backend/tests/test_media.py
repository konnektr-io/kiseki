"""Media route + storage tests (issue #47 — media out of the repo, into Garage).

The route must behave identically whichever store backs it: serve bytes with a
correct content-type, 404 on a miss, and NEVER follow a traversal outside the
trip namespace. LocalMediaStore exercises the real code path in CI (no bucket);
S3MediaStore wiring is tested with a stubbed client (no network).
"""

from __future__ import annotations

import hashlib
import re

import pytest
from fastapi.testclient import TestClient

from app import config
from app import media as media_mod
from app.main import app
from app.media import (
    LocalMediaStore,
    S3MediaStore,
    content_addressed_key,
    is_valid_media_path,
    media_content_type,
)

client = TestClient(app)

JPEG = b"\xff\xd8\xff\xe0" + (b"\x42" * 2048) + b"\xff\xd9"


def _write_asset(root, trip: str, name: str, data: bytes = JPEG):
    d = root / trip
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)
    return root


@pytest.fixture(autouse=True)
def _media_env(monkeypatch):
    """Isolate the media store: no S3, and a real but EMPTY assets dir by default.

    ``config`` attrs are read at store-build time (app/media.py imports the
    config *module*), so monkeypatching attributes — not env vars — is what
    switches backends. The store is cached module-wide; clear it per test.
    """
    media_mod.clear_media_store()
    monkeypatch.setattr(config, "KISEKI_S3_ENDPOINT", "")
    monkeypatch.setattr(config, "KISEKI_S3_BUCKET", "")
    monkeypatch.setattr(config, "KISEKI_S3_ACCESS_KEY", "")
    monkeypatch.setattr(config, "KISEKI_S3_SECRET_KEY", "")
    yield
    media_mod.clear_media_store()


def _s3_env(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "KISEKI_S3_ENDPOINT", "http://garage:3900")
    monkeypatch.setattr(config, "KISEKI_S3_BUCKET", "kiseki")
    monkeypatch.setattr(config, "KISEKI_S3_ACCESS_KEY", "access")
    monkeypatch.setattr(config, "KISEKI_S3_SECRET_KEY", "secret")
    # Even a present local dir must NOT win when S3 is configured.
    monkeypatch.setattr(config, "ASSETS_DIR", tmp_path)


# --------------------------------------------------------------------------- #
# Local store → route
# --------------------------------------------------------------------------- #


def test_media_served_from_local_store(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, "canada-2027", "pic.jpg"))
    r = client.get("/media/canada-2027/pic.jpg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == JPEG
    assert "max-age" in r.headers.get("cache-control", "")


def test_media_content_type_by_extension(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, "canada-2027", "map.png"))
    r = client.get("/media/canada-2027/map.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_media_404_on_missing_file(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, "canada-2027", "pic.jpg"))
    r = client.get("/media/canada-2027/not-here.jpg")
    assert r.status_code == 404


def test_media_404_when_no_store_configured(tmp_path, monkeypatch) -> None:
    # ASSETS_DIR points at a directory that does not exist → no store → 404
    # (the repo ships no assets; without the bucket the route must not 500).
    monkeypatch.setattr(config, "ASSETS_DIR", tmp_path / "does-not-exist")
    r = client.get("/media/canada-2027/pic.jpg")
    assert r.status_code == 404


def test_media_404_on_bad_trip_slug(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, "canada-2027", "pic.jpg"))
    for bad in ("Canada-2027", "canada_2027", "canada..2027", "canada/2027"):
        r = client.get(f"/media/{bad}/pic.jpg")
        assert r.status_code == 404, bad


def test_media_rejects_traversal(tmp_path, monkeypatch) -> None:
    # A secret OUTSIDE the assets root that traversal must never reach.
    secret = tmp_path / "secret.jpg"
    secret.write_bytes(b"TOP-SECRET-BYTES")
    assets = tmp_path / "assets"
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(assets, "canada-2027", "pic.jpg"))
    for url in (
        "/media/canada-2027/..%2F..%2Fsecret.jpg",  # encoded slash traversal
        "/media/canada-2027/%2e%2e%2f%2e%2e%2fsecret.jpg",
        "/media/..%2F..%2Fsecret.jpg/x.jpg",  # traversal in the trip segment
    ):
        r = client.get(url)
        assert r.status_code == 404, url
        assert b"TOP-SECRET-BYTES" not in r.content, url


# --------------------------------------------------------------------------- #
# S3 store → route (stubbed client; no network)
# --------------------------------------------------------------------------- #


def test_s3_store_wins_over_local_dir(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, "canada-2027", "pic.jpg"))
    _s3_env(monkeypatch, tmp_path)
    store = media_mod.get_media_store()
    assert isinstance(store, S3MediaStore)
    assert store.bucket == "kiseki"


def test_s3_store_maps_nosuchkey_to_none() -> None:
    from minio.error import S3Error

    store = S3MediaStore("http://garage:3900", "kiseki", "access", "secret")

    class _FakeClient:
        def get_object(self, bucket, key):  # noqa: ARG002 - stub signature
            raise S3Error(None, "NoSuchKey", "no such object", "obj", "rid", "hid", "kiseki", key)

    store._client = _FakeClient()  # type: ignore[attr-defined]
    assert store.get("canada-2027/<beef>.jpg".replace("<beef>", "a" * 32)) is None


def test_media_route_with_s3_store_miss_and_hit(tmp_path, monkeypatch) -> None:
    _s3_env(monkeypatch, tmp_path)
    store = media_mod.get_media_store()
    assert isinstance(store, S3MediaStore)
    monkeypatch.setattr(store, "get", lambda key: None)
    assert client.get("/media/canada-2027/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg").status_code == 404
    monkeypatch.setattr(store, "get", lambda key: iter([JPEG[:512], JPEG[512:]]))
    r = client.get("/media/canada-2027/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == JPEG


# --------------------------------------------------------------------------- #
# Units
# --------------------------------------------------------------------------- #


def test_content_addressed_key() -> None:
    k1 = content_addressed_key(b"abc", ".JPG")
    assert k1 == hashlib.sha256(b"abc").hexdigest()[:32] + ".jpg"
    # idempotent + unguessable-ish (32 hex chars, no original name)
    assert content_addressed_key(b"abc", ".jpg") == k1
    assert content_addressed_key(b"abd", ".jpg") != k1
    assert re.fullmatch(r"[0-9a-f]{32}\.jpg", k1)


def test_is_valid_media_path() -> None:
    assert is_valid_media_path("canada-2027", "a" * 32 + ".jpg")
    assert is_valid_media_path("japan-campervan-2028", "legacy-name_2.png")
    assert not is_valid_media_path("Canada-2027", "x.jpg")  # uppercase slug
    assert not is_valid_media_path("canada-2027", "..")
    assert not is_valid_media_path("canada-2027", "../secret.jpg")
    assert not is_valid_media_path("canada-2027", "a/b.jpg")
    assert not is_valid_media_path("..", "x.jpg")
    assert not is_valid_media_path("canada-2027", "x" * 300 + ".jpg")  # too long


def test_local_store_never_escapes_root(tmp_path) -> None:
    _write_asset(tmp_path, "canada-2027", "pic.jpg")
    store = LocalMediaStore(tmp_path)
    assert store.get("canada-2027/pic.jpg") is not None
    assert store.get("canada-2027/missing.jpg") is None
    assert store.get("canada-2027/../../secret.jpg") is None
    # a real file that traversal would reach, outside root → still None
    (tmp_path.parent / "secret.jpg").write_bytes(b"x")
    assert store.get("../secret.jpg") is None


def test_media_content_type_map() -> None:
    assert media_content_type("x.jpg") == "image/jpeg"
    assert media_content_type("x.jpeg") == "image/jpeg"
    assert media_content_type("x.png") == "image/png"
    assert media_content_type("x.webp") == "image/webp"
    assert media_content_type("x.unknown") == "application/octet-stream"
