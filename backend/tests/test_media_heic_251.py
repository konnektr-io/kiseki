"""HEIC photo ingest (#251) — a photo is never accepted and then invisible.

Root cause 3 of the issue: an iPhone photo (HEIC/HEIF) went through
``POST /api/files`` untouched, was stored under its ``.heic`` name, served as
``application/octet-stream`` and rendered nowhere. The photo had been
attached and the user could not see it — the exact "I uploaded way more than
8 and only 8 showed up" experience.

What this file pins down:

- ``app.media.normalize_upload`` turns HEIC bytes into a JPEG and says so
  (``converted=True``); every other upload passes through byte-identical.
- A HEIC is recognised by *content* as well as by extension: a photo saved as
  ``IMG_0001.jpg`` whose bytes are HEIC is the same unrenderable file.
- A file that cannot be stored in a displayable form raises
  ``UnsupportedUpload`` → per-file 422 naming it, never accept-and-drop.
- ``POST /api/files`` stores a HEIC as ``<sha256[:32]>.jpg`` and returns
  ``contentType: image/jpeg`` for both the trip and the inbox path, so the
  URL the SPA puts into the next chat message is renderable.
- EXIF (capture time + GPS) survives the transcode — the photo-placement path
  (#190) reads it back from the STORED bytes, so a HEIC batch still lands on
  the right day instead of being reported ``undated``.

Route tests run against FakeGraph with the real ACL + store + service code and
a tmp LocalMediaStore, mirroring ``test_photos.py``. The HEIC fixture is
written by pillow-heif itself, so the container carries a real ``ftyp`` brand
and real EXIF — the shape an iPhone upload produces, not a hand-rolled
approximation.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import media as media_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.exif import extract_exif
from app.main import app
from app.media import (
    HEIC_EXTS,
    UnsupportedUpload,
    is_unrenderable_heif,
    media_content_type,
    normalize_upload,
)
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
TAKEN = "2027:02:15 10:00:00"
GPS = (51.1784, -115.5708)


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

    def _make(role: str = "editor") -> FakeGraph:
        g = FakeGraph("canada-2027.graph.anon.json")
        g.add_user_role(g.root, SUB, role)
        monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
        made.append(g)
        return g

    yield _make
    for _ in made:
        store_mod._reset_store_cache()


class _FakeConfig:
    """Point the media store at a tmp dir (mirrors test_photos.py)."""

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


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------------ HEIC builders


def _heic(*, taken: str | None = None, gps: tuple[float, float] | None = None) -> bytes:
    """Real HEIC bytes, written by pillow-heif, carrying capture metadata.

    Uses the same writer iPhone-compatible tooling does, so the fixture has a
    genuine ``ftyp`` box and a genuine EXIF block — the normalizer's content
    detection is exercised on the real thing rather than on a magic prefix.
    """
    from PIL import Image

    import pillow_heif

    pillow_heif.register_heif_opener()

    img = Image.new("RGB", (16, 12), color=(30, 120, 200))
    ex = Image.Exif()
    if taken is not None:
        ex[0x9003] = taken  # DateTimeOriginal
    if gps is not None:
        from PIL.TiffImagePlugin import IFDRational

        lat, lng = gps
        ex[0x8825] = {
            0x0001: "N" if lat >= 0 else "S",
            0x0002: _dms(IFDRational, abs(lat)),
            0x0003: "E" if lng >= 0 else "W",
            0x0004: _dms(IFDRational, abs(lng)),
        }
    buf = io.BytesIO()
    try:
        img.save(buf, format="HEIF", exif=ex)
    except Exception:  # pragma: no cover - writer name differs by release
        pillow_heif.from_pillow(img).save(buf)
    return buf.getvalue()


def _dms(cls, decimal: float) -> tuple:
    """Decimal degrees → EXIF (d, m, s) IFDRationals."""
    d = int(decimal)
    m = int((decimal - d) * 60)
    s = round((((decimal - d) * 60) - m) * 60 * 100)
    return (cls(d, 1), cls(m, 1), cls(s, 100))


def _jpeg() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=(200, 30, 30)).save(buf, format="JPEG")
    return buf.getvalue()


def _is_jpeg(raw: bytes) -> bool:
    return raw[:3] == b"\xff\xd8\xff"


# ------------------------------------------------------------------ unit: normalize_upload


def test_heic_fixture_is_a_heif_container_browsers_cannot_render() -> None:
    """The fixture really is the unrenderable thing the issue describes."""
    raw = _heic(taken=TAKEN)
    assert is_unrenderable_heif(raw) is True
    assert ".heic" in HEIC_EXTS and ".heif" in HEIC_EXTS


def test_normalize_upload_turns_heic_into_a_jpeg() -> None:
    raw = _heic(taken=TAKEN)
    stored, ext, converted = normalize_upload(raw, "IMG_0001.heic")
    assert converted is True
    assert ext == ".jpg"
    assert _is_jpeg(stored)
    assert is_unrenderable_heif(stored) is False
    # The stored name is what gets served, and it must type as an image.
    assert media_content_type(f"abc123{ext}") == "image/jpeg"


def test_normalize_upload_spots_heic_by_content_not_just_extension() -> None:
    """A HEIC saved as `.jpg` is the same unrenderable upload (#251)."""
    raw = _heic()
    stored, ext, converted = normalize_upload(raw, "IMG_0002.jpg")
    assert converted is True
    assert ext == ".jpg"
    assert _is_jpeg(stored)


def test_normalize_upload_leaves_everything_else_byte_identical() -> None:
    raw = _jpeg()
    stored, ext, converted = normalize_upload(raw, "photo.jpg")
    assert (stored, ext, converted) == (raw, ".jpg", False)

    doc = b"%PDF-1.4 not really a pdf"
    assert normalize_upload(doc, "receipt.pdf") == (doc, ".pdf", False)


def test_normalize_upload_keeps_capture_metadata_across_the_transcode() -> None:
    """Placement (#190) reads EXIF from the STORED bytes — so it must survive."""
    stored, _, _ = normalize_upload(_heic(taken=TAKEN, gps=GPS), "IMG_0003.heic")
    info = extract_exif(stored)
    assert info["has_exif"] is True
    assert info["taken_at"] == "2027-02-15T10:00:00"
    assert info["lat"] is not None and abs(info["lat"] - GPS[0]) < 1e-4
    assert info["lng"] is not None and abs(info["lng"] - GPS[1]) < 1e-4


def test_normalize_upload_refuses_what_it_cannot_store() -> None:
    """Refusal is an exception the route turns into a per-file 422."""
    with pytest.raises(UnsupportedUpload) as exc:
        normalize_upload(b"\x00\x00\x00\x18ftypheic" + b"garbage" * 8, "broken.heic")
    assert "broken.heic" in str(exc.value)


def test_normalize_upload_does_not_touch_avif() -> None:
    """AVIF is the HEIF flavour browsers DO render — leave it alone."""
    avif = b"\x00\x00\x00\x20ftypavif" + b"\x00" * 20
    assert is_unrenderable_heif(avif) is False
    assert normalize_upload(avif, "photo.avif") == (avif, ".avif", False)


# ------------------------------------------------------------------ route: POST /api/files


def test_upload_heic_into_a_trip_stores_a_renderable_jpeg(
    client, rsa_keypair, graph, media_store
) -> None:
    g = graph(role="editor")
    trip_id = g.root
    raw = _heic(taken=TAKEN)
    resp = client.post(
        "/api/files",
        data={"trip_id": trip_id},
        files={"file": ("IMG_0004.heic", io.BytesIO(raw), "image/heic")},
        headers=_auth(_token_of(rsa_keypair)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["url"].startswith(f"/media/{trip_id}/")
    assert body["url"].endswith(".jpg")
    assert body["contentType"] == "image/jpeg"
    assert body["converted"] is True
    # The bytes actually on disk are a JPEG — not the HEIC that went in.
    stored = sorted(media_store.rglob("*.jpg"))
    assert stored, "no .jpg object was written"
    assert _is_jpeg(stored[0].read_bytes())
    assert not list(media_store.rglob("*.heic"))


def test_upload_heic_to_the_inbox_is_converted_too(
    client, rsa_keypair, graph, media_store
) -> None:
    """Landing chat: no trip yet, but the same renderable-storage guarantee."""
    graph(role="editor")
    resp = client.post(
        "/api/files",
        files={"file": ("IMG_0005.heic", io.BytesIO(_heic()), "image/heic")},
        headers=_auth(_token_of(rsa_keypair)),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["url"].startswith("/inbox/")
    assert body["url"].endswith(".jpg")
    assert body["contentType"] == "image/jpeg"
    assert body["converted"] is True


def test_uploaded_heic_reports_its_capture_metadata(
    client, rsa_keypair, graph, media_store
) -> None:
    """The batch the user picked still knows when and where it was taken."""
    graph(role="editor")
    resp = client.post(
        "/api/files",
        files={
            "file": (
                "IMG_0006.heic",
                io.BytesIO(_heic(taken=TAKEN, gps=GPS)),
                "image/heic",
            )
        },
        headers=_auth(_token_of(rsa_keypair)),
    )
    assert resp.status_code == 200, resp.text
    info = resp.json()["exif"]
    assert info["has_exif"] is True
    assert info["taken_at"] == "2027-02-15T10:00:00"
    assert info["lat"] is not None


def test_upload_refuses_a_heic_it_cannot_decode(
    client, rsa_keypair, graph, media_store
) -> None:
    """422 naming the file — the user is told, not silently dropped."""
    graph(role="editor")
    resp = client.post(
        "/api/files",
        files={
            "file": (
                "broken.heic",
                io.BytesIO(b"\x00\x00\x00\x18ftypheic" + b"nonsense" * 4),
                "image/heic",
            )
        },
        headers=_auth(_token_of(rsa_keypair)),
    )
    assert resp.status_code == 422, resp.text
    assert "broken.heic" in resp.json()["detail"]


def test_served_heic_upload_has_an_image_content_type(
    client, rsa_keypair, graph, media_store
) -> None:
    """The end of the loss path: the URL the message carries renders.

    Before the fix the object was served as ``application/octet-stream`` and
    displayed nowhere.
    """
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    up = client.post(
        "/api/files",
        data={"trip_id": trip_id},
        files={"file": ("IMG_0007.heic", io.BytesIO(_heic(taken=TAKEN)), "image/heic")},
        headers=_auth(token),
    )
    assert up.status_code == 200, up.text
    served = client.get(up.json()["url"], headers=_auth(token))
    assert served.status_code == 200, served.text
    assert served.headers["content-type"].startswith("image/jpeg")
    assert _is_jpeg(served.content)
