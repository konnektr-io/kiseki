"""Strava import (#449) — the way in, with no token anywhere on disk.

What these tests hold us to, in the order the human meets them:

* the OAuth codec: the state must match the browser that started the flow, and
  the session cookie must carry what the export needed and nothing forgeable;
* the refresh is ROTATION-AWARE — Strava invalidates the old refresh token the
  moment it issues a new one, so the new one has to come back in a ``Set-Cookie``
  or the very next request 401s;
* streams → GPX, parsed back by the real ``gpx.parse_gpx`` (not a fixture);
* the trip side: date is the hard filter, geo/single-candidate picks the block,
  a re-import is a no-op, a second crew member's track is not overwritten, a
  failed photo does not cost the track, and viewer/anonymous are refused.

The network is a ``httpx.MockTransport`` wired to the real client code, so the
requests under test really are the requests: params, bearer header, HTTP Basic.
"""

from __future__ import annotations

import datetime as _dt
import time
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import config as config_module
from app import media as media_module
from app import store as store_mod
from app import strava as strava_svc
from app import strava_import as import_svc
from app.auth import Auth0JWTValidator
from app.main import app
from app.models import Block, Day, Link, Location, Trip
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
TRIP_ID = "bf29a027-2ed2-46b3-b869-d9d81bbcf237"  # canada-2027 fixture root
DAY_2027_02_16 = "f3f4a9a5-7b9e-4e43-abd0-71a40de1fb58"
BLOCK_SUNSHINE = "90598e14-79fa-4cb8-a1ca-779e0702d20f"
DAY_2027_02_17 = "0979c7f0-dc5a-4232-ac9a-b6422ac49d3a"
ACTIVITY_ID = 11_111_111


# ------------------------------------------------------------------ the network


class StravaStub:
    """A fake Strava: records every request, answers like the real API."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.refresh_tokens = ["refresh-1", "refresh-2", "refresh-3"]
        self.token_calls = 0
        self.revoke_calls = 0
        self.refresh_refused = False
        self.photo_status = 200
        self.expires_in = 60  # < REFRESH_SKEW_S on purpose: forces one rotation

    # -- payloads
    def _token(self) -> dict[str, Any]:
        index = min(self.token_calls, len(self.refresh_tokens) - 1)
        self.token_calls += 1
        return {
            "token_type": "Bearer",
            "expires_at": int(time.time()) + self.expires_in,
            "expires_in": self.expires_in,
            "refresh_token": self.refresh_tokens[index],
            "access_token": "access-token",
            "athlete": {"id": 96911081, "firstname": "Niko", "lastname": "Raes"},
            "scope": "read activity:read_all",
        }

    @staticmethod
    def activity() -> dict[str, Any]:
        return {
            "id": ACTIVITY_ID,
            "name": "Sunshine Village morning",
            "sport_type": "Snowboard",
            "start_date": "2027-02-16T15:30:00Z",
            "start_date_local": "2027-02-16T08:30:00",
            "distance": 12_800.0,
            "moving_time": 9_400,
            "elapsed_time": 14_200,
            "total_elevation_gain": 1_180.0,
            "start_latlng": [51.0789, -115.7867],
            "end_latlng": [51.0761, -115.7925],
            "trainer": False,
            "total_photo_count": 2,
            "device_name": "Strava iPhone App",
            "external_id": "strava_upload_1",
        }

    # -- the transport
    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        path = request.url.path
        if path.endswith("/oauth/token"):
            if self.refresh_refused:
                return httpx.Response(400, json={"message": "Bad Request", "errors": [{"resource": "RefreshToken", "field": "invalid", "code": "invalid"}]})
            return httpx.Response(200, json=self._token())
        if path.endswith("/oauth/revoke"):
            self.revoke_calls += 1
            assert request.headers["authorization"].startswith("Basic ")
            return httpx.Response(200)
        if path.endswith("/athlete/activities"):
            return httpx.Response(200, json=[self.activity()])
        if path.endswith("/streams"):
            return httpx.Response(
                200,
                json={
                    "latlng": {"data": [[51.0789, -115.7867], [51.0772, -115.7901], [51.0761, -115.7925]]},
                    "altitude": {"data": [1660.0, 1705.5, 1690.0]},
                    "time": {"data": [0, 600, 1200]},
                },
            )
        if path.endswith("/photos"):
            return httpx.Response(
                200,
                json=[
                    {"unique_id": "p1", "urls": {"600": "https://cdn.test/p1.jpg"}, "created_at": "2027-02-16T09:10:00Z"},
                    {"unique_id": "p2", "urls": {"2048": "https://cdn.test/p2.jpg"}, "created_at": "2027-02-16T09:40:00Z"},
                ],
            )
        if "cdn.test" in url:
            return httpx.Response(self.photo_status, content=b"\xff\xd8\xff\xe0jpeg-bytes", headers={"content-type": "image/jpeg"})
        if path.endswith(f"/activities/{ACTIVITY_ID}"):
            return httpx.Response(200, json=self.activity())
        return httpx.Response(404, json={"message": f"unexpected {url}"})


# --------------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    reset_rate_limits()
    import_svc.clear_cache()
    yield
    reset_rate_limits()
    import_svc.clear_cache()


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    # http:// keeps the session cookie usable over TestClient's transport; the
    # Secure flag on https is asserted on its own below.
    monkeypatch.setattr(config_module, "PUBLIC_BASE_URL", "http://testserver")
    monkeypatch.setattr(config_module, "STRAVA_CLIENT_ID", "283025")
    monkeypatch.setattr(config_module, "STRAVA_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(config_module, "STRAVA_COOKIE_SECRET", "")
    monkeypatch.setattr(
        config_module, "STRAVA_REDIRECT_URI", "http://testserver/api/integrations/strava/callback"
    )
    return TestClient(app)


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch) -> StravaStub:
    fake = StravaStub()
    monkeypatch.setattr(
        strava_svc, "_client", lambda: httpx.Client(transport=httpx.MockTransport(fake.handler))
    )
    return fake


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
    """Point the media store at a tmp dir (same shape as test_gpx_track_279)."""

    def __init__(self, root) -> None:
        self.KISEKI_S3_ENDPOINT = None
        self.KISEKI_S3_BUCKET = None
        self.KISEKI_S3_ACCESS_KEY = None
        self.KISEKI_S3_SECRET_KEY = None
        self.KISEKI_S3_REGION = config_module.KISEKI_S3_REGION
        self.ASSETS_DIR = root


@pytest.fixture
def media_store(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    yield tmp_path
    media_module.clear_media_store()


def _auth(rsa_keypair, **overrides: object) -> dict[str, str]:
    return {"Authorization": f"Bearer {_sign(rsa_keypair, _claims(**overrides))}"}


def _connect(client: TestClient, headers: dict[str, str]) -> None:
    """Walk the real connect → callback flow, leaving a session cookie behind."""
    started = client.post("/api/integrations/strava/connect", headers=headers)
    assert started.status_code == 200, started.text
    authorize = started.json()["authorizeUrl"]
    state = authorize.split("state=")[1].split("&")[0]
    done = client.get(
        "/api/integrations/strava/callback",
        params={"code": "the-code", "state": state, "scope": "read activity:read_all"},
        follow_redirects=False,
    )
    assert done.status_code == 303
    assert done.headers["location"] == "/me?strava=connected"


# ------------------------------------------------------------------ pure pieces


def test_session_cookie_is_signed_not_encrypted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_module, "STRAVA_CLIENT_ID", "283025")
    monkeypatch.setattr(config_module, "STRAVA_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(config_module, "STRAVA_COOKIE_SECRET", "")

    session = {"v": 1, "a": 96911081, "n": "Niko Raes", "s": "read", "r": "refresh", "t": "access", "e": 1}
    value = strava_svc.encode_session(session)
    assert strava_svc.decode_session(value) == session

    # Tamper: a flipped payload byte must not decode.
    body, signature = value.split(".")
    forged = ("A" if body[0] != "A" else "B") + body[1:]
    assert strava_svc.decode_session(f"{forged}.{signature}") is None
    assert strava_svc.decode_session(f"{body}.{signature[:-2]}xx") is None
    assert strava_svc.decode_session("") is None
    assert strava_svc.decode_session(None) is None

    # A different signing key (a deployment with its own secret) rejects it.
    monkeypatch.setattr(config_module, "STRAVA_COOKIE_SECRET", "another-secret")
    assert strava_svc.decode_session(value) is None


def test_gpx_is_what_the_existing_parser_reads() -> None:
    from app.gpx import parse_gpx

    points = [(51.0789, -115.7867, 1660.0, "2027-02-16T15:30:00Z"),
              (51.0772, -115.7901, 1705.5, "2027-02-16T15:40:00Z"),
              (51.0761, -115.7925, 1690.0, "2027-02-16T15:50:00Z")]
    track = parse_gpx(strava_svc.build_gpx(points, name="Sunshine & <Village>"), "synthesized.gpx")
    assert track.point_count == 3
    assert track.distance_m > 0
    assert track.ascent_m == pytest.approx(45.5, abs=0.6)  # +45.5 then −15.5
    assert track.start_time == "2027-02-16T15:30:00Z"
    assert track.end_time == "2027-02-16T15:50:00Z"


def test_points_from_streams_use_the_activity_start_for_timestamps() -> None:
    payload = {
        "latlng": {"data": [[51.0, -115.0], [51.01, -115.01]]},
        "altitude": {"data": [1000.0, None]},
        "time": {"data": [0, 90]},
    }
    start = _dt.datetime(2027, 2, 16, 15, 30, tzinfo=_dt.timezone.utc).timestamp()
    points = strava_svc.points_from_streams(payload, start)
    assert points[0] == (51.0, -115.0, 1000.0, "2027-02-16T15:30:00Z")
    assert points[1][2] is None
    assert points[1][3] == "2027-02-16T15:31:30Z"
    # No start → geometry survives, the clock does not (never invented).
    assert strava_svc.points_from_streams(payload, None)[0][3] is None


def test_trip_window_brackets_the_trip_dates() -> None:
    trip = Trip(
        id="t", slug="t", title="T",
        days=[Day(id="d", date="2027-02-15")],
        startDate="2027-02-15", endDate="2027-03-02",
    )
    after, before = import_svc.trip_window(trip)
    assert after == int(_dt.datetime(2027, 2, 14, tzinfo=_dt.timezone.utc).timestamp())
    assert before == int(_dt.datetime(2027, 3, 4, tzinfo=_dt.timezone.utc).timestamp())


def _trip_with_blocks() -> Trip:
    return Trip(
        id="trip-1",
        slug="trip-1",
        title="Fixture",
        locations=[
            Location(id="l1", name="Revelstoke", lat=50.9981, lng=-118.1957, alias=["RMR"]),
            Location(id="l2", name="Banff", lat=51.1784, lng=-115.5708),
        ],
        days=[
            Day(
                id="day-16",
                date="2027-02-16",
                blocks=[
                    Block(id="b-far", kind="activity", title="RMR full day", location="Revelstoke"),
                    Block(id="b-near", kind="activity", title="Sunshine", location="Banff", time="08:00"),
                    Block(id="b-lodging", kind="lodging", title="Stay: Banff", location="Banff"),
                ],
            ),
            Day(id="day-17", date="2027-02-17", blocks=[Block(id="b-only", kind="activity", title="RMR")]),
        ],
    )


def test_suggestion_prefers_geo_proximity_over_the_clock() -> None:
    trip = _trip_with_blocks()
    activity = StravaStub.activity()  # starts at Sunshine Village, 51.07/-115.78
    suggestion = import_svc.suggest(trip, activity)
    assert suggestion == {"day_id": "day-16", "block_id": "b-near"}


def test_suggestion_falls_back_to_the_single_activity_block() -> None:
    trip = _trip_with_blocks()
    activity = {**StravaStub.activity(), "start_date_local": "2027-02-17T09:00:00",
                "start_latlng": [10.0, 10.0], "end_latlng": None}
    assert import_svc.suggest(trip, activity) == {"day_id": "day-17", "block_id": "b-only"}


def test_suggestion_never_guesses_a_day_outside_the_trip() -> None:
    trip = _trip_with_blocks()
    activity = {**StravaStub.activity(), "start_date_local": "2027-03-11T09:00:00"}
    assert import_svc.suggest(trip, activity) is None


def test_activity_date_is_the_local_date_not_a_timezone_shift() -> None:
    trip = _trip_with_blocks()
    # 23:30 local on the 16th is 07:30Z on the 17th — the DAY is still the 16th.
    activity = {**StravaStub.activity(), "start_date_local": "2027-02-16T23:30:00",
                "start_date": "2027-02-17T07:30:00Z"}
    assert import_svc.local_date(activity) == "2027-02-16"
    assert import_svc.suggest(trip, activity)["day_id"] == "day-16"


def test_indoor_activities_are_not_offered() -> None:
    assert not import_svc.is_importable({**StravaStub.activity(), "trainer": True})
    assert not import_svc.is_importable({**StravaStub.activity(), "sport_type": "VirtualRide"})
    assert not import_svc.is_importable({**StravaStub.activity(), "start_latlng": []})
    assert import_svc.is_importable(StravaStub.activity())


def test_garmin_sourced_activity_is_recognised() -> None:
    assert import_svc.is_garmin({"device_name": "Garmin Edge 1040"})
    assert import_svc.is_garmin({"external_id": "garmin_push_123"})
    assert not import_svc.is_garmin({"device_name": "Strava iPhone App", "external_id": "strava_upload_1"})


# ------------------------------------------------------------------ the connect flow


def test_connect_without_a_strava_app_is_503(client: TestClient, rsa_keypair, monkeypatch) -> None:
    monkeypatch.setattr(config_module, "STRAVA_CLIENT_ID", "")
    response = client.post("/api/integrations/strava/connect", headers=_auth(rsa_keypair))
    assert response.status_code == 503
    assert client.get("/api/integrations/strava/status", headers=_auth(rsa_keypair)).json() == {
        "configured": False, "connected": False, "athlete": None, "scopes": ""
    }


def test_connect_needs_a_credential(client: TestClient, stub: StravaStub) -> None:
    assert client.post("/api/integrations/strava/connect").status_code == 401


def test_connect_sets_a_state_cookie_and_returns_the_authorize_url(client: TestClient, stub: StravaStub, rsa_keypair) -> None:
    response = client.post("/api/integrations/strava/connect", headers=_auth(rsa_keypair))
    assert response.status_code == 200
    payload = response.json()
    assert payload["authorizeUrl"].startswith("https://www.strava.com/oauth/authorize?")
    assert "scope=read%2Cactivity%3Aread_all" in payload["authorizeUrl"]
    assert "redirect_uri=http%3A%2F%2Ftestserver%2Fapi%2Fintegrations%2Fstrava%2Fcallback" in payload["authorizeUrl"]
    cookie = response.headers["set-cookie"]
    assert strava_svc.STATE_COOKIE in cookie
    lowered = cookie.lower()
    assert "httponly" in lowered and "path=/api/integrations/strava" in lowered and "samesite=lax" in lowered


def test_callback_rejects_a_state_this_browser_never_received(client: TestClient, stub: StravaStub, rsa_keypair) -> None:
    client.post("/api/integrations/strava/connect", headers=_auth(rsa_keypair))
    response = client.get(
        "/api/integrations/strava/callback",
        params={"code": "the-code", "state": "not-the-state"},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert stub.token_calls == 0  # no token was minted for an unproven browser


def test_callback_without_a_code_or_state_is_refused(client: TestClient, stub: StravaStub) -> None:
    assert client.get("/api/integrations/strava/callback", follow_redirects=False).status_code == 400
    assert client.get("/api/integrations/strava/callback", params={"error": "access_denied"}, follow_redirects=False).headers["location"] == "/me?strava=denied"


def test_callback_stores_the_session_cookie_httponly_and_scoped(client: TestClient, stub: StravaStub, rsa_keypair) -> None:
    started = client.post("/api/integrations/strava/connect", headers=_auth(rsa_keypair))
    state = started.json()["authorizeUrl"].split("state=")[1].split("&")[0]
    response = client.get(
        "/api/integrations/strava/callback",
        params={"code": "the-code", "state": state, "scope": "read activity:read_all"},
        follow_redirects=False,
    )
    cookie = response.headers["set-cookie"]
    assert f"{strava_svc.SESSION_COOKIE}=" in cookie
    lowered = cookie.lower()
    assert "httponly" in lowered
    assert "samesite=lax" in lowered
    assert "path=/api/integrations/strava" in lowered
    assert strava_svc.STATE_COOKIE in cookie and "max-age=0" in lowered  # state consumed

    status_payload = client.get("/api/integrations/strava/status", headers=_auth(rsa_keypair)).json()
    assert status_payload == {
        "configured": True,
        "connected": True,
        "athlete": {"id": 96911081, "name": "Niko Raes"},
        "scopes": "read activity:read_all",
    }
    assert "access-token" not in str(status_payload)  # never the token


def test_cookie_is_secure_over_https_only(client: TestClient, stub: StravaStub, rsa_keypair, monkeypatch) -> None:
    monkeypatch.setattr(config_module, "PUBLIC_BASE_URL", "https://kiseki.konnektr.io")
    response = client.post("/api/integrations/strava/connect", headers=_auth(rsa_keypair))
    assert "Secure" in response.headers["set-cookie"]


# -------------------------------------------------------------------- the list


def test_activity_list_is_read_only_and_suggests_the_day(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    _connect(client, _auth(rsa_keypair))
    response = client.get(
        f"/api/integrations/strava/trips/{TRIP_ID}/activities", headers=_auth(rsa_keypair)
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["activities"]) == 1
    item = payload["activities"][0]
    assert item["id"] == ACTIVITY_ID
    assert item["local_date"] == "2027-02-16"
    assert item["suggested"] == {"day_id": DAY_2027_02_16, "block_id": BLOCK_SUNSHINE}
    assert item["imported"] is None
    assert item["photo_count"] == 2
    # READ-ONLY: the day still has no track-bearing block.
    assert not any(b.get("track") for d in response.json().get("trip", {}).get("days", []) for b in d["blocks"])


def test_activity_list_needs_editor_and_a_credential(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("viewer")
    _connect(client, _auth(rsa_keypair))
    assert client.get(
        f"/api/integrations/strava/trips/{TRIP_ID}/activities", headers=_auth(rsa_keypair)
    ).status_code == 403
    assert client.get(f"/api/integrations/strava/trips/{TRIP_ID}/activities").status_code == 401


def test_activities_without_a_connection_are_401(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    response = client.get(
        f"/api/integrations/strava/trips/{TRIP_ID}/activities", headers=_auth(rsa_keypair)
    )
    assert response.status_code == 401
    assert "connect" in response.json()["detail"].lower()


# ------------------------------------------------------------------- the import


def _import(client: TestClient, headers: dict[str, str], **body: Any) -> httpx.Response:
    return client.post(
        f"/api/integrations/strava/trips/{TRIP_ID}/import",
        headers=headers,
        json={"activity_id": ACTIVITY_ID, "day_id": DAY_2027_02_16, **body},
    )


def _day_payload(response: httpx.Response) -> dict[str, Any]:
    payload = response.json()
    day = next(d for d in payload["days"] if d["id"] == DAY_2027_02_16)
    return day


def test_import_writes_track_link_and_photos(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    g = graph("editor")
    _connect(client, _auth(rsa_keypair))
    response = _import(client, _auth(rsa_keypair))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["written"] is True
    assert payload["block_id"] == BLOCK_SUNSHINE
    assert payload["photos"] == {"written": 2, "failed": 0, "total": 2}
    assert payload["consent"] is True

    block = next(b for b in _day_payload(response)["blocks"] if b["id"] == BLOCK_SUNSHINE)
    # The write stores a BARE filename; the read path canonicalises it to a URL.
    assert block["track"] == f"/media/{TRIP_ID}/{payload['track']}"
    assert payload["track"].endswith(".gpx")
    assert len(block["images"]) == 2
    labels = [(link["label"], link["url"]) for link in block["links"]]
    assert ("View on Strava", f"https://www.strava.com/activities/{ACTIVITY_ID}") in labels
    assert ("Resort site", "https://www.sunshinemountain.com/") in labels  # existing links kept

    # The stored bytes are a real GPX the existing parser reads.
    stored = media_store / TRIP_ID / payload["track"]
    from app.gpx import parse_gpx

    parsed = parse_gpx(stored.read_bytes(), payload["track"])
    assert parsed.point_count == 3
    assert parsed.start_time == "2027-02-16T15:30:00Z"
    # And the photos landed through the same content-addressed media path.
    for url in block["images"]:  # also canonicalised to /media/<trip>/<file>
        assert url.startswith(f"/media/{TRIP_ID}/")
        assert (media_store / TRIP_ID / url.rsplit("/", 1)[1]).is_file()

    # Streams were asked for the least data that renders — no heart rate.
    streams_call = next(r for r in stub.requests if r.url.path.endswith("/streams"))
    assert streams_call.url.params["keys"] == "latlng,altitude,time"


def test_reimport_is_a_noop(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    _connect(client, _auth(rsa_keypair))
    first = _import(client, _auth(rsa_keypair))
    assert first.json()["written"] is True
    blocks_before = len(_day_payload(first)["blocks"])

    second = _import(client, _auth(rsa_keypair))
    assert second.status_code == 200
    payload = second.json()
    assert payload["written"] is False
    assert payload["conflict"] == "already_imported"
    assert payload["block_id"] == BLOCK_SUNSHINE
    assert payload["track"] == first.json()["track"]
    assert len(_day_payload(second)["blocks"]) == blocks_before  # no duplicate block


def test_a_block_that_already_has_a_track_is_not_overwritten(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    g = graph("editor")
    track = strava_svc.build_gpx([(51.0789, -115.7867, 1660.0, None)], "mine")
    from app.media import content_addressed_key, get_media_store, object_key_for

    name = content_addressed_key(track, ".gpx")
    get_media_store().put(object_key_for(TRIP_ID, name), track, "application/gpx+xml")
    g.set_twin_prop(BLOCK_SUNSHINE, "track", name)  # a crew member's own upload

    _connect(client, _auth(rsa_keypair))
    response = _import(client, _auth(rsa_keypair))
    assert response.status_code == 200
    payload = response.json()
    assert payload["written"] is False
    assert payload["conflict"] == "track_exists"
    assert payload["track"] == name
    block = next(b for b in _day_payload(response)["blocks"] if b["id"] == BLOCK_SUNSHINE)
    assert block["track"] == f"/media/{TRIP_ID}/{name}"  # untouched


def test_one_failed_photo_does_not_cost_the_track(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    stub.photo_status = 500
    _connect(client, _auth(rsa_keypair))
    response = _import(client, _auth(rsa_keypair))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["written"] is True
    assert payload["photos"] == {"written": 0, "failed": 2, "total": 2}
    block = next(b for b in _day_payload(response)["blocks"] if b["id"] == BLOCK_SUNSHINE)
    assert block["track"].endswith(".gpx")
    assert block["images"] == []


def test_photos_can_be_declined_without_losing_the_track(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    _connect(client, _auth(rsa_keypair))
    response = _import(client, _auth(rsa_keypair), include_photos=False)
    payload = response.json()
    assert payload["written"] is True
    assert payload["photos"] == {"written": 0, "failed": 0, "total": 0}
    assert not any(r.url.path.endswith("/photos") for r in stub.requests)


def test_import_requires_the_consent_tick(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    _connect(client, _auth(rsa_keypair))
    response = _import(client, _auth(rsa_keypair), consent=False)
    assert response.status_code == 422
    assert "consent" in response.json()["detail"].lower()
    assert not any(r.url.path.endswith("/streams") for r in stub.requests)


def test_import_refused_for_viewer_and_anonymous(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("viewer")
    _connect(client, _auth(rsa_keypair))
    assert _import(client, _auth(rsa_keypair)).status_code == 403

    graph("editor")
    _connect(client, _auth(rsa_keypair))
    assert _import(client, {}).status_code == 401


# ------------------------------------------------------- rotation and revocation


def test_a_rotated_refresh_token_is_persisted_in_the_cookie(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    _connect(client, _auth(rsa_keypair))
    session_before = strava_svc.decode_session(
        next(c.value for c in client.cookies.jar if c.name == strava_svc.SESSION_COOKIE)
    )
    assert session_before["r"] == "refresh-1"

    # expires_at is 60 s out (< the 300 s skew) → the list call must refresh,
    # and Strava hands back a NEW refresh token that has to survive the call.
    response = client.get(
        f"/api/integrations/strava/trips/{TRIP_ID}/activities", headers=_auth(rsa_keypair)
    )
    assert response.status_code == 200, response.text
    assert stub.token_calls >= 2  # the code exchange + this refresh
    fresh = strava_svc.decode_session(
        next(c.value for c in client.cookies.jar if c.name == strava_svc.SESSION_COOKIE)
    )
    assert fresh["r"] == "refresh-2", "the rotated refresh token must be the one kept"
    bearer = next(r for r in stub.requests if r.url.path.endswith("/athlete/activities"))
    assert bearer.headers["authorization"] == "Bearer access-token"


def test_a_revoked_refresh_clears_the_cookie_and_asks_to_reconnect(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    graph("editor")
    _connect(client, _auth(rsa_keypair))
    stub.refresh_refused = True
    response = client.get(
        f"/api/integrations/strava/trips/{TRIP_ID}/activities", headers=_auth(rsa_keypair)
    )
    assert response.status_code == 401
    assert "connect" in response.json()["detail"].lower()
    assert any(c.name == strava_svc.SESSION_COOKIE and not c.value for c in client.cookies.jar) or all(
        c.name != strava_svc.SESSION_COOKIE for c in client.cookies.jar
    )
    # …and the connection list now reads as disconnected, not as a dead link.
    assert client.get("/api/integrations/strava/status", headers=_auth(rsa_keypair)).json()["connected"] is False


def test_disconnect_revokes_at_strava_and_drops_the_cookie(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    _connect(client, _auth(rsa_keypair))
    response = client.delete("/api/integrations/strava", headers=_auth(rsa_keypair))
    assert response.status_code == 200
    assert response.json() == {"connected": False, "revoked": True}
    assert stub.revoke_calls == 1  # HTTP Basic, token in the body — see the stub's assert
    assert client.get("/api/integrations/strava/status", headers=_auth(rsa_keypair)).json()["connected"] is False


def test_disconnect_still_disconnects_when_strava_refuses(client: TestClient, stub: StravaStub, rsa_keypair) -> None:
    _connect(client, _auth(rsa_keypair))

    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "unavailable"})

    strava_svc._client = lambda: httpx.Client(transport=httpx.MockTransport(failing))  # type: ignore[assignment]
    response = client.delete("/api/integrations/strava", headers=_auth(rsa_keypair))
    assert response.status_code == 200
    assert response.json() == {"connected": False, "revoked": False}


def test_no_strava_token_is_written_to_disk_or_the_graph(client: TestClient, stub: StravaStub, rsa_keypair, graph, media_store) -> None:
    g = graph("editor")
    _connect(client, _auth(rsa_keypair))
    _import(client, _auth(rsa_keypair))

    # Nothing under the trip's twins mentions a token, and the only files are
    # the content-addressed track + photos.
    bundle = g.fetch_graph(TRIP_ID)
    assert "refresh-1" not in str(bundle) and "access-token" not in str(bundle)
    for path in media_store.rglob("*"):
        if path.is_file():
            assert b"refresh-1" not in path.read_bytes()
