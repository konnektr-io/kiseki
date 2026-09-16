"""GPX track upload + parse + render data (#279, slice of #193).

A recorded activity (Slopes/Strava/Garmin GPX export) must have a path into a
trip: the composer picker offers ``.gpx``, ``POST /api/files`` stores it under
the trip's media namespace, the server parses it (stdlib only) into a polyline
+ summary, and an activity block carries it as ``track``. Malformed GPX is a
per-file 422 naming the file (the #251 contract: never accept-and-drop).
``.fit`` is OUT of scope: no binary runtime dependency (AGENTS.md) — its 422
says to export GPX instead.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import media as media_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.main import app
from app.media import require_upload_kind, upload_kind
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"

GPX = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Slopes" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Morning skin track</name>
    <trkseg>
      <trkpt lat="50.1000" lon="-122.9500"><ele>1650.0</ele><time>2026-02-15T09:00:00Z</time></trkpt>
      <trkpt lat="50.1010" lon="-122.9510"><ele>1680.0</ele><time>2026-02-15T09:10:00Z</time></trkpt>
      <trkpt lat="50.1020" lon="-122.9520"><ele>1660.0</ele><time>2026-02-15T09:20:00Z</time></trkpt>
      <trkpt lat="50.1030" lon="-122.9530"><ele>1720.0</ele><time>2026-02-15T09:30:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
""".encode()

MALFORMED_GPX = b"<gpx><trk><trkseg><trkpt lat='oops'>not xml"


def _token_of(rsa_keypair, **overrides: object) -> str:
    return _sign(rsa_keypair, _claims(**overrides))


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


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
    """Point the media store at a tmp dir (mirrors test_media_heic_251.py)."""

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


# ------------------------------------------------------------------ upload accept


def test_gpx_is_an_accepted_upload_kind() -> None:
    """The curated set (media.py UPLOAD_KINDS) takes .gpx — pre-fix: None."""
    assert upload_kind("morning-skin-track.gpx") == "document"


def test_fit_upload_fails_with_export_gpx_guidance() -> None:
    """`.fit` needs a new binary dep — refused with guidance, not silence."""
    with pytest.raises(Exception) as exc:
        require_upload_kind("activity.fit", "activity.fit")
    assert "export GPX from Slopes/Garmin" in str(exc.value)


# ------------------------------------------------------------------ server-side parse


def test_parse_gpx_summary_distance_ascent_time() -> None:
    from app.gpx import parse_gpx

    track = parse_gpx(GPX, "morning-skin-track.gpx")
    assert track.point_count == 4
    assert len(track.points) == 4
    # ~3 legs of ~132 m each at lat 50 → ~390–410 m total.
    assert 300 < track.distance_m < 500
    # Ascent: +30, -20, +60 → 90 m.
    assert track.ascent_m == pytest.approx(90.0, abs=1.0)
    assert track.start_time == "2026-02-15T09:00:00Z"
    assert track.end_time == "2026-02-15T09:30:00Z"


def test_parse_gpx_malformed_names_the_file() -> None:
    from app.gpx import GpxError, parse_gpx

    with pytest.raises(GpxError) as exc:
        parse_gpx(MALFORMED_GPX, "broken.gpx")
    assert "broken.gpx" in str(exc.value)


def test_parse_gpx_without_points_is_rejected() -> None:
    from app.gpx import GpxError, parse_gpx

    with pytest.raises(GpxError):
        parse_gpx(b'<?xml version="1.0"?><gpx version="1.1"></gpx>', "empty.gpx")


# ------------------------------------------------------------------ POST /api/files


def test_post_files_accepts_gpx_into_trip_media(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    """Pre-fix this 422d: `gpx is not a file type this build stores`."""
    g = graph("editor")
    token = _token_of(rsa_keypair)
    r = client.post(
        "/api/files",
        data={"tripId": g.root},
        files={"file": ("morning-skin-track.gpx", GPX, "application/gpx+xml")},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"].endswith(".gpx")
    assert body["url"] == f"/media/{g.root}/{body['name']}"
    # Safe content type — never executable.
    assert body["contentType"] not in ("text/html", "application/javascript")


def test_post_files_rejects_malformed_gpx_per_file(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    g = graph("editor")
    token = _token_of(rsa_keypair)
    r = client.post(
        "/api/files",
        data={"tripId": g.root},
        files={"file": ("broken.gpx", MALFORMED_GPX, "application/gpx+xml")},
        headers=_auth(token),
    )
    assert r.status_code == 422, r.text
    assert "broken.gpx" in r.json()["detail"]


def test_post_files_rejects_fit_with_export_guidance(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    g = graph("editor")
    token = _token_of(rsa_keypair)
    r = client.post(
        "/api/files",
        data={"tripId": g.root},
        files={"file": ("activity.fit", b"FIT binary", "application/octet-stream")},
        headers=_auth(token),
    )
    assert r.status_code == 422, r.text
    assert "export GPX from Slopes/Garmin" in r.json()["detail"]


# ------------------------------------------------------------------ track endpoint


def test_track_endpoint_returns_polyline_and_summary(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    g = graph("editor")
    token = _token_of(rsa_keypair)
    up = client.post(
        "/api/files",
        data={"tripId": g.root},
        files={"file": ("morning-skin-track.gpx", GPX, "application/gpx+xml")},
        headers=_auth(token),
    )
    assert up.status_code == 200, up.text
    name = up.json()["name"]
    r = client.get(f"/api/tracks/{g.root}/{name}", headers=_auth(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["type"] == "Feature"
    assert body["geometry"]["type"] == "LineString"
    assert len(body["geometry"]["coordinates"]) == 4
    assert 300 < body["properties"]["distanceM"] < 500
    assert body["properties"]["ascentM"] == pytest.approx(90.0, abs=1.0)


def test_track_endpoint_404_on_unknown_file(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    g = graph("editor")
    token = _token_of(rsa_keypair)
    r = client.get(f"/api/tracks/{g.root}/{'0' * 32}.gpx", headers=_auth(token))
    assert r.status_code == 404


# ------------------------------------------------------------------ write-path round trip
# (see test_gpx_track_write_193.py — `track` on activity blocks, Phase 3).

