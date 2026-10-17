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

# The sentinel the chain client sends for a leg with NO transport block of its
# own — a chain GAP (#433). It is not a transport mode: nobody authored travel
# on that pair, so a road would be an assertion the trip never made (a Lima →
# Cusco flight leg came back as a 797 km drive across the Andes). Gaps skip
# HERE entirely and are drawn as the client's great-circle arc, provisional
# and dashed. Deliberately distinct from an EMPTY modes entry: an empty entry
# means "this client has no declaration for leg i" (an unclassified transport
# block, or a caller that sends fewer entries) and keeps the road default,
# which is also what a request with no `modes` at all still gets.
GAP_MODE = "gap"

# Modes that are never road-routed: the traffic is not a car.
_NO_ROAD_MODES = frozenset({"flight", "ferry", GAP_MODE})


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


def parse_leg_modes(modes: str | None) -> list[str | None] | None:
    """Parse the ``modes`` query parameter into a POSITIONAL per-leg list (#407).

    ``modes`` is parallel to ``places``: entry *i* describes the leg between
    place *i* and place *i+1*. An **empty entry means "no declared mode for
    this leg"** — not "drop this index". The client renders a chain gap (a
    short hop between two registry places that has no transport block) as an
    empty CSV slot, so filtering empties out shifted every later leg one slot
    left: a flight after a gap came back as the previous leg's mode, and the
    trip's final flight was answered with a road route (1094 km / 21 h drawn
    as a drive). Silent, and the more gaps a trip had the worse it got.

    So: split, trim, and keep the hole as ``None`` — ``route_legs`` already
    treats ``None`` as "undeclared" and keeps its road default, and echoes it
    back as ``mode: null``. ``None`` (or an empty string) for the whole
    parameter means "no per-leg declarations at all" → ``None``, not ``[]``,
    so callers can keep using truthiness to skip the whole feature.
    """
    if modes is None or not modes.strip():
        return None
    return [m.strip() or None for m in modes.split(",")]


def route_legs(
    places: list[tuple[str, float, float]],
    token: str,
    *,
    loop: bool = False,
    modes: list[str | None] | None = None,
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
    that is a flight or ferry. The list is **positional**: a ``None`` in
    slot *i* is a leg with no declared mode, not a missing entry — later
    slots never move up into it (#407).

    ``GAP_MODE`` ("gap") is the chain client's word for a leg with NO
    transport block at all (#433): also skipped, also ``road: False``, but it
    echoes ``mode: None`` because "gap" is not a transport. An empty slot and
    an absent ``modes`` parameter keep the road default (an unclassified
    transport block is still travel); only the gap says "nobody authored this".

    Every leg echoes its declared ``mode`` back (additive, #357) so the
    client can style a leg by transport type. ``road`` stays the
    authoritative road/not-road signal — a reader must never infer the
    glyph from the geometry.
    """
    pairs = [(places[i], places[i + 1]) for i in range(len(places) - 1)]
    if loop and len(places) >= 2:
        pairs.append((places[-1], places[0]))
    legs: list[dict] = []
    for i, (a, b) in enumerate(pairs):
        mode = modes[i] if modes and i < len(modes) else None
        # Flights/ferries/gaps are never road legs — skip the car query.
        if mode in _NO_ROAD_MODES:
            legs.append(
                {
                    "from": a[0],
                    "to": b[0],
                    "road": False,
                    # A gap is not a transport mode: echoing it back would put
                    # a word the glyph/type layer does not know into `mode`.
                    "mode": None if mode == GAP_MODE else mode,
                    "duration": None,
                    "distance": None,
                    "geometry": {"type": "LineString", "coordinates": [[a[2], a[1]], [b[2], b[1]]]},
                }
            )
            continue
        tmode = _MODE_TRANSPORT.get(mode or "drive", "car")  # undeclared → historical car default
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
                "mode": mode,
                "duration": hit["duration"],
                "distance": hit["distance"],
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )
    return legs