"""`track` on activity blocks (#193) — write path, graph round trip, DTDL.

The model decision (spec §5 keeps the model coarse): a shared/completed
activity is ``kind: activity`` with a ``track`` field (a bare .gpx filename),
NOT a new block kind. This file pins the write path (create + edit round
trip through the graph, kind gate, missing-file 422) and that the DTDL
generator carries the new property (``gen_dtdl.py --check`` is the CI gate;
``test_verify_dtdl.py`` covers the committed file).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import media as media_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.main import app
from app.media import resolve_media_urls
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


def _upload(client: TestClient, root: str, token: str) -> str:
    r = client.post(
        "/api/files",
        data={"tripId": root},
        files={"file": ("morning-skin-track.gpx", GPX, "application/gpx+xml")},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["name"]


def test_activity_block_carries_track_round_trip(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    """`track` survives the write→graph→read path, canonicalized like media."""
    g = graph("editor")
    token = _token_of(rsa_keypair)
    name = _upload(client, g.root, token)

    trip = client.get(f"/api/trips/{g.root}", headers=_auth(token)).json()
    day_id = trip["days"][0]["id"]
    created = client.post(
        f"/api/trips/{g.root}/blocks",
        json={
            "kind": "activity",
            "container": {"type": "day", "id": day_id},
            "title": "Morning skin track",
            "track": name,
        },
        headers=_auth(token),
    )
    assert created.status_code == 201, created.text
    block_id = created.json()["days"][0]["blocks"][-1]["id"]

    edited = client.put(
        f"/api/trips/{g.root}/blocks/{block_id}",
        json={"track": name},
        headers=_auth(token),
    )
    assert edited.status_code == 200, edited.text
    blocks = edited.json()["days"][0]["blocks"]
    assert [b for b in blocks if b["id"] == block_id][0]["track"] == (
        f"/media/{g.root}/{name}"
    )


def test_track_rejected_on_non_activity_block(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    g = graph("editor")
    token = _token_of(rsa_keypair)
    name = _upload(client, g.root, token)
    trip = client.get(f"/api/trips/{g.root}", headers=_auth(token)).json()
    day_id = trip["days"][0]["id"]
    r = client.post(
        f"/api/trips/{g.root}/blocks",
        json={
            "kind": "note",
            "container": {"type": "day", "id": day_id},
            "title": "Not a track",
            "track": name,
        },
        headers=_auth(token),
    )
    assert r.status_code == 422, r.text


def test_track_rejected_when_file_was_never_uploaded(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    """A typo'd name cannot leave a card pointing at nothing (#251)."""
    g = graph("editor")
    token = _token_of(rsa_keypair)
    trip = client.get(f"/api/trips/{g.root}", headers=_auth(token)).json()
    day_id = trip["days"][0]["id"]
    r = client.post(
        f"/api/trips/{g.root}/blocks",
        json={
            "kind": "activity",
            "container": {"type": "day", "id": day_id},
            "title": "Ghost track",
            "track": f"{'a' * 32}.gpx",
        },
        headers=_auth(token),
    )
    assert r.status_code == 422, r.text
    assert "upload the .gpx first" in r.json()["detail"]


def test_track_rejected_as_url(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    """Media fields store bare filenames (#187) — track is no exception."""
    g = graph("editor")
    token = _token_of(rsa_keypair)
    trip = client.get(f"/api/trips/{g.root}", headers=_auth(token)).json()
    day_id = trip["days"][0]["id"]
    r = client.post(
        f"/api/trips/{g.root}/blocks",
        json={
            "kind": "activity",
            "container": {"type": "day", "id": day_id},
            "title": "Hotlinked track",
            "track": "https://example.com/track.gpx",
        },
        headers=_auth(token),
    )
    assert r.status_code == 422, r.text


def test_track_canonicalized_to_media_url_on_read() -> None:
    trip_id = "bf29a027-2ed2-46b3-b869-d9d81bbcf237"
    doc = {"days": [{"blocks": [{"kind": "activity", "track": f"{'b' * 32}.gpx"}]}]}
    out = resolve_media_urls(doc, trip_id)
    assert out["days"][0]["blocks"][0]["track"] == f"/media/{trip_id}/{'b' * 32}.gpx"


def test_dtdl_block_carries_track_property() -> None:
    """The DTDL regen picked up Block.track (gen_dtdl.py ran)."""
    import json
    from pathlib import Path

    models = json.loads(
        (Path(__file__).resolve().parent.parent / "dtdl" / "kiseki-models.json").read_text()
    )
    block = next(m for m in models if m["@id"] == "dtmi:kiseki:travel:Block;1")
    names = [c.get("name") for c in block["contents"]]
    assert "track" in names
