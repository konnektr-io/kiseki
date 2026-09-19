"""Live snow forecast endpoint (#334) — Open-Meteo behind the proxy.

Same contract as the /api/places/* overlay: failures answer
{"available": false} (HTTP 200) so cards render nothing instead of
breaking, and nothing weather-derived is ever persisted. All external
calls are mocked here.
"""

from fastapi.testclient import TestClient

import pytest

from app import main as main_mod
from app import weather as weather_mod
from app.main import app
from app.ratelimit import reset as reset_rate_limits

client = TestClient(app)


def _upstream(days=("2026-09-19", "2026-09-20"), hourly=True):
    body = {
        "timezone": "America/Edmonton",
        "current": {
            "time": "2026-09-19T00:45",
            "temperature_2m": 4.3,
            "snowfall": 0.0,
            "weather_code": 0,
        },
        "daily": {
            "time": list(days),
            "weather_code": [0, 71],
            "temperature_2m_max": [9.1, 2.0],
            "temperature_2m_min": [-2.5, -6.0],
            "snowfall_sum": [0.0, 12.4],
            "precipitation_probability_max": [5, 90],
        },
    }
    if hourly:
        body["hourly"] = {
            "time": [f"{d}T12:00" for d in days],
            "snow_depth": [0.0, 0.35],
        }
    return body


@pytest.fixture(autouse=True)
def _clean():
    reset_rate_limits()
    weather_mod.clear_caches()
    yield
    reset_rate_limits()
    weather_mod.clear_caches()


def test_forecast_happy_path_curated_shape(monkeypatch):
    calls = []

    def fake_get(url):
        calls.append(url)
        assert "api.open-meteo.com" in url
        assert "forecast_days=3" in url
        return _upstream()

    monkeypatch.setattr(weather_mod, "_get_json", fake_get)
    got = weather_mod.forecast(51.0785, -115.7765, 3)
    assert got is not None
    assert got["available"] is True
    assert got["attribution"] == {"source": "Open-Meteo", "url": "https://open-meteo.com/"}
    assert got["current"] == {"time": "2026-09-19T00:45", "temp_c": 4.3, "snowfall_cm": 0.0, "wmo": 0}
    assert [d["date"] for d in got["daily"]] == ["2026-09-19", "2026-09-20"]
    powder = got["daily"][1]
    assert powder["snowfall_cm"] == 12.4
    assert powder["snow_depth_m"] == 0.35
    assert powder["tmax_c"] == 2.0
    # Second call is served from the display cache — one upstream call total.
    assert weather_mod.forecast(51.0785, -115.7765, 3) is got
    assert len(calls) == 1


def test_forecast_missing_hourly_keeps_days(monkeypatch):
    monkeypatch.setattr(weather_mod, "_get_json", lambda url: _upstream(hourly=False))
    got = weather_mod.forecast(51.0, -115.0)
    assert got is not None
    assert got["available"] is True
    assert len(got["daily"]) == 2
    assert got["daily"][0]["snow_depth_m"] is None


def test_forecast_upstream_failure_is_none(monkeypatch):
    monkeypatch.setattr(weather_mod, "_get_json", lambda url: None)
    assert weather_mod.forecast(51.0, -115.0) is None


def test_forecast_garbage_payload_is_none(monkeypatch):
    monkeypatch.setattr(weather_mod, "_get_json", lambda url: {"daily": {}})
    assert weather_mod.forecast(51.0, -115.0) is None


def test_forecast_rejects_out_of_range_coords(monkeypatch):
    calls = []

    def boom(url):
        calls.append(url)
        raise AssertionError("upstream must not be called for bad coords")

    monkeypatch.setattr(weather_mod, "_get_json", boom)
    assert weather_mod.forecast(91.0, 0.0) is None
    assert weather_mod.forecast(0.0, 181.0) is None
    assert not calls


def test_endpoint_happy_path(monkeypatch):
    monkeypatch.setattr(
        main_mod,
        "weather_forecast",
        lambda lat, lng, days: {"available": True, "daily": []},
    )
    r = client.get("/api/weather/forecast", params={"lat": 51.0785, "lng": -115.7765})
    assert r.status_code == 200
    assert r.json()["available"] is True


def test_endpoint_upstream_failure_is_available_false(monkeypatch):
    monkeypatch.setattr(main_mod, "weather_forecast", lambda lat, lng, days: None)
    r = client.get("/api/weather/forecast", params={"lat": 51.0, "lng": -115.0})
    assert r.status_code == 200
    assert r.json() == {"available": False}


def test_endpoint_rejects_bad_coords():
    r = client.get("/api/weather/forecast", params={"lat": 91, "lng": 0})
    assert r.status_code == 422
    r = client.get("/api/weather/forecast", params={"lat": 51, "lng": -200})
    assert r.status_code == 422
    r = client.get("/api/weather/forecast", params={"lat": 51, "lng": -115, "days": 17})
    assert r.status_code == 422
