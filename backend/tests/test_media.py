"""Media route + storage tests (issue #47 — media out of the repo, into Garage).

The route must behave identically whichever store backs it: serve bytes with a
correct content-type, 404 on a miss, and NEVER follow a traversal outside the
trip namespace. Media URLs are namespaced by the trip's ``$dtId`` (dashed
UUID) — never the repo-folder slug — and the data stores bare filenames that
the API canonicalizes (``canonicalize_media`` / ``resolve_media_urls``).
LocalMediaStore exercises the real code path in CI (no bucket); S3MediaStore
wiring is tested with a stubbed client (no network).
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
    canonicalize_media,
    content_addressed_key,
    is_valid_media_path,
    is_video_name,
    media_content_type,
    poster_name_for,
    resolve_media_urls,
)

client = TestClient(app)

JPEG = b"\xff\xd8\xff\xe0" + (b"\x42" * 2048) + b"\xff\xd9"

# A trip $dtId (dashed UUID) — the ONLY valid media namespace.
TRIP = "bf29a027-2ed2-46b3-b869-d9d81bbcf237"


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
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, TRIP, "pic.jpg"))
    r = client.get(f"/media/{TRIP}/pic.jpg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == JPEG
    assert "max-age" in r.headers.get("cache-control", "")


def test_media_content_type_by_extension(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, TRIP, "map.png"))
    r = client.get(f"/media/{TRIP}/map.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_media_404_on_missing_file(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, TRIP, "pic.jpg"))
    r = client.get(f"/media/{TRIP}/not-here.jpg")
    assert r.status_code == 404


def test_media_404_when_no_store_configured(tmp_path, monkeypatch) -> None:
    # ASSETS_DIR points at a directory that does not exist → no store → 404
    # (the repo ships no assets; without the bucket the route must not 500).
    monkeypatch.setattr(config, "ASSETS_DIR", tmp_path / "does-not-exist")
    r = client.get(f"/media/{TRIP}/pic.jpg")
    assert r.status_code == 404


def test_media_404_on_non_uuid_trip(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, TRIP, "pic.jpg"))
    # Slugs (and other non-UUID segments) are NOT a valid media namespace.
    for bad in ("canada-2027", "Canada-2027", "canada_2027", "not-a-uuid", ".."):
        r = client.get(f"/media/{bad}/pic.jpg")
        assert r.status_code == 404, bad


def test_media_rejects_traversal(tmp_path, monkeypatch) -> None:
    # A secret OUTSIDE the assets root that traversal must never reach.
    secret = tmp_path / "secret.jpg"
    secret.write_bytes(b"TOP-SECRET-BYTES")
    assets = tmp_path / "assets"
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(assets, TRIP, "pic.jpg"))
    for url in (
        f"/media/{TRIP}/..%2F..%2Fsecret.jpg",  # encoded slash traversal
        f"/media/{TRIP}/%2e%2e%2f%2e%2e%2fsecret.jpg",
        "/media/..%2F..%2Fsecret.jpg/x.jpg",  # traversal in the trip segment
    ):
        r = client.get(url)
        assert r.status_code == 404, url
        assert b"TOP-SECRET-BYTES" not in r.content, url


# --------------------------------------------------------------------------- #
# S3 store → route (stubbed client; no network)
# --------------------------------------------------------------------------- #


def test_s3_store_wins_over_local_dir(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSETS_DIR", _write_asset(tmp_path, TRIP, "pic.jpg"))
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
    assert store.get(f"{TRIP}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg") is None


def test_media_route_with_s3_store_miss_and_hit(tmp_path, monkeypatch) -> None:
    _s3_env(monkeypatch, tmp_path)
    store = media_mod.get_media_store()
    assert isinstance(store, S3MediaStore)
    # The route stats the object before streaming it (#250: it needs the size
    # to advertise ``Accept-Ranges``/``Content-Length``), so a miss is a 404
    # without ever asking for bytes.
    monkeypatch.setattr(store, "stat", lambda key: None)
    monkeypatch.setattr(store, "get", lambda key: None)
    assert client.get(f"/media/{TRIP}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg").status_code == 404
    # A hit streams the object and advertises its length.
    monkeypatch.setattr(store, "stat", lambda key: len(JPEG))
    monkeypatch.setattr(store, "get", lambda key: iter([JPEG[:512], JPEG[512:]]))
    r = client.get(f"/media/{TRIP}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["content-length"] == str(len(JPEG))
    assert r.headers["accept-ranges"] == "bytes"
    assert r.content == JPEG


def test_media_route_range_is_read_by_the_store(tmp_path, monkeypatch) -> None:
    """A ranged read is handed to the store as an OFFSET (#250).

    The route must never pull the whole object and slice it: seeking in a 1 GB
    clip has to cost the window the player asked for.
    """
    _s3_env(monkeypatch, tmp_path)
    store = media_mod.get_media_store()
    assert isinstance(store, S3MediaStore)
    monkeypatch.setattr(store, "stat", lambda key: len(JPEG))
    seen: dict[str, object] = {}

    def fake_get(key: str, start: int = 0, length: int = 0):
        seen["key"], seen["start"], seen["length"] = key, start, length
        return iter([JPEG[start : start + length]])

    monkeypatch.setattr(store, "get", fake_get)
    r = client.get(
        f"/media/{TRIP}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg",
        headers={"Range": "bytes=100-199"},
    )
    assert r.status_code == 206
    assert r.content == JPEG[100:200]
    assert seen["start"] == 100
    assert seen["length"] == 100
    assert r.headers["content-range"] == f"bytes 100-199/{len(JPEG)}"


# --------------------------------------------------------------------------- #
# Canonicalization (bare filename in data → full /media/<trip_id>/ URL)
# --------------------------------------------------------------------------- #


def test_canonicalize_media() -> None:
    # bare filename (the data model) → canonical URL
    assert canonicalize_media("c383ce57efd5352cdca819c8dfdc99de.jpg", TRIP) == (
        f"/media/{TRIP}/c383ce57efd5352cdca819c8dfdc99de.jpg"
    )
    # legacy slug path → canonical id URL
    assert canonicalize_media("/media/canada-2027/pic.png", TRIP) == f"/media/{TRIP}/pic.png"
    # already canonical → unchanged
    assert canonicalize_media(f"/media/{TRIP}/pic.png", TRIP) == f"/media/{TRIP}/pic.png"
    # non-media strings pass through untouched
    assert canonicalize_media("https://example.com/x.jpg", TRIP) == "https://example.com/x.jpg"
    assert canonicalize_media("plain text", TRIP) == "plain text"
    assert canonicalize_media("", TRIP) == ""
    assert canonicalize_media("/media/canada-2027/nested/dir.jpg", TRIP) == "/media/canada-2027/nested/dir.jpg"


def test_resolve_media_urls_walks_the_schema() -> None:
    doc = {
        "id": TRIP,
        "cover": "c383ce57efd5352cdca819c8dfdc99de.jpg",
        "map": "/media/canada-2027/bc7dbbb86ad7a11bb62d8c1d00ce4a75.png",
        "summary": "text with **markdown** and no media",
        "features": [
            {
                "kicker": "X",
                "image": "legacy-name_2.png",
                "images": ["a.jpg", "https://ext.example/b.jpg"],
                "map": True,  # bool must survive untouched
                "cards": [{"title": "c", "image": "card.jpg"}],
            }
        ],
        "days": [
            {
                "map": "daymap.png",
                "blocks": [
                    {"kind": "activity", "images": ["block1.jpg"]},
                    {"kind": "gallery", "items": ["g1.jpg", "/media/canada-2027/g2.png"]},
                    {"kind": "todo", "items": [{"label": "buy", "done": False}]},
                ],
            }
        ],
        "crew": [{"name": "Niko"}],
    }
    out = resolve_media_urls(doc, TRIP)
    assert isinstance(out, dict)  # narrows dict | list for the checker
    assert out["cover"] == f"/media/{TRIP}/c383ce57efd5352cdca819c8dfdc99de.jpg"
    assert out["map"] == f"/media/{TRIP}/bc7dbbb86ad7a11bb62d8c1d00ce4a75.png"
    assert out["summary"] == "text with **markdown** and no media"
    feat = out["features"][0]
    assert feat["image"] == f"/media/{TRIP}/legacy-name_2.png"
    assert feat["images"] == [f"/media/{TRIP}/a.jpg", "https://ext.example/b.jpg"]
    assert feat["map"] is True
    assert feat["cards"][0]["image"] == f"/media/{TRIP}/card.jpg"
    day = out["days"][0]
    assert day["map"] == f"/media/{TRIP}/daymap.png"
    assert day["blocks"][0]["images"] == [f"/media/{TRIP}/block1.jpg"]
    gallery = day["blocks"][1]
    assert gallery["items"] == [f"/media/{TRIP}/g1.jpg", f"/media/{TRIP}/g2.png"]
    todo = day["blocks"][2]
    assert todo["items"] == [{"label": "buy", "done": False}]  # untouched


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
    assert is_valid_media_path(TRIP, "a" * 32 + ".jpg")
    assert is_valid_media_path(TRIP, "legacy-name_2.png")
    # only dashed-UUID trip segments are valid — slugs are not
    assert not is_valid_media_path("canada-2027", "a" * 32 + ".jpg")
    assert not is_valid_media_path("Canada-2027", "x.jpg")
    assert not is_valid_media_path(TRIP, "..")
    assert not is_valid_media_path(TRIP, "../secret.jpg")
    assert not is_valid_media_path(TRIP, "a/b.jpg")
    assert not is_valid_media_path("..", "x.jpg")
    assert not is_valid_media_path(TRIP, "x" * 300 + ".jpg")  # too long


def test_local_store_never_escapes_root(tmp_path) -> None:
    _write_asset(tmp_path, TRIP, "pic.jpg")
    store = LocalMediaStore(tmp_path)
    assert store.get(f"{TRIP}/pic.jpg") is not None
    assert store.get(f"{TRIP}/missing.jpg") is None
    assert store.get(f"{TRIP}/../../secret.jpg") is None
    # a real file that traversal would reach, outside root → still None
    (tmp_path.parent / "secret.jpg").write_bytes(b"x")
    assert store.get("../secret.jpg") is None


def test_media_content_type_map() -> None:
    assert media_content_type("x.jpg") == "image/jpeg"
    assert media_content_type("x.jpeg") == "image/jpeg"
    assert media_content_type("x.png") == "image/png"
    assert media_content_type("x.webp") == "image/webp"
    assert media_content_type("x.unknown") == "application/octet-stream"


# --------------------------------------------------------------------------- #
# Video: content type, byte ranges, poster convention (#250)
# --------------------------------------------------------------------------- #

# Deterministic bytes, so every slice below is checkable by content.
VIDEO = bytes(range(256)) * 8  # 2048 bytes


def _video_asset(tmp_path, monkeypatch, name: str = "clip.mp4", data: bytes = VIDEO):
    monkeypatch.setattr(
        config, "ASSETS_DIR", _write_asset(tmp_path, TRIP, name, data)
    )


def test_media_content_type_map_video() -> None:
    """A clip's extension decides its type.

    Served as ``application/octet-stream`` a video is bytes the browser will
    not play — which is why no surface could render one before (#250).
    """
    assert media_content_type("clip.mp4") == "video/mp4"
    assert media_content_type("clip.MOV") == "video/quicktime"
    assert media_content_type("clip.m4v") == "video/x-m4v"
    assert media_content_type("clip.webm") == "video/webm"


def test_video_name_and_poster_convention() -> None:
    """One convention, derived from the video's own name (#250).

    No poster field exists in the data model: every surface derives
    ``<stem>_poster.jpg`` from the video URL, so there is never a second
    reference to keep in sync — and nothing to migrate.
    """
    assert is_video_name("a" * 32 + ".mp4")
    assert is_video_name("clip.MOV")
    assert not is_video_name("a" * 32 + ".jpg")
    assert not is_video_name("clip")
    assert poster_name_for("abc.mp4") == "abc_poster.jpg"
    assert poster_name_for("a" * 32 + ".webm") == "a" * 32 + "_poster.jpg"


def test_bare_video_name_canonicalizes_to_media_url() -> None:
    """A video stored as a BARE filename has to reach its /media URL.

    Trip documents keep bare filenames; every surface renders what
    ``resolve_media_urls`` emits. While video extensions were missing from the
    bare-name pattern, an attached clip stayed a bare string and was invisible
    on every surface — the second half of #250.
    """
    name = "a" * 32 + ".mp4"
    assert canonicalize_media(name, TRIP) == f"/media/{TRIP}/{name}"
    assert canonicalize_media(name, TRIP).endswith(".mp4")
    # …as does the poster frame, from the video's name alone.
    poster = "a" * 32 + "_poster.jpg"
    assert canonicalize_media(poster, TRIP) == f"/media/{TRIP}/{poster}"
    # a name with no media extension is prose, not media: untouched.
    assert canonicalize_media("not-a-file", TRIP) == "not-a-file"


def test_media_video_full_body_advertises_ranges(tmp_path, monkeypatch) -> None:
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4")
    assert r.status_code == 200
    assert r.content == VIDEO
    assert r.headers["content-type"] == "video/mp4"
    assert r.headers["content-length"] == str(len(VIDEO))
    assert r.headers["accept-ranges"] == "bytes"


def test_media_video_first_range_is_206(tmp_path, monkeypatch) -> None:
    """The request a <video> makes to start playing: bytes 0-N."""
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.content == VIDEO[:100]
    assert r.headers["content-range"] == f"bytes 0-99/{len(VIDEO)}"
    assert r.headers["content-length"] == "100"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "video/mp4"


def test_media_video_open_ended_and_suffix_ranges(tmp_path, monkeypatch) -> None:
    """`bytes=100-` is what a player resumes with; `bytes=-48` is its tail."""
    _video_asset(tmp_path, monkeypatch)
    rest = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=2000-"})
    assert rest.status_code == 206
    assert rest.content == VIDEO[2000:]
    assert rest.headers["content-range"] == f"bytes 2000-{len(VIDEO) - 1}/{len(VIDEO)}"

    tail = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=-48"})
    assert tail.status_code == 206
    assert tail.content == VIDEO[-48:]
    assert tail.headers["content-range"] == f"bytes {len(VIDEO) - 48}-{len(VIDEO) - 1}/{len(VIDEO)}"


def test_media_video_range_past_end_is_416(tmp_path, monkeypatch) -> None:
    """Seeking past the end must say so, not serve an empty 200."""
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=999999-"})
    assert r.status_code == 416
    assert r.headers["content-range"] == f"bytes */{len(VIDEO)}"


def test_media_multipart_range_serves_the_whole_object(tmp_path, monkeypatch) -> None:
    """A range set we do not implement gets the full body, never half of it."""
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=0-9,20-29"})
    assert r.status_code == 200
    assert r.content == VIDEO


def _window(store, key: str, start: int, length: int) -> bytes:
    """Bytes from a windowed ``store.get``, asserting the stream exists."""
    chunks = store.get(key, start=start, length=length)
    assert chunks is not None, "windowed get returned no stream"
    return b"".join(chunks)


def test_local_store_get_reads_a_window(tmp_path) -> None:
    """The window is read where the bytes are — not read whole and sliced."""
    _write_asset(tmp_path, TRIP, "clip.mp4", VIDEO)
    store = LocalMediaStore(tmp_path)
    assert _window(store, f"{TRIP}/clip.mp4", 10, 5) == VIDEO[10:15]
    assert _window(store, f"{TRIP}/clip.mp4", 2040, 100) == VIDEO[2040:]
    # a window that starts past the end yields nothing (the route 416s first)
    assert _window(store, f"{TRIP}/clip.mp4", 9999, 10) == b""
    assert store.get(f"{TRIP}/missing.mp4") is None


# --------------------------------------------------------------------------- #
# Video: content type, byte ranges, poster convention (#250)
# --------------------------------------------------------------------------- #

# Deterministic bytes, so every slice below is checkable by content.
VIDEO = bytes(range(256)) * 8  # 2048 bytes


def _video_asset(tmp_path, monkeypatch, name: str = "clip.mp4", data: bytes = VIDEO):
    monkeypatch.setattr(
        config, "ASSETS_DIR", _write_asset(tmp_path, TRIP, name, data)
    )


def test_media_content_type_map_video() -> None:
    """A clip's extension decides its type.

    Served as ``application/octet-stream`` a video is bytes the browser will
    not play — which is why no surface could render one before (#250).
    """
    assert media_content_type("clip.mp4") == "video/mp4"
    assert media_content_type("clip.MOV") == "video/quicktime"
    assert media_content_type("clip.m4v") == "video/x-m4v"
    assert media_content_type("clip.webm") == "video/webm"


def test_video_name_and_poster_convention() -> None:
    """One convention, derived from the video's own name (#250).

    No poster field exists in the data model: every surface derives
    ``<stem>_poster.jpg`` from the video URL, so there is never a second
    reference to keep in sync — and nothing to migrate.
    """
    assert is_video_name("a" * 32 + ".mp4")
    assert is_video_name("clip.MOV")
    assert not is_video_name("a" * 32 + ".jpg")
    assert not is_video_name("clip")
    assert poster_name_for("abc.mp4") == "abc_poster.jpg"
    assert poster_name_for("a" * 32 + ".webm") == "a" * 32 + "_poster.jpg"


def test_bare_video_name_canonicalizes_to_media_url() -> None:
    """A video stored as a BARE filename has to reach its /media URL.

    Trip documents keep bare filenames; every surface renders what
    ``resolve_media_urls`` emits. While video extensions were missing from the
    bare-name pattern, an attached clip stayed a bare string and was invisible
    on every surface — the second half of #250.
    """
    name = "a" * 32 + ".mp4"
    assert canonicalize_media(name, TRIP) == f"/media/{TRIP}/{name}"
    assert canonicalize_media(name, TRIP).endswith(".mp4")
    # …as does the poster frame, from the video's name alone.
    poster = "a" * 32 + "_poster.jpg"
    assert canonicalize_media(poster, TRIP) == f"/media/{TRIP}/{poster}"
    # a name with no media extension is prose, not media: untouched.
    assert canonicalize_media("not-a-file", TRIP) == "not-a-file"


def test_media_video_full_body_advertises_ranges(tmp_path, monkeypatch) -> None:
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4")
    assert r.status_code == 200
    assert r.content == VIDEO
    assert r.headers["content-type"] == "video/mp4"
    assert r.headers["content-length"] == str(len(VIDEO))
    assert r.headers["accept-ranges"] == "bytes"


def test_media_video_first_range_is_206(tmp_path, monkeypatch) -> None:
    """The request a <video> makes to start playing: bytes 0-N."""
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.content == VIDEO[:100]
    assert r.headers["content-range"] == f"bytes 0-99/{len(VIDEO)}"
    assert r.headers["content-length"] == "100"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "video/mp4"


def test_media_video_open_ended_and_suffix_ranges(tmp_path, monkeypatch) -> None:
    """`bytes=100-` is what a player resumes with; `bytes=-48` is its tail."""
    _video_asset(tmp_path, monkeypatch)
    rest = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=2000-"})
    assert rest.status_code == 206
    assert rest.content == VIDEO[2000:]
    assert rest.headers["content-range"] == f"bytes 2000-{len(VIDEO) - 1}/{len(VIDEO)}"

    tail = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=-48"})
    assert tail.status_code == 206
    assert tail.content == VIDEO[-48:]
    assert tail.headers["content-range"] == f"bytes {len(VIDEO) - 48}-{len(VIDEO) - 1}/{len(VIDEO)}"


def test_media_video_range_past_end_is_416(tmp_path, monkeypatch) -> None:
    """Seeking past the end must say so, not serve an empty 200."""
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=999999-"})
    assert r.status_code == 416
    assert r.headers["content-range"] == f"bytes */{len(VIDEO)}"


def test_media_multipart_range_serves_the_whole_object(tmp_path, monkeypatch) -> None:
    """A range set we do not implement gets the full body, never half of it."""
    _video_asset(tmp_path, monkeypatch)
    r = client.get(f"/media/{TRIP}/clip.mp4", headers={"Range": "bytes=0-9,20-29"})
    assert r.status_code == 200
    assert r.content == VIDEO


def _window(store, key: str, start: int, length: int) -> bytes:
    """Bytes from a windowed ``store.get``, asserting the stream exists."""
    chunks = store.get(key, start=start, length=length)
    assert chunks is not None, "windowed get returned no stream"
    return b"".join(chunks)


def test_local_store_get_reads_a_window(tmp_path) -> None:
    """The window is read where the bytes are — not read whole and sliced."""
    _write_asset(tmp_path, TRIP, "clip.mp4", VIDEO)
    store = LocalMediaStore(tmp_path)
    assert _window(store, f"{TRIP}/clip.mp4", 10, 5) == VIDEO[10:15]
    assert _window(store, f"{TRIP}/clip.mp4", 2040, 100) == VIDEO[2040:]
    # a window that starts past the end yields nothing (the route 416s first)
    assert _window(store, f"{TRIP}/clip.mp4", 9999, 10) == b""
    assert store.get(f"{TRIP}/missing.mp4") is None
