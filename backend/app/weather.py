"""Open-Meteo forecast proxy — live snow weather for trips (#334).

The browser never talks to Open-Meteo directly: ``GET
/api/weather/forecast`` proxies through the backend (same trust pattern as
the ``/api/places/*`` proxies, issue #95), so a future key/param change
touches one place and repeat mounts share one short-TTL display cache.

Compliance frame (#15/#95 standing decision): nothing weather-derived is
ever persisted. The curated payload lives only in this short-TTL
in-process cache and in React state. Open-Meteo needs no API key; the data
licence is CC BY 4.0, so every response carries the attribution the UI must
render (``attribution`` below).

Graceful absence: any Open-Meteo error/timeout/unparseable payload answers
``None`` — callers treat that as ``{"available": False}`` (HTTP 200) so
cards silently render nothing. Trip data is always complete without this
overlay.

No forecast API reaches trips planned months out — this overlay only lights
up inside the 16-day forecast window. Outside it the UI renders nothing
(the honest empty state) and the existing snow-report links carry the
planning story.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

#: Open-Meteo Forecast API (no key, free non-commercial ≤10k calls/day).
OPENMETEO_URL = "https://api.open-meteo.com/v1/forecast"

#: Attribution the UI must render (CC BY 4.0 data licence).
ATTRIBUTION = {"source": "Open-Meteo", "url": "https://open-meteo.com/"}

#: Display cache TTL — a card-render burst (15 trip days × N places) shares
#: one upstream call; entries die with the process. Minutes, not days.
_FORECAST_TTL = 1800.0  # 30 min

#: Hard cap — Open-Meteo serves at most 16 forecast days.
_MAX_DAYS = 16

_forecast_cache: dict[str, tuple[float, dict]] = {}


def clear_caches() -> None:
    """Test isolation — drop the display cache."""
    _forecast_cache.clear()


def _get_json(url: str) -> dict | None:
    """One Open-Meteo GET. Returns the parsed body, or None on any failure.

    Never raises — HTTP errors, timeouts and bad JSON are all "no overlay".
    Separated for the test seam (monkeypatch this, not urlopen).
    """
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read())
    except (urllib.error.URLError, OSError, ValueError):
        return None


def forecast(lat: float, lng: float, days: int = 7) -> dict | None:
    """Curated snow forecast for one point — the live overlay payload.

    ``days`` is clamped to 1..16 (Open-Meteo's horizon). Returns None when
    the coordinates are out of range or Open-Meteo fails — callers treat
    that as "no overlay".
    """
    if lat is None or lng is None:
        return None
    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    if not (-90.0 <= lat_f <= 90.0 and -180.0 <= lng_f <= 180.0):
        return None
    try:
        n_days = max(1, min(int(days), _MAX_DAYS))
    except (TypeError, ValueError):
        n_days = 7

    cache_key = f"{round(lat_f, 3)},{round(lng_f, 3)},{n_days}"
    now = time.monotonic()
    hit = _forecast_cache.get(cache_key)
    if hit and hit[0] > now:
        return hit[1]

    params = urllib.parse.urlencode(
        {
            "latitude": lat_f,
            "longitude": lng_f,
            "current": "temperature_2m,snowfall,weather_code",
            "hourly": "snow_depth",
            "daily": (
                "weather_code,temperature_2m_max,temperature_2m_min,"
                "snowfall_sum,precipitation_probability_max"
            ),
            "timezone": "auto",
            "forecast_days": n_days,
        }
    )
    data = _get_json(f"{OPENMETEO_URL}?{params}")
    out = _curate(lat_f, lng_f, data)
    if out is None:
        return None
    if len(_forecast_cache) > 512:
        _forecast_cache.clear()
    _forecast_cache[cache_key] = (now + _FORECAST_TTL, out)
    return out


def _curate(lat: float, lng: float, data: dict | None) -> dict | None:
    """Prune the upstream payload to the shape the UI renders."""
    if not isinstance(data, dict):
        return None
    daily = data.get("daily")
    if not isinstance(daily, dict) or not daily.get("time"):
        return None
    times = daily.get("time") or []
    n = len(times)

    def _col(name: str) -> list:
        col = daily.get(name)
        if not isinstance(col, list):
            return [None] * n
        return col + [None] * (n - len(col))

    wmo = _col("weather_code")
    tmax = _col("temperature_2m_max")
    tmin = _col("temperature_2m_min")
    snow = _col("snowfall_sum")
    prob = _col("precipitation_probability_max")

    # Snow depth (base) — hourly noon sample per local day. Best effort:
    # a short/missing series only drops the depth field, never the day.
    depth_by_date: dict[str, float | None] = {}
    raw_hourly = data.get("hourly")
    hourly: dict = raw_hourly if isinstance(raw_hourly, dict) else {}
    h_times = hourly.get("time")
    h_depth = hourly.get("snow_depth")
    if isinstance(h_times, list) and isinstance(h_depth, list):
        for t, d in zip(h_times, h_depth):
            if isinstance(t, str) and "T12:00" in t and isinstance(d, (int, float)):
                depth_by_date[t.split("T")[0]] = d

    days_out = []
    for i, date in enumerate(times):
        if not isinstance(date, str):
            continue
        days_out.append(
            {
                "date": date,
                "wmo": wmo[i] if isinstance(wmo[i], int) else None,
                "tmax_c": tmax[i] if isinstance(tmax[i], (int, float)) else None,
                "tmin_c": tmin[i] if isinstance(tmin[i], (int, float)) else None,
                "snowfall_cm": snow[i] if isinstance(snow[i], (int, float)) else None,
                "precip_prob": prob[i] if isinstance(prob[i], (int, float)) else None,
                "snow_depth_m": depth_by_date.get(date),
            }
        )
    if not days_out:
        return None

    current = data.get("current") if isinstance(data.get("current"), dict) else {}
    cur = {
        "time": current.get("time"),
        "temp_c": current.get("temperature_2m")
        if isinstance(current.get("temperature_2m"), (int, float))
        else None,
        "snowfall_cm": current.get("snowfall")
        if isinstance(current.get("snowfall"), (int, float))
        else None,
        "wmo": current.get("weather_code")
        if isinstance(current.get("weather_code"), int)
        else None,
    }
    return {
        "available": True,
        "lat": lat,
        "lng": lng,
        "timezone": data.get("timezone"),
        "current": cur,
        "daily": days_out,
        "attribution": dict(ATTRIBUTION),
    }
