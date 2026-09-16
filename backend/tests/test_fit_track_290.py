"""Lift legs vs. ridden runs on the day map (issue #290).

Two paths land in the same rendering:

1. FIT laps preferred — Slopes labels EVERY leg in ``split_mesgs``
   (``ski_run_split`` / ``ski_lift_split`` with own start/end, distance and
   ascent). Laps back it up (all descents); cadence is the last resort.
2. GPX-cadence fallback — a Slopes GPX carries no labels, but lift legs
   surface as >2 min intervals between fixes; classifying those as lift legs
   reproduces the rider's logged figures.

Fixtures are SYNTHESIZED at test time with Garmin's official SDK (the same
``garmin-fit-sdk`` the runtime decodes with) — no real trip bytes in git
(the repo is public). The proof against Niko's real Slopes day (11 runs, 12
lifts, ride sum within metres of the session total) runs only when the files
are handed in via ``KISEKI_REAL_FIT`` / ``KISEKI_REAL_GPX``.
"""

from __future__ import annotations

import datetime as _dt
import os

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import media as media_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.fit import FitError, parse_fit
from app.gpx import parse_gpx
from app.main import app
from app.media import upload_kind
from app.ratelimit import reset as reset_rate_limits
from app.tracklegs import RESPONSE_MAX_POINTS, LegPoint, build_feature

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"


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


# ------------------------------------------------------------ synthetic FIT days
# Fake coordinates (nowhere near a real trip): a lift climbs 800 → 1000 m
# sparsely, a run descends 1000 → 800 m densely, a second lift climbs back.

_T0 = _dt.datetime(2026, 3, 1, 9, 0, 0, tzinfo=_dt.timezone.utc)


def _semi(deg: float) -> int:
    return int(deg * 2**31 / 180)


def _synthetic_fit(*, splits: bool = True, laps: bool = True) -> bytes:
    """One tiny ski day: lift → run → lift. Times/positions line up so the
    producer labels (when present) and the cadence rule agree."""
    from garmin_fit_sdk import Encoder

    enc = Encoder()
    enc.write_mesg(
        {
            "mesg_num": 0,
            "type": "activity",
            "manufacturer": "development",
            "time_created": _T0,
        }
    )
    # (offset_s, lat, lng, alt): lift sparse (150 s), run dense (3 s), lift sparse.
    fixes: list[tuple[int, float, float, float]] = [
        (0, 50.0000, -122.9500, 800.0),
        (150, 50.0010, -122.9510, 900.0),
        (300, 50.0020, -122.9520, 1000.0),
    ]
    for i in range(1, 11):
        fixes.append(
            (300 + i * 3, 50.0020 - i * 0.0001, -122.9520 - i * 0.0001, 1000.0 - i * 20.0)
        )
    run_end = 300 + 10 * 3
    fixes += [
        (run_end + 150, 50.0015, -122.9515, 900.0),
        (run_end + 300, 50.0025, -122.9525, 1000.0),
    ]
    for offset, lat, lng, alt in fixes:
        enc.write_mesg(
            {
                "mesg_num": 20,
                "timestamp": _T0 + _dt.timedelta(seconds=offset),
                "position_lat": _semi(lat),
                "position_long": _semi(lng),
                "altitude": alt,
                "speed": 5.0,
                "distance": float(offset),
            }
        )
    if splits:
        enc.write_mesg(
            {
                "mesg_num": 312,
                "message_index": 0,
                "split_type": "ski_lift_split",
                "start_time": _T0,
                "end_time": _T0 + _dt.timedelta(seconds=300),
                "total_distance": 250.0,
                "total_ascent": 200,
                "total_descent": 0,
            }
        )
        enc.write_mesg(
            {
                "mesg_num": 312,
                "message_index": 1,
                "split_type": "ski_run_split",
                "start_time": _T0 + _dt.timedelta(seconds=300),
                "end_time": _T0 + _dt.timedelta(seconds=run_end),
                "total_distance": 150.0,
                "total_ascent": 0,
                "total_descent": 200,
            }
        )
        enc.write_mesg(
            {
                "mesg_num": 312,
                "message_index": 2,
                "split_type": "ski_lift_split",
                "start_time": _T0 + _dt.timedelta(seconds=run_end),
                "end_time": _T0 + _dt.timedelta(seconds=run_end + 300),
                "total_distance": 250.0,
                "total_ascent": 200,
                "total_descent": 0,
            }
        )
    if laps:
        enc.write_mesg(
            {
                "mesg_num": 19,
                "message_index": 0,
                "start_time": _T0 + _dt.timedelta(seconds=300),
                "total_timer_time": float(run_end - 300),
                "total_elapsed_time": float(run_end - 300),
                "total_distance": 150.0,
                "total_ascent": 0,
                "total_descent": 200,
            }
        )
    enc.write_mesg(
        {
            "mesg_num": 18,
            "sport": "snowboarding",
            "total_distance": 150.0,
            "total_ascent": 400,
            "total_descent": 200,
            "start_time": _T0,
            "timestamp": _T0,
            "event": "session",
            "event_type": "stop",
        }
    )
    return enc.close()


def _leg_types(feature: dict) -> list[str]:
    return [leg["type"] for leg in feature["properties"]["legs"]]


def _assert_cover(feature: dict) -> None:
    """Legs tile the line exactly: 0 → N-1, ordered, no gaps."""
    coords = feature["geometry"]["coordinates"]
    legs = feature["properties"]["legs"]
    assert legs[0]["startIndex"] == 0
    assert legs[-1]["endIndex"] == len(coords) - 1
    for prev, leg in zip(legs, legs[1:]):
        assert leg["startIndex"] == prev["endIndex"] + 1
        assert leg["startIndex"] <= leg["endIndex"]
    props = feature["properties"]
    assert props["rideDistanceM"] + props["liftDistanceM"] == pytest.approx(
        props["distanceM"], abs=0.2
    )


# ------------------------------------------------------------------ FIT splits


def test_fit_splits_become_alternating_legs() -> None:
    """Producer labels win: lift → ride → lift with the climb on the lifts."""
    feature = parse_fit(_synthetic_fit(), "day.fit")
    assert _leg_types(feature) == ["lift", "ride", "lift"]
    _assert_cover(feature)
    props = feature["properties"]
    # The dense run (~10 × ~13 m pairs) is the riding distance.
    assert 100 < props["rideDistanceM"] < 180
    assert props["liftDistanceM"] > 0
    assert props["liftVerticalM"] > 300  # both lifts climb 800 → 1000
    ride = [leg for leg in props["legs"] if leg["type"] == "ride"][0]
    assert ride["ascentM"] < 5  # the run only descends


def test_fit_laps_back_up_splits_when_present() -> None:
    """Laps alone (no splits) classify the same day identically."""
    feature = parse_fit(_synthetic_fit(splits=False, laps=True), "day.fit")
    assert _leg_types(feature) == ["lift", "ride", "lift"]
    _assert_cover(feature)


def test_fit_cadence_fallback_without_splits_or_laps() -> None:
    """No producer labels at all — the >2 min cadence rule still splits."""
    feature = parse_fit(_synthetic_fit(splits=False, laps=False), "day.fit")
    assert _leg_types(feature) == ["lift", "ride", "lift"]
    _assert_cover(feature)


# ------------------------------------------------------------------ FIT errors


def test_fit_garbage_names_the_file() -> None:
    with pytest.raises(FitError) as exc:
        parse_fit(b"definitely not a FIT file", "day.fit")
    assert "day.fit" in str(exc.value)


def test_fit_without_positions_is_rejected() -> None:
    from garmin_fit_sdk import Encoder

    enc = Encoder()
    enc.write_mesg(
        {
            "mesg_num": 0,
            "type": "activity",
            "manufacturer": "development",
            "time_created": _T0,
        }
    )
    enc.write_mesg(
        {
            "mesg_num": 20,
            "timestamp": _T0,
            "altitude": 800.0,
            "speed": 0.0,
            "distance": 0.0,
        }
    )
    with pytest.raises(FitError) as exc:
        parse_fit(enc.close(), "empty.fit")
    assert "empty.fit" in str(exc.value)


def test_fit_oversize_is_rejected() -> None:
    with pytest.raises(FitError) as exc:
        parse_fit(b"\x0e" * (8 * 1024 * 1024 + 1), "huge.fit")
    assert "huge.fit" in str(exc.value)


# ------------------------------------------------------------------ GPX cadence


def test_gpx_cadence_splits_lift_from_ride() -> None:
    """Dense descent + sparse climb: the logged (dense) figure survives."""
    gpx = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Slopes" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Lift then run</name><trkseg>
    <trkpt lat="50.0000" lon="-122.9500"><ele>800.0</ele><time>2026-03-01T09:00:00Z</time></trkpt>
    <trkpt lat="50.0010" lon="-122.9510"><ele>900.0</ele><time>2026-03-01T09:05:00Z</time></trkpt>
    <trkpt lat="50.0020" lon="-122.9520"><ele>1000.0</ele><time>2026-03-01T09:10:00Z</time></trkpt>
    <trkpt lat="50.0019" lon="-122.9519"><ele>980.0</ele><time>2026-03-01T09:10:03Z</time></trkpt>
    <trkpt lat="50.0018" lon="-122.9518"><ele>960.0</ele><time>2026-03-01T09:10:06Z</time></trkpt>
  </trkseg></trk>
</gpx>
""".encode()
    feature = parse_gpx(gpx, "day.gpx").to_feature()
    assert _leg_types(feature) == ["lift", "ride"]
    _assert_cover(feature)
    props = feature["properties"]
    # Dense pairs (~2 × ~13 m) are the riding figure; the lift is the rest.
    assert props["rideDistanceM"] < 60
    assert props["liftDistanceM"] > 200
    assert props["liftVerticalM"] == pytest.approx(200.0, abs=1.0)


def test_gpx_without_times_is_one_ride_leg() -> None:
    """Undated pairs stay ride (pre-#290 behaviour) — never a guessed lift."""
    gpx = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <rtept lat="50.0000" lon="-122.9500"></rtept>
    <rtept lat="50.0010" lon="-122.9510"></rtept>
  </rte>
</gpx>
""".encode()
    feature = parse_gpx(gpx, "route.gpx").to_feature()
    assert _leg_types(feature) == ["ride"]
    props = feature["properties"]
    assert props["rideDistanceM"] == props["distanceM"]
    assert props["liftDistanceM"] == 0


# ------------------------------------------------------------------ shared core


def test_decimation_keeps_every_leg_boundary() -> None:
    """2500 alternating points on a 2000 budget: every leg survives, tiled."""
    points = [
        LegPoint(lat=50.0 + i * 0.00001, lng=-122.95, time="2026-03-01T09:00:00Z")
        for i in range(2500)
    ]
    pair_is_ride = [(i // 100) % 2 == 0 for i in range(2499)]
    feature = build_feature(points, pair_is_ride)
    coords = feature["geometry"]["coordinates"]
    assert len(coords) <= RESPONSE_MAX_POINTS + 25  # joints duplicate
    assert [leg["type"] for leg in feature["properties"]["legs"]] == (
        ["ride", "lift"] * 13
    )[:25]
    _assert_cover(feature)


# ------------------------------------------------------------------ HTTP round trip


def test_fit_upload_track_endpoint_and_block_attach(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    """`.fit` rides the whole path: upload → parse endpoint → activity track."""
    g = graph("editor")
    token = _token_of(rsa_keypair)
    blob = _synthetic_fit()
    up = client.post(
        "/api/files",
        data={"tripId": g.root},
        files={"file": ("day.fit", blob, "application/vnd.ant.fit")},
        headers=_auth(token),
    )
    assert up.status_code == 200, up.text
    name = up.json()["name"]
    assert name.endswith(".fit")

    r = client.get(f"/api/tracks/{g.root}/{name}", headers=_auth(token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert [leg["type"] for leg in body["properties"]["legs"]] == [
        "lift",
        "ride",
        "lift",
    ]
    assert body["properties"]["url"] == f"/media/{g.root}/{name}"

    trip = client.get(f"/api/trips/{g.root}", headers=_auth(token)).json()
    day_id = trip["days"][0]["id"]
    created = client.post(
        f"/api/trips/{g.root}/blocks",
        json={
            "kind": "activity",
            "container": {"type": "day", "id": day_id},
            "title": "Powder day",
            "track": name,
        },
        headers=_auth(token),
    )
    assert created.status_code == 201, created.text


def test_track_endpoint_still_404_on_non_track_files(
    client: TestClient, graph, media_store, rsa_keypair
) -> None:
    """Only .gpx/.fit parse — a .txt is a 404, not a parse attempt."""
    g = graph("editor")
    token = _token_of(rsa_keypair)
    assert (
        client.get(
            f"/api/tracks/{g.root}/{'0' * 32}.txt", headers=_auth(token)
        ).status_code
        == 404
    )


# ------------------------------------------------- the real Slopes day (opt-in)
# Niko's own files — kept OUT of git (public repo). Hand the paths in and the
# suite proves both paths agree on the same activity within the tolerance the
# two different exports (Slopes FIT vs. Strava GPX re-export) allow.

_REAL_FIT = os.environ.get("KISEKI_REAL_FIT", "")
_REAL_GPX = os.environ.get("KISEKI_REAL_GPX", "")
_needs_real_files = pytest.mark.skipif(
    not (_REAL_FIT and _REAL_GPX and os.path.exists(_REAL_FIT) and os.path.exists(_REAL_GPX)),
    reason="needs KISEKI_REAL_FIT + KISEKI_REAL_GPX (Niko's Slopes day, not in git)",
)


@_needs_real_files
def test_real_slopes_day_fit_labels_all_legs() -> None:
    """11 runs + 12 lifts, alternating from the morning lift; the ride sum
    lands within metres of the session's own 18775.5 m total."""
    with open(_REAL_FIT, "rb") as fh:
        feature = parse_fit(fh.read(), "real.fit")
    types = _leg_types(feature)
    assert types.count("ride") == 11
    assert types.count("lift") == 12
    assert types[0] == "lift" and types[-1] == "lift"
    assert all(a != b for a, b in zip(types, types[1:]))  # strict alternation
    props = feature["properties"]
    assert props["rideDistanceM"] == pytest.approx(18775.5, abs=50)
    _assert_cover(feature)


@_needs_real_files
def test_real_slopes_day_gpx_cadence_agrees() -> None:
    """The Strava GPX re-export of the same day: dense segments reproduce the
    logged figure, and every substantial lift leg net-climbs (lift, not lunch)."""
    with open(_REAL_GPX, "rb") as fh:
        feature = parse_gpx(fh.read(), "real.gpx").to_feature()
    props = feature["properties"]
    assert props["rideDistanceM"] == pytest.approx(18775.5, abs=1000)
    for leg in props["legs"]:
        if leg["type"] == "lift" and leg["distanceM"] > 100:
            assert leg["ascentM"] > 50
    _assert_cover(feature)
