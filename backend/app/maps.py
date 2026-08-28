"""Google Maps helpers — dynamic JS map (client) + static map proxy (PDF/print).

The static map URL is built server-side so the API key never leaves the backend;
the JS map key is served via /api/maps/key for the private SPA (restrict it to the
site's referrer in Google Cloud Console).

Real driving routes come from the Directions API (encoded polylines, server-side
for the static maps; DirectionsService client-side for the JS maps), so maps show
the actual road route — and the loop map closes back to the start.

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
        enc = f"enc:{polyline}"
    else:
        pts = [f"{lat:.6f},{lng:.6f}" for _, lat, lng in places]
        if loop:
            pts.append(pts[0])
        enc = "|".join(pts)
    # white casing + theme-colored line = readable route on any basemap
    path = f"color:0xFFFFFF|weight:7|{enc}|color:{path_color}|weight:4|{enc}"
    q = [
        "size=" + size,
        "scale=" + str(scale),
        "maptype=" + maptype,
        "path=" + _enc(path),
        "markers=" + _enc(markers),
        "key=" + urllib.parse.quote(key, safe=""),
    ]
    return "https://maps.googleapis.com/maps/api/staticmap?" + "&".join(q)
