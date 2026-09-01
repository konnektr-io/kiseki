"""Google Maps helpers — every one of them SERVER-SIDE (#27).

The browser never calls Google. MapLibre renders the basemap from keyless
tiles, and everything that still needs Google — Directions for the real road
route and the live drive time, Geocoding for an exact pin, Static Maps for the
booklet — happens here, behind /api/maps/*, so the key never leaves the
backend. `GET /api/maps/key` is gone; do not reintroduce a client-side key.

Real driving routes come from the Directions API (encoded polylines, decoded to
GeoJSON for the dynamic map, passed through raw for the static one), so maps
show the actual road route — and the loop map closes back to the start.

ENCODING GOTCHA: Google's Static Maps parser only tolerates the pipe (|) as an
encoded separator — colons (color:...) and commas (lat,lng) must stay RAW. Fully
URL-encoding the parameters makes Google emit a "staticmaperror" banner, drop the
route, and scatter stray markers.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

_PIPE_SAFE = ":,|"  # keep colons + commas raw; encode the pipes


def _enc(s: str) -> str:
    return urllib.parse.quote(s, safe=_PIPE_SAFE)


# NOTE (verified 2026-08-28, the hard way): with Niko's key, Google's static-map
# path parser renders the route ONLY when the enc polyline is passed RAW (pipes
# and all). Percent-encoding the pipes (%7C) or double-encoding drops the whole
# path silently (map renders with pins but no route). Also: enc: must be the LAST
# element of a path parameter — a second styled segment after it (e.g. a white
# "casing") breaks the render. And URLs must stay under ~8192 chars (hard 400
# beyond that) — long multi-leg routes should be split into per-leg path params.


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


def directions_polyline(places: list[tuple[str, float, float]], key: str, *, loop: bool = False) -> str | None:
    """Fetch the real driving route (encoded overview polyline) from the Directions API.

    loop=True routes first → … → last → first (closes the loop). Returns None on any
    failure so callers can fall back to straight lines.
    """
    if len(places) < 2:
        return None
    origin = f"{places[0][1]:.6f},{places[0][2]:.6f}"
    dest_i = 0 if loop else len(places) - 1
    dest = f"{places[dest_i][1]:.6f},{places[dest_i][2]:.6f}"
    # waypoints = everything between origin and destination (all-but-first for a loop)
    middle = places[1:] if loop else places[1:dest_i] if dest_i > 1 else []
    params: dict[str, str] = {
        "origin": origin,
        "destination": dest,
        "key": key,
    }
    if middle:
        params["waypoints"] = "|".join(f"{lat:.6f},{lng:.6f}" for _, lat, lng in middle)
    url = "https://maps.googleapis.com/maps/api/directions/json?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.load(resp)
    except Exception:
        return None
    if data.get("status") != "OK" or not data.get("routes"):
        return None
    return data["routes"][0]["overview_polyline"]["points"]


def build_static_map_url(
    places: list[tuple[str, float, float]],
    key: str,
    *,
    size: str = "640x400",
    scale: int = 2,
    maptype: str = "terrain",
    path_color: str = "0x0f766e",
    polyline: str | None = None,
    loop: bool = False,
) -> str:
    """Google Static Maps URL: plain pins + real route (or straight fallback).

    NOTE: styled markers (color:/label:) are intentionally NOT used — with this
    API key Google renders every marker with the first style + a staticmaperror
    banner (verified against Google's own docs example). Plain pins are clean.
    """
    if not places:
        raise ValueError("no places")
    markers = "|".join(f"{lat:.6f},{lng:.6f}" for _, lat, lng in places)
    if polyline:
        enc = "enc:" + polyline  # raw — encoding the pipes breaks the render (see note)
    else:
        pts = [f"{lat:.6f},{lng:.6f}" for _, lat, lng in places]
        if loop:
            pts.append(pts[0])
        enc = "|".join(pts)
    # single styled segment, enc LAST — weight 5 keeps the route readable on terrain
    path = f"color:{path_color}|weight:5|{enc}"
    q = [
        "size=" + size,
        "scale=" + str(scale),
        "maptype=" + maptype,
        "path=" + _enc(path),
        "markers=" + _enc(markers),
        "key=" + urllib.parse.quote(key, safe=""),
    ]
    return "https://maps.googleapis.com/maps/api/staticmap?" + "&".join(q)


def resolve_query(query: str, key: str) -> tuple[float, float] | None:
    """Geocode a free-text query (e.g. "Banff Inn Banff") → (lat, lng)."""
    try:
        url = "https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode(
            {"address": query, "key": key}
        )
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.load(r)
        if data.get("status") == "OK" and data.get("results"):
            loc = data["results"][0]["geometry"]["location"]
            return float(loc["lat"]), float(loc["lng"])
    except Exception:
        pass
    return None


def build_single_place_url(
    place: tuple[str, float, float],
    key: str,
    *,
    size: str = "640x300",
    scale: int = 2,
    maptype: str = "terrain",
    zoom: int = 13,
) -> str:
    """Centered pin map for a single place (hotel/restaurant card thumbnail)."""
    _, lat, lng = place
    return (
        "https://maps.googleapis.com/maps/api/staticmap?"
        + "&".join([
            "size=" + size,
            "scale=" + str(scale),
            "maptype=" + maptype,
            f"center={lat:.6f},{lng:.6f}",
            f"zoom={zoom}",
            "markers=" + _enc(f"{lat:.6f},{lng:.6f}"),
            "key=" + urllib.parse.quote(key, safe=""),
        ])
    )


def build_static_map_url_legs(
    places: list[tuple[str, float, float]],
    key: str,
    *,
    size: str = "640x400",
    scale: int = 2,
    maptype: str = "terrain",
    path_color: str = "0x1e3a8a",
    loop: bool = False,
) -> str:
    """Per-leg static map: one path parameter per consecutive pair (loop closes).

    Used as a fallback when the combined route fails, and the shape that supports
    mixed transport later (each leg its own directions call; non-drive legs are
    skipped or drawn as straight lines).
    """
    pairs = [(places[i], places[i + 1]) for i in range(len(places) - 1)]
    if loop:
        pairs.append((places[-1], places[0]))
    q = ["size=" + size, "scale=" + str(scale), "maptype=" + maptype]
    for a, b in pairs:
        poly = directions_polyline([a, b], key)
        if poly:
            q.append("path=" + _enc(f"color:{path_color}|weight:5|enc:{poly}"))
        else:
            # straight-line fallback for that leg (e.g. a flight)
            q.append("path=" + _enc(f"color:{path_color}|weight:3|{a[1]:.6f},{a[2]:.6f}|{b[1]:.6f},{b[2]:.6f}"))
    q.append("markers=" + _enc("|".join(f"{lat:.6f},{lng:.6f}" for _, lat, lng in places)))
    q.append("key=" + urllib.parse.quote(key, safe=""))
    return "https://maps.googleapis.com/maps/api/staticmap?" + "&".join(q)



# --- Dynamic map support (#18/#27) ---------------------------------------
#
# The client no longer talks to Google at all: MapLibre renders geometry, and
# the geometry comes from here. Directions stays on Google (MapLibre renders,
# it does not route) but the call is server-side, so the key never ships.


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


if __name__ == "__main__":
    # smoke test: python app/maps.py <key>
    import sys

    key = sys.argv[1]
    places = [("YYC", 51.1215, -114.0079), ("Banff", 51.1784, -115.5708)]
    print(build_static_map_url(places, key)[:160])
    print(build_static_map_url_legs(places, key)[:160])
