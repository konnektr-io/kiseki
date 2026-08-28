"""Google Maps helpers — dynamic JS map (client) + static map proxy (PDF/print).

The static map URL is built server-side so the API key never leaves the backend;
the JS map key is served via /api/maps/key for the private SPA (restrict it to the
site's referrer in Google Cloud Console).

Marker labels come from the trip.locations order (① ② … → 1, 2, …), the same data
that drives the UI markers — one source of truth for all maps.
"""

from __future__ import annotations

from urllib.parse import quote


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


def build_static_map_url(
    places: list[tuple[str, float, float]],
    key: str,
    *,
    size: str = "640x400",
    scale: int = 2,
    marker_color: str = "0x1e3a8a",
    path_color: str = "0x0f766e",
) -> str:
    """Google Static Maps URL: numbered markers per place + connecting polyline."""
    if not places:
        raise ValueError("no places")
    markers = []
    path = []
    for i, (name, lat, lng) in enumerate(places, start=1):
        markers.append(f"color:{marker_color}|label:{i}|{lat:.6f},{lng:.6f}")
        path.append(f"{lat:.6f},{lng:.6f}")
    q = [
        "size=" + size,
        "scale=" + str(scale),
        "maptype=roadmap",
        "path=" + quote(f"color:{path_color}|weight:4|" + "|".join(path)),
        "markers=" + quote("|".join(markers)),
        "key=" + quote(key),
    ]
    return "https://maps.googleapis.com/maps/api/staticmap?" + "&".join(q)
