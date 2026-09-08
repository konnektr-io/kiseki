"""Live drive-time endpoint for drive cards (card polish).

GET /api/maps/directions?fromLat=&fromLng=&toLat=&toLng= — HERE-backed,
key server-side. Happy path serves formatted duration/distance text;
any HERE failure answers {"available": false} (HTTP 200) so cards keep
their static values. Results are cached per rounded coordinate pair.
"""

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app.main import app
from app.ratelimit import reset as reset_rate_limits

client = TestClient(app)

COORDS = {"fromLat": 43.27, "fromLng": 140.92, "toLat": 43.08, "toLng": 141.19}


@pytest.fixture(autouse=True)
def _clean():
    reset_rate_limits()
    main_mod._directions_cache.clear()
    yield
    reset_rate_limits()
    main_mod._directions_cache.clear()
    main_mod._here_bearer_cache = None


def test_directions_happy_path_and_cache(monkeypatch) -> None:
    calls: list[tuple] = []

    def fake_leg(a, b, token, *, transport_mode="car", timeout=10):
        calls.append((a, b, token, transport_mode, timeout))
        assert token == "secret-token-123"
        return {"points": [(1.0, 2.0), (3.0, 4.0)], "duration": "1 hour 35 mins", "distance": "143 km"}

    monkeypatch.setattr(main_mod, "route_leg_v8", fake_leg)
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "secret-token-123")

    r = client.get("/api/maps/directions", params=COORDS)
    assert r.status_code == 200
    assert r.json() == {"available": True, "durationText": "1 hour 35 mins", "distanceText": "143 km"}
    # the HERE token is never echoed back to the client
    assert "secret-token-123" not in r.text

    # second identical call is served from cache — scrolling days remounts cards
    client.get("/api/maps/directions", params=COORDS)
    assert len(calls) == 1
    # the leg used the short outbound timeout, not the 10s map default
    assert calls[0][4] == 5


def test_directions_here_failure_is_available_false(monkeypatch) -> None:
    """HERE down / no route / no token → HTTP 200 with available:false."""
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    monkeypatch.setattr(main_mod, "route_leg_v8", lambda *a, **k: None)
    r = client.get("/api/maps/directions", params=COORDS)
    assert r.status_code == 200
    assert r.json() == {"available": False}

    # an exception from the client is the same quiet unavailable …
    def boom(*a, **k):
        raise RuntimeError("HERE is down")

    monkeypatch.setattr(main_mod, "route_leg_v8", boom)
    main_mod._directions_cache.clear()
    r = client.get("/api/maps/directions", params=COORDS)
    assert r.status_code == 200
    assert r.json() == {"available": False}


def test_directions_without_here_config_is_available_false(monkeypatch) -> None:
    def boom(*a, **k):
        raise AssertionError("HERE must not be called without a token")

    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: None)
    monkeypatch.setattr(main_mod, "route_leg_v8", boom)
    r = client.get("/api/maps/directions", params=COORDS)
    assert r.status_code == 200
    assert r.json() == {"available": False}


def test_directions_rejects_out_of_range_coords() -> None:
    r = client.get("/api/maps/directions", params={**COORDS, "fromLat": 999})
    assert r.status_code == 422
    r = client.get("/api/maps/directions", params={"fromLat": 1})
    assert r.status_code == 422
