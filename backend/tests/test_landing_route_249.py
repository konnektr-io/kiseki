"""The landing page's example route (#249).

`GET /api/landing-route` is anonymous and fixed: five Tokyo stops in pin order,
one HERE leg per consecutive pair. It exists because the geometry cannot live in
the repo — HERE's terms allow routing results outside the platform for 30 days
at most (Japan: 24 h), so committing the polyline is not an option.
"""
import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app.main import app
from app.ratelimit import reset as reset_rate_limits

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    reset_rate_limits()
    main_mod._landing_route_cache = None
    yield
    reset_rate_limits()
    main_mod._landing_route_cache = None
    main_mod._here_bearer_cache = None


def _all_road_legs(places, key):
    """Four legs, three points each, joints shared — like the real thing."""
    legs = []
    n = 0
    for i in range(len(places) - 1):
        a, b = places[i], places[i + 1]
        legs.append(
            {
                "from": a[0],
                "to": b[0],
                "road": True,
                "duration": "20 mins",
                "distance": "8.0 km",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[a[2], a[1]], [a[2] + 0.001, a[1] + 0.001], [b[2], b[1]]],
                },
            }
        )
        n += 1
    assert n == 4
    return legs


def test_landing_route_serves_road_geometry_anonymously(monkeypatch) -> None:
    calls: list = []

    def fake_route_legs(places, key):
        calls.append(key)
        return _all_road_legs(places, key)

    monkeypatch.setattr(main_mod, "route_legs", fake_route_legs)
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "secret-token-123")

    r = client.get("/api/landing-route")
    assert r.status_code == 200
    body = r.json()
    assert body["road"] is True
    coords = body["coordinates"]
    # 4 legs × 3 points, joints deduped: 4*3 - 3 = 9
    assert len(coords) == 9
    # every point is [lng, lat] inside Tokyo
    for lng, lat in coords:
        assert 139.0 < lng < 140.0
        assert 35.0 < lat < 36.0
    # the token is never echoed back to the client
    assert "secret-token-123" not in r.text

    # second call is served from cache — one HERE call per 5 minutes, not one
    # per visitor who scrolls to the map
    client.get("/api/landing-route")
    assert len(calls) == 1


def test_landing_route_degrades_to_straight_lines(monkeypatch) -> None:
    """One failed leg poisons nothing: the whole answer is the straight line.

    A partial answer would mix real roads with straight segments without saying
    so — `road: false` tells the map to draw what it always drew.
    """
    legs = _all_road_legs([(n, la, ln) for n, la, ln in main_mod._LANDING_ROUTE_STOPS], "k")
    legs[2] = {**legs[2], "road": False}
    monkeypatch.setattr(main_mod, "route_legs", lambda places, key: legs)
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")

    r = client.get("/api/landing-route")
    assert r.status_code == 200
    body = r.json()
    assert body["road"] is False
    assert body["coordinates"] == [
        [lng, lat] for _, lat, lng in main_mod._LANDING_ROUTE_STOPS
    ]


def test_landing_route_without_here_is_straight_lines(monkeypatch) -> None:
    """HERE unconfigured (or the token refused) is HTTP 200, not a 404.

    The landing page must never break because routing is down — the map keeps
    its stop-to-stop lines, which is also what it draws before the fetch lands.
    """
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: None)

    r = client.get("/api/landing-route")
    assert r.status_code == 200
    assert r.json() == {
        "road": False,
        "coordinates": [[lng, lat] for _, lat, lng in main_mod._LANDING_ROUTE_STOPS],
    }


def test_landing_route_takes_no_coordinates(monkeypatch) -> None:
    """This is not a routing proxy: caller-supplied waypoints are ignored.

    An anonymous endpoint that routes arbitrary pairs would be a free HERE
    proxy on our key — the coordinates are fixed server-side, full stop.
    (Bearer forced off so the answer is the deterministic straight line.)
    """
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: None)

    r = client.get("/api/landing-route", params={"origin": "0,0", "destination": "1,1"})
    assert r.status_code == 200
    assert r.json()["coordinates"][0] == [139.70955, 35.68507]
