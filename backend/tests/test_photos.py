"""Photo batch ingest + placement tests (issues #190 / #191).

Bytes in, right day out — with a human confirm in between:

- ``app.exif.extract_exif`` reads DateTimeOriginal + OffsetTimeOriginal
  (fallback CreateDate/DateTimeDigitized, then Image DateTime) and GPS
  lat/lng from uploaded bytes; anything unreadable is ``has_exif: False``,
  never a crash.
- ``POST /api/files`` (trip + inbox paths) reports ``sha256`` + ``exif``
  additively next to the existing ``url``.
- ``POST /api/trips/{id}/photos/propose`` (editor+, read-only) converts each
  photo's timestamp to the TRIP's timezone (#42) and matches date → day,
  then the nearest timed block within ±90 min (``PHOTO_BLOCK_WINDOW_MIN``)
  or day-level; no EXIF or a date outside the trip window → ``undated``.
- ``POST /api/trips/{id}/photos/confirm`` (editor+) is the human-confirmed
  write: block-targeted → ``Block.images`` (A), day-level → a ``gallery``
  block at chronological position (B); ordered by capture time, idempotent
  (re-import = no-op, reported as ``skipped``).

Route tests run against FakeGraph (seeded from the committed anon fixture)
with the REAL ACL + store + service code, like test_write_api.py; media
bytes go to a tmp LocalMediaStore like test_chat.py.
"""

from __future__ import annotations

import hashlib
import io
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module  # noqa: F401  (kept for symmetry with test_chat)
from app import auth as auth_module
from app import media as media_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.exif import extract_exif
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

    def _make(role: str = "owner", fixture: str = "canada-2027.graph.anon.json") -> FakeGraph:
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


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------------ JPEG builders


def _jpeg(
    *,
    taken: str | None = None,
    offset: str | None = None,
    gps: tuple[float, float] | None = None,
) -> bytes:
    """Minimal JPEG bytes, optionally carrying EXIF capture metadata.

    ``taken`` is EXIF DateTimeOriginal (``YYYY:MM:DD HH:MM:SS``),
    ``offset`` the OffsetTimeOriginal (``+HH:MM``), ``gps`` a
    (lat, lng) pair in decimal degrees.
    """
    from PIL import Image

    img = Image.new("RGB", (8, 8), color=(200, 30, 30))
    ex = Image.Exif()
    if taken is not None:
        ex[0x9003] = taken  # DateTimeOriginal
    if offset is not None:
        ex[0x9010] = offset  # OffsetTimeOriginal
    if gps is not None:
        from PIL.TiffImagePlugin import IFDRational

        lat, lng = gps
        ex[0x8825] = {  # GPSInfo IFD: rationals must be IFDRational to serialize
            0x0001: "N" if lat >= 0 else "S",
            0x0002: _dms(IFDRational, abs(lat)),
            0x0003: "E" if lng >= 0 else "W",
            0x0004: _dms(IFDRational, abs(lng)),
        }
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=ex)
    return buf.getvalue()


def _dms(cls, decimal: float) -> tuple:
    """Decimal degrees → EXIF (d, m, s) IFDRationals."""
    d = int(decimal)
    m = int((decimal - d) * 60)
    s = round((((decimal - d) * 60) - m) * 60 * 100)
    return (cls(d, 1), cls(m, 1), cls(s, 100))


# ------------------------------------------------------------------ EXIF unit


def test_exif_reads_datetime_and_offset() -> None:
    raw = _jpeg(taken="2027:02:15 10:00:00", offset="+01:00")
    info = extract_exif(raw)
    assert info["has_exif"] is True
    assert info["taken_at"] == "2027-02-15T10:00:00+01:00"
    assert info["offset"] == "+01:00"
    assert info["lat"] is None and info["lng"] is None


def test_exif_without_metadata_is_honest() -> None:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buf, format="JPEG")
    info = extract_exif(buf.getvalue())
    assert info == {
        "taken_at": None,
        "offset": None,
        "lat": None,
        "lng": None,
        "has_exif": False,
    }


def test_exif_reads_gps() -> None:
    raw = _jpeg(taken="2027:02:15 10:00:00", gps=(51.1784, -115.5708))
    info = extract_exif(raw)
    assert info["has_exif"] is True
    assert info["lat"] is not None and abs(info["lat"] - 51.1784) < 1e-4
    assert info["lng"] is not None and abs(info["lng"] - (-115.5708)) < 1e-4


def test_exif_never_crashes_on_non_image_bytes() -> None:
    info = extract_exif(b"\x89PNG\r\n\x1a\nnot-really-an-image")
    assert info["has_exif"] is False
    assert info["taken_at"] is None


# ------------------------------------------------------------------ /api/files


def test_files_response_carries_sha256_and_exif(
    client, rsa_keypair, graph, media_store
) -> None:
    """Trip upload keeps its url contract and adds sha256 + exif (#190.1)."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    raw = _jpeg(taken="2027:02:15 10:00:00", offset="+00:00")
    resp = client.post(
        "/api/files",
        data={"trip_id": trip_id},
        files={"file": ("photo.jpg", io.BytesIO(raw), "image/jpeg")},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["url"].startswith(f"/media/{trip_id}/")
    assert body["sha256"] == hashlib.sha256(raw).hexdigest()
    assert body["exif"]["taken_at"] == "2027-02-15T10:00:00+00:00"
    assert body["exif"]["has_exif"] is True


def test_files_inbox_response_carries_exif_too(
    client, rsa_keypair, graph, media_store
) -> None:
    """Inbox path unchanged except the same additive EXIF fields (#190.1)."""
    graph(role="editor")
    token = _token_of(rsa_keypair)
    raw = _jpeg()  # no EXIF — the WhatsApp/screenshot case
    resp = client.post(
        "/api/files",
        files={"file": ("shot.jpg", io.BytesIO(raw), "image/jpeg")},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["url"].startswith("/inbox/")
    assert body["sha256"] == hashlib.sha256(raw).hexdigest()
    assert body["exif"]["has_exif"] is False
    assert body["exif"]["taken_at"] is None


# ------------------------------------------------------------------ helpers


def _upload(client, token: str, trip_id: str, raw: bytes, name: str = "p.jpg") -> str:
    resp = client.post(
        "/api/files",
        data={"trip_id": trip_id},
        files={"file": (name, io.BytesIO(raw), "image/jpeg")},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["url"].rsplit("/", 1)[1]


def _trip_days(client, token: str, trip_id: str) -> Any:
    resp = client.get(f"/api/trips/{trip_id}", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


# ------------------------------------------------------------------ propose


def test_propose_matches_block_within_window(
    client, rsa_keypair, graph, media_store
) -> None:
    """10:00 photo on day 0 lands on the 10:30 transport block (±90 min)."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    trip = graph_to_trip(g.fetch_graph(g.root))
    day0 = trip.days[0]
    assert day0.date == "2027-02-15"
    timed = next(b for b in day0.blocks if b.time)
    assert timed.time == "10:30"

    name = _upload(client, token, trip_id, _jpeg(taken="2027:02:15 10:00:00"))
    resp = client.post(
        f"/api/trips/{trip_id}/photos/propose",
        json={"photos": [{"file_name": name}]},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["undated"] == []
    (placement,) = body["placements"]
    assert placement["file_name"] == name
    assert placement["day_id"] == day0.id
    assert placement["day_index"] == 0
    assert placement["block_id"] == timed.id


def test_propose_falls_back_to_day_level_outside_window(
    client, rsa_keypair, graph, media_store
) -> None:
    """13:00 is >90 min from every timed block → day-level, no guess."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    trip = graph_to_trip(g.fetch_graph(g.root))
    day0 = trip.days[0]

    name = _upload(client, token, trip_id, _jpeg(taken="2027:02:15 13:00:00"))
    resp = client.post(
        f"/api/trips/{trip_id}/photos/propose",
        json={"photos": [{"file_name": name}]},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    (placement,) = resp.json()["placements"]
    assert placement["day_id"] == day0.id
    assert placement["block_id"] is None


def test_propose_uses_trip_timezone_not_utc(
    client, rsa_keypair, graph, media_store
) -> None:
    """01:30Z Feb 16 is still Feb 15 in Vancouver → day 0, not day 1."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    r = client.put(
        f"/api/trips/{trip_id}", json={"timezone": "America/Vancouver"}, headers=_auth(token)
    )
    assert r.status_code == 200, r.text

    name = _upload(
        client, token, trip_id, _jpeg(taken="2027:02:16 01:30:00", offset="+00:00")
    )
    resp = client.post(
        f"/api/trips/{trip_id}/photos/propose",
        json={"photos": [{"file_name": name}]},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    (placement,) = resp.json()["placements"]
    assert placement["day_index"] == 0  # UTC date alone would say day 1


def test_propose_undated_buckets_no_exif_and_out_of_window(
    client, rsa_keypair, graph, media_store
) -> None:
    """Screenshots (no EXIF) + a date outside the trip window → undated."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    no_exif = _upload(client, token, trip_id, _jpeg(), name="shot.jpg")
    far_away = _upload(
        client, token, trip_id, _jpeg(taken="2026:05:01 12:00:00"), name="old.jpg"
    )
    resp = client.post(
        f"/api/trips/{trip_id}/photos/propose",
        json={"photos": [{"file_name": no_exif}, {"file_name": far_away}]},
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Undated photos keep their placement entries (day_id None + an explicit
    # reason — the tray UI shows WHY) and are listed in `undated`.
    assert len(body["placements"]) == 2
    assert all(p["day_id"] is None and p["block_id"] is None for p in body["placements"])
    assert sorted(p["reason"] for p in body["placements"]) != ["", ""]
    assert sorted(body["undated"]) == sorted([no_exif, far_away])


def test_propose_is_read_only_and_editor_gated(
    client, rsa_keypair, graph, media_store
) -> None:
    """Propose writes NOTHING; viewer/follower get 403, anonymous 401."""
    g = graph(role="owner")
    trip_id = g.root
    owner_token = _token_of(rsa_keypair)
    name = _upload(client, owner_token, trip_id, _jpeg(taken="2027:02:15 10:00:00"))

    url = f"/api/trips/{trip_id}/photos/propose"
    assert client.post(url, json={"photos": [{"file_name": name}]}).status_code == 401
    for low in ("viewer", "follower"):
        g.add_user_role(trip_id, SUB, low)
        r = client.post(url, json={"photos": [{"file_name": name}]}, headers=_auth(owner_token))
        assert r.status_code == 403, low
    g.add_user_role(trip_id, SUB, "editor")
    # Snapshot AFTER the test's own role juggling — propose must change nothing.
    before = graph_to_trip(g.fetch_graph(g.root))
    r = client.post(url, json={"photos": [{"file_name": name}]}, headers=_auth(owner_token))
    assert r.status_code == 200, r.text
    after = graph_to_trip(g.fetch_graph(g.root))
    assert after.model_dump() == before.model_dump()


# ------------------------------------------------------------------ confirm


def test_confirm_writes_strip_and_gallery(
    client, rsa_keypair, graph, media_store
) -> None:
    """Block-targeted → Block.images (A); day-level → gallery block (B)."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    trip = graph_to_trip(g.fetch_graph(g.root))
    day0 = trip.days[0]
    timed = next(b for b in day0.blocks if b.time)

    strip_photo = _upload(
        client, token, trip_id, _jpeg(taken="2027:02:15 10:00:00"), name="a.jpg"
    )
    day_photo = _upload(
        client, token, trip_id, _jpeg(taken="2027:02:15 13:00:00"), name="b.jpg"
    )
    resp = client.post(
        f"/api/trips/{trip_id}/photos/confirm",
        json={
            "placements": [
                {"file_name": strip_photo, "day_id": day0.id, "block_id": timed.id},
                {"file_name": day_photo, "day_id": day0.id},
            ]
        },
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert sorted(body["written"]) == sorted([strip_photo, day_photo])
    assert body["skipped"] == []

    doc = _trip_days(client, token, trip_id)
    day = next(d for d in doc["days"] if d["id"] == day0.id)
    block = next(b for b in day["blocks"] if b["id"] == timed.id)
    assert any(strip_photo in (img or "") for img in block["images"])
    galleries = [b for b in day["blocks"] if b["kind"] == "gallery"]
    assert len(galleries) == 1
    # items are {"url": <name-or-canonical-url>} objects (DTDL object array)
    item_names = [
        it.get("url", "") if isinstance(it, dict) else (it or "")
        for it in galleries[0]["items"]
    ]
    assert any(day_photo in it for it in item_names)


def test_confirm_is_idempotent(client, rsa_keypair, graph, media_store) -> None:
    """Double-confirm of the same batch is a no-op (no duplicates)."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    trip = graph_to_trip(g.fetch_graph(g.root))
    day0 = trip.days[0]

    name = _upload(client, token, trip_id, _jpeg(taken="2027:02:15 13:00:00"))
    payload = {"placements": [{"file_name": name, "day_id": day0.id}]}
    first = client.post(
        f"/api/trips/{trip_id}/photos/confirm", json=payload, headers=_auth(token)
    )
    assert first.status_code == 200, first.text
    assert first.json()["written"] == [name]
    second = client.post(
        f"/api/trips/{trip_id}/photos/confirm", json=payload, headers=_auth(token)
    )
    assert second.status_code == 200, second.text
    assert second.json()["written"] == []
    assert second.json()["skipped"] == [name]

    doc = _trip_days(client, token, trip_id)
    day = next(d for d in doc["days"] if d["id"] == day0.id)
    # The serialized doc canonicalizes bare names to /media/<trip>/<file> URLs —
    # for a gallery block that lives on each item's "url" key.
    urls = []
    for b in day["blocks"]:
        if b["kind"] == "gallery":
            urls.extend(
                it.get("url") if isinstance(it, dict) else it
                for it in b.get("items", [])
                if it is not None
            )
        else:
            urls.extend(u for u in b.get("images", []) if isinstance(u, str))
    assert sum(1 for u in urls if isinstance(u, str) and u.endswith(f"/{name}")) == 1


def test_confirm_orders_by_capture_time_not_upload_order(
    client, rsa_keypair, graph, media_store
) -> None:
    """Gallery items sort by taken_at; missing taken_at sorts last."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    trip = graph_to_trip(g.fetch_graph(g.root))
    day0 = trip.days[0]

    late = _upload(client, token, trip_id, _jpeg(taken="2027:02:15 14:00:00"), name="late.jpg")
    early = _upload(client, token, trip_id, _jpeg(taken="2027:02:15 12:00:00"), name="early.jpg")
    resp = client.post(
        f"/api/trips/{trip_id}/photos/confirm",
        json={
            "placements": [
                {"file_name": late, "day_id": day0.id},
                {"file_name": early, "day_id": day0.id},
            ]
        },
        headers=_auth(token),
    )
    assert resp.status_code == 200, resp.text
    doc = _trip_days(client, token, trip_id)
    day = next(d for d in doc["days"] if d["id"] == day0.id)
    gallery = next(b for b in day["blocks"] if b["kind"] == "gallery")
    # items are {"url": <name-or-canonical-url>} objects (DTDL object array)
    tails = []
    for it in gallery.get("items") or []:
        url = it.get("url") if isinstance(it, dict) else it
        assert isinstance(url, str)
        tails.append(url.rsplit("/", 1)[-1])
    assert tails == [early, late]


def test_confirm_rejects_remote_urls_and_unknown_blocks(
    client, rsa_keypair, graph, media_store
) -> None:
    """The bare-filename gate holds on the photo path too (422 stays)."""
    g = graph(role="editor")
    trip_id = g.root
    token = _token_of(rsa_keypair)
    trip = graph_to_trip(g.fetch_graph(g.root))
    day0 = trip.days[0]
    r = client.post(
        f"/api/trips/{trip_id}/photos/confirm",
        json={
            "placements": [
                {
                    "file_name": "https://example.com/evil.jpg",
                    "day_id": day0.id,
                }
            ]
        },
        headers=_auth(token),
    )
    assert r.status_code == 422, r.text
    r = client.post(
        f"/api/trips/{trip_id}/photos/confirm",
        json={"placements": [{"file_name": "nope.jpg", "day_id": "no-day"}]},
        headers=_auth(token),
    )
    assert r.status_code == 404, r.text
