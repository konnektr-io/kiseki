"""Route helpers — server-side Directions → GeoJSON for MapLibre (#18/#27/#37).

The browser never calls Google. MapLibre renders the basemap from keyless
tiles (OpenFreeMap positron), and the real driving route + live drive time
come from here, behind /api/maps/route, so the Google key never leaves the
backend. Static Maps proxy is gone (#37): the booklet now renders the SAME
MapLibre map live via Playwright, so basemap / markers / route colours are
identical on screen and on paper.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request


def resolve_places(trip, places: list[str]) -> list[tuple[str, float, float]]:
    """Resolve place names/aliases to (name, lat, lng) via trip.locations.

    Unknown places are skipped (caller decides if that is acceptable).
    """
    lookup: dict[str, tuple[str, float, float]] = {}
    for loc in trip.locations:
        entry = (loc.name, loc.lat, loc.lng)
        if loc.lat is None or loc.lng is None:
            continue
        lookup[loc.name.lower()] = entry
        for alias in loc.alias:
            lookup[alias.lower()] = entry
    out: list[tuple[str, float, float]] = []
    for p in places:
        hit = lookup.get(p.strip().lower())
        if hit:
            out.append(hit)
    return out


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Decode Google's encoded polyline into [(lat, lng), ...].

    Decoding server-side keeps the client free of a polyline dependency and
    lets the route reach MapLibre as plain GeoJSON.
    """
    coords: list[tuple[float, float]] = []
    index = lat = lng = 0
    length = len(encoded)
    while index < length:
        for axis in (0, 1):
            shift = result = 0
            while True:
                if index >= length:
                    return coords  # truncated input — return what decoded cleanly
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if axis == 0:
                lat += delta
            else:
                lng += delta
        coords.append((lat * 1e-5, lng * 1e-5))
    return coords


def directions_leg(
    a: tuple[str, float, float],
    b: tuple[str, float, float],
    key: str,
) -> dict | None:
    """One driving leg: encoded geometry + live duration.

    `departure_time=now` is what makes Google return `duration_in_traffic` —
    the number behind the live drive-time chip. (Do NOT add `traffic_model`:
    the JS DirectionsService rejected it outright, and the REST API only
    honours it alongside a future departure time.)

    Returns None on any failure so the caller can fall back to a straight
    line rather than dropping the leg.
    """
    params = {
        "origin": f"{a[1]:.6f},{a[2]:.6f}",
        "destination": f"{b[1]:.6f},{b[2]:.6f}",
        "mode": "driving",
        "departure_time": "now",
        "key": key,
    }
    url = "https://maps.googleapis.com/maps/api/directions/json?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.load(resp)
    except Exception:
        return None
    if data.get("status") != "OK" or not data.get("routes"):
        return None
    route = data["routes"][0]
    leg = (route.get("legs") or [{}])[0]
    duration = leg.get("duration_in_traffic") or leg.get("duration") or {}
    return {
        "points": route["overview_polyline"]["points"],
        "duration": duration.get("text"),
        "distance": (leg.get("distance") or {}).get("text"),
    }


def route_legs(places: list[tuple[str, float, float]], key: str, *, loop: bool = False) -> list[dict]:
    """Per-leg GeoJSON for a set of places — the payload the MapLibre map draws.

    One Directions call per consecutive pair (the loop closes back to the
    start), mirroring what the Google JS map did client-side. A leg with no
    road route (a future flight/ferry) comes back with `road: false` and a
    straight two-point line, which the client draws dashed.
    """
    pairs = [(places[i], places[i + 1]) for i in range(len(places) - 1)]
    if loop and len(places) >= 2:
        pairs.append((places[-1], places[0]))
    legs: list[dict] = []
    for a, b in pairs:
        hit = directions_leg(a, b, key) if key else None
        if hit:
            coords = [[lng, lat] for lat, lng in decode_polyline(hit["points"])]
            road = True
        else:
            coords, road = [[a[2], a[1]], [b[2], b[1]]], False
            hit = {"duration": None, "distance": None}
        legs.append(
            {
                "from": a[0],
                "to": b[0],
                "road": road,
                "duration": hit["duration"],
                "distance": hit["distance"],
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )
    return legs
