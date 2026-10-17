"""A chain gap is never road-routed (#433).

The itinerary map asks for the whole chain in ONE request, one `modes` entry
per leg. A leg with no transport block of its own is a chain GAP — a pair
between two base stops that nobody authored travel for. Until this fix the
client sent an empty slot for it, which is the "no declaration" value, so the
backend answered with a real road route: the Peru 2027 trip drew a 797 km
drive across the Andes on a leg the traveller flies (Lima → Cusco), and the
map read the phantom as an authored car route.

The gap now has its own word: `GAP_MODE` ("gap"). It skips HERE entirely and
comes back `road: False` with straight endpoint geometry, which the client
draws as the great-circle arc — dashed and dim, the surface's existing
vocabulary for "no plan here" (DESIGN.md §5.3/§8.4).

What deliberately does NOT change: an EMPTY slot and an absent `modes`
parameter still keep the road default. An empty slot means "this caller has
no declaration for leg i" (an unclassified transport block is still travel),
and a caller that declares nothing at all is not describing chain gaps.
"""

from fastapi.testclient import TestClient

from app import main as main_mod
from app import maps as maps_mod
from app.main import app
from app.maps import GAP_MODE, parse_leg_modes, route_legs
from app.ratelimit import reset as reset_rate_limits
from app.store import load_trips

client = TestClient(app)

A, B, C, D = ("A", 0.0, 0.0), ("B", 1.0, 1.0), ("C", 2.0, 2.0), ("D", 3.0, 3.0)


def _route_everything(monkeypatch) -> list[tuple[str, str]]:
    """Route whatever HERE is asked for, recording the pairs."""
    routed: list[tuple[str, str]] = []

    def fake_leg(a, b, token, *, transport_mode="car"):
        routed.append((a[0], b[0]))
        return {"points": [(a[1], a[2]), (b[1], b[2])], "duration": "2 hours", "distance": "150 km"}

    monkeypatch.setattr(maps_mod, "route_leg_v8", fake_leg)
    return routed


# --- the gap never reaches HERE -------------------------------------------


def test_gap_leg_skips_here_and_echoes_no_mode(monkeypatch):
    """The reported leg: nobody authored it, so nothing is routed."""
    routed = _route_everything(monkeypatch)

    legs = route_legs([A, B], "k", modes=parse_leg_modes(GAP_MODE))

    assert routed == []
    assert legs[0]["road"] is False
    # "gap" is not a transport mode — the client would read it as one.
    assert legs[0]["mode"] is None
    assert legs[0]["duration"] is None
    assert legs[0]["distance"] is None
    # Geometry is the two endpoints; the CLIENT arcs it (great-circle).
    assert legs[0]["geometry"]["coordinates"] == [[A[2], A[1]], [B[2], B[1]]]


def test_gap_between_declared_legs_keeps_alignment(monkeypatch):
    """`flight,gap,drive`: only the drive routes, and slots never shift."""
    routed = _route_everything(monkeypatch)

    legs = route_legs([A, B, C, D], "k", modes=parse_leg_modes(f"flight,{GAP_MODE},drive"))

    assert [leg["mode"] for leg in legs] == ["flight", None, "drive"]
    assert [leg["road"] for leg in legs] == [False, False, True]
    assert routed == [("C", "D")]


def test_every_leg_a_gap_is_a_dashed_arc_trip(monkeypatch):
    """A sketch chain (no transport blocks at all) draws no road at all."""
    routed = _route_everything(monkeypatch)

    legs = route_legs([A, B, C], "k", modes=parse_leg_modes(f"{GAP_MODE},{GAP_MODE}"))

    assert routed == []
    assert all(leg["road"] is False for leg in legs)
    assert all(leg["mode"] is None for leg in legs)


# --- the road default is untouched for "no declaration" -------------------


def test_empty_slot_still_keeps_the_road_default(monkeypatch):
    """An unclassified transport block sends an empty slot — it still routes.

    This is the line between #407 and #433: empty = "no declaration for this
    leg" (travel the author did create a card for), gap = "nothing authored".
    """
    routed = _route_everything(monkeypatch)

    legs = route_legs([A, B], "k", modes=parse_leg_modes(","))

    assert routed == [("A", "B")]
    assert legs[0]["road"] is True
    assert legs[0]["mode"] is None


def test_absent_modes_keep_the_road_default(monkeypatch):
    """A caller that declares nothing is not describing a chain (#407 intact)."""
    routed = _route_everything(monkeypatch)

    legs = route_legs([A, B, C], "k", modes=parse_leg_modes(None))

    assert routed == [("A", "B"), ("B", "C")]
    assert all(leg["road"] for leg in legs)


def test_gap_is_a_valid_positional_entry():
    """The sentinel survives parsing like any other entry — including holes."""
    assert parse_leg_modes(f"flight,{GAP_MODE},drive") == ["flight", GAP_MODE, "drive"]
    assert parse_leg_modes(f"{GAP_MODE},") == [GAP_MODE, None]


def test_a_repeated_place_is_just_consecutive_pairs(monkeypatch):
    """A VISIT chain repeats a base (#433): Lima → Huaraz → Lima → Cusco.

    The repeated name needs no special handling — the endpoint pairs the list
    positionally, so the way back is a leg of its own with its own mode.
    """
    routed = _route_everything(monkeypatch)

    legs = route_legs([A, B, A, C], "k", modes=parse_leg_modes("drive,drive,flight"))

    assert [(leg["from"], leg["to"]) for leg in legs] == [
        ("A", "B"),
        ("B", "A"),
        ("A", "C"),
    ]
    assert [leg["mode"] for leg in legs] == ["drive", "drive", "flight"]
    assert [leg["road"] for leg in legs] == [True, True, False]
    # The repeated pair is routed twice (there and back), and only the flight
    # skips HERE.
    assert routed == [("A", "B"), ("B", "A")]


# --- the endpoint ----------------------------------------------------------


def _widest_trip() -> tuple[str, list[str]]:
    trips = [t for t in load_trips() if sum(1 for loc in t.locations if loc.lat is not None) >= 3]
    assert trips, "no trip in backend/data/trips/ has three or more located places"
    trip = max(trips, key=lambda t: sum(1 for loc in t.locations if loc.lat is not None))
    return trip.id, [loc.name for loc in trip.locations if loc.lat is not None]


def test_endpoint_answers_a_gap_without_a_road(monkeypatch):
    """`?modes=gap,drive` over the live trip shape: leg 0 is not a car route."""
    reset_rate_limits()
    main_mod._route_cache.clear()
    routed = _route_everything(monkeypatch)
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    trip_id, names = _widest_trip()

    r = client.get(
        f"/api/maps/route/{trip_id}",
        params={"places": ",".join(names[:3]), "modes": f"{GAP_MODE},drive"},
    )
    assert r.status_code == 200
    legs = r.json()["legs"]
    assert len(legs) == 2
    assert legs[0]["road"] is False
    assert legs[0]["mode"] is None
    assert legs[1]["road"] is True
    assert routed == [(names[1], names[2])]
    main_mod._route_cache.clear()
    reset_rate_limits()
