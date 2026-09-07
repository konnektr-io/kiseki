"""Route helpers — server-side HERE Routing v8 → GeoJSON for MapLibre (#15).

The browser never calls a provider. MapLibre renders the basemap from keyless
tiles (OpenFreeMap positron), and the real driving route + live drive time
come from HERE Routing v8, behind /api/maps/route, so HERE credentials never
leave the backend. (2026-09 provider decision: HERE replaced Google Directions
— HERE has no "non-Google map" clause, MapLibre is HERE-official, and the
freemium tier is ~10x Google's free allowance at ~14x cheaper overage.)
Static Maps proxy is gone (#37): the booklet now renders the SAME MapLibre
map live via Playwright, so basemap / markers / route colours are identical
on screen and on paper.
"""
from __future__ import annotations

from .here import route_leg_v8

# mode → HERE transportMode when a leg has a declared transport block.
# Flights/ferries never car-route (they draw great-circle, dashed). A train
# stays on the car default: HERE Routing v8 has no `train` transportMode
# (only car/truck/pedestrian/bicycle/scooter/taxi/bus/privateBus/transit),
# and a rail card is better served by the access-road geometry than by a
# 400 and a blank.
_MODE_TRANSPORT: dict[str, str] = {"drive": "car"}


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


def route_legs(
    places: list[tuple[str, float, float]],
    token: str,
    *,
    loop: bool = False,
    modes: list[str] | None = None,
) -> list[dict]:
    """Per-leg GeoJSON for a set of places — the payload the MapLibre map draws.

    One Routing call per consecutive pair (the loop closes back to the
    start). A leg with no road route (a future flight/ferry) comes back with
    `road: false` and a straight two-point line, which the client draws
    dashed.

    ``token`` is a HERE OAuth2 bearer token (see app.here); empty/None →
    straight dashed lines for every leg (maps simply don't render).

    ``modes`` — optional parallel list of the declared transport block
    ``mode`` per leg (``drive``/``train``/``flight``/``ferry``/``None``).
    When the mode is ``flight``/``ferry`` the call is skipped entirely
    and the leg comes back ``road: False`` with straight geometry — no
    road query, no misleading car route along the highway for a leg
    that is a flight or ferry.
    """
    pairs = [(places[i], places[i + 1]) for i in range(len(places) - 1)]
    if loop and len(places) >= 2:
        pairs.append((places[-1], places[0]))
    legs: list[dict] = []
    for i, (a, b) in enumerate(pairs):
        mode = modes[i] if modes and i < len(modes) else None
        # Flights/ferries are never road legs — skip the car query.
        if mode in ("flight", "ferry"):
            legs.append(
                {
                    "from": a[0],
                    "to": b[0],
                    "road": False,
                    "duration": None,
                    "distance": None,
                    "geometry": {"type": "LineString", "coordinates": [[a[2], a[1]], [b[2], b[1]]]},
                }
            )
            continue
        tmode: str | None
        if mode in (None, "drive"):
            tmode = "car"  # undeclared legs travel like the historical default
        else:
            tmode = _MODE_TRANSPORT.get(mode)
        hit = route_leg_v8(a, b, token, transport_mode=tmode) if token else None
        if hit:
            coords = [[lng, lat] for lat, lng in hit["points"]]
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