"""Empty `modes` entries are positional, not holes to drop (#407).

The itinerary map asks for the whole chain in ONE request with one `modes`
entry per leg, and a chain gap (a short hop between two registry places that
has no transport block) rides along as an EMPTY entry:

    GET /api/maps/route/<trip_id>?places=A,B,C,D&modes=flight,,train,flight

The endpoint used to split `modes` and DISCARD the empty entries, so every
leg after the first gap slid one slot left. A gap in slot 1 turned the
`flight` in slot 2 into slot 1's leg, and the trip's FINAL flight got no mode
at all — answered with a real road route (1094 km / 21 h 11 mins drawn as a
drive) while the day page, which fetches each leg with its own explicit mode,
showed the flight correctly.

No error, no 4xx — just silent misalignment that got worse with every extra
gap. These tests pin the positional contract at both levels: the parser, and
the endpoint round trip.
"""

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app import maps as maps_mod
from app.main import app
from app.maps import parse_leg_modes, route_legs
from app.ratelimit import reset as reset_rate_limits
from app.store import load_trips

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_limits():
    reset_rate_limits()
    main_mod._route_cache.clear()
    yield
    reset_rate_limits()
    main_mod._route_cache.clear()


# --- the parser ------------------------------------------------------------


def test_parse_leg_modes_keeps_the_hole_positional():
    """The reported failure: `flight,,drive` must not become `flight,drive`."""
    assert parse_leg_modes("flight,,drive") == ["flight", None, "drive"]


def test_parse_leg_modes_keeps_every_gap():
    assert parse_leg_modes("flight,,drive,drive,train,,train,flight") == [
        "flight",
        None,
        "drive",
        "drive",
        "train",
        None,
        "train",
        "flight",
    ]


def test_parse_leg_modes_trailing_gap_is_not_dropped():
    """A chain that ends on a gap is a real chain shape — keep the slot."""
    assert parse_leg_modes("drive,") == ["drive", None]


def test_parse_leg_modes_trims_whitespace_around_entries():
    """`a, b` is one entry with a stray space, not a gap."""
    assert parse_leg_modes(" flight , drive ") == ["flight", "drive"]
    # A whitespace-only entry IS a gap — the client sends "" for those.
    assert parse_leg_modes("flight,   ,drive") == ["flight", None, "drive"]


def test_parse_leg_modes_absent_means_no_declarations():
    """No parameter at all → None, so callers keep skipping the whole feature.

    Deliberately None and not []: the route cache and `route_legs` both treat
    a falsy mode list as "no per-leg declarations", and [] with holes would be
    a lie about how many legs were described.
    """
    assert parse_leg_modes(None) is None
    assert parse_leg_modes("") is None
    assert parse_leg_modes("   ") is None


def test_parse_leg_modes_of_only_gaps_is_still_positional():
    """A chain that is nothing but gaps describes every leg — not no legs."""
    assert parse_leg_modes(",,") == [None, None, None]


# --- route_legs honours the positional list --------------------------------


def test_route_legs_gap_does_not_shift_later_modes(monkeypatch):
    """The minimal proof from #407, at the layer that builds the legs.

    4 places → 3 legs, `modes = ["flight", None, "drive"]`: the flight is
    leg 0, leg 1 is the undeclared gap, and leg 2 is the drive. Before the fix
    the empty entry was dropped and `drive` slid up into leg 1 — leaving leg 2
    with no mode at all, answered with a real road route.
    """
    routed: list[tuple[str, str]] = []

    def fake_leg(a, b, token, *, transport_mode="car"):
        routed.append((a[0], b[0]))
        return {"points": [(1.0, 2.0)], "duration": "1 hour", "distance": "100 km"}

    monkeypatch.setattr(maps_mod, "route_leg_v8", fake_leg)
    places = [("A", 0.0, 0.0), ("B", 1.0, 1.0), ("C", 2.0, 2.0), ("D", 3.0, 3.0)]
    legs = route_legs(places, "k", modes=parse_leg_modes("flight,,drive"))

    assert [leg["mode"] for leg in legs] == ["flight", None, "drive"]
    assert [leg["road"] for leg in legs] == [False, True, True]
    # The gap and the final drive are both road legs (undeclared → the
    # historical car default); only the flight slot skips HERE entirely.
    assert routed == [("B", "C"), ("C", "D")]


def test_route_legs_final_flight_after_a_gap_stays_a_flight(monkeypatch):
    """The reported symptom: the trip's LAST leg drew a 21 h road route."""

    def fake_leg(a, b, token, *, transport_mode="car"):
        return {"points": [(1.0, 2.0)], "duration": "21 hours 11 mins", "distance": "1094 km"}

    monkeypatch.setattr(maps_mod, "route_leg_v8", fake_leg)
    places = [("A", 0.0, 0.0), ("B", 1.0, 1.0), ("C", 2.0, 2.0), ("D", 3.0, 3.0)]
    legs = route_legs(places, "k", modes=parse_leg_modes("drive,,flight"))

    assert [leg["mode"] for leg in legs] == ["drive", None, "flight"]
    assert legs[-1]["road"] is False
    assert legs[-1]["duration"] is None
    assert legs[-1]["distance"] is None


def test_route_legs_all_gaps_keep_the_road_default(monkeypatch):
    """Undeclared legs (a chain with no transport blocks at all) all route."""
    monkeypatch.setattr(
        maps_mod,
        "route_leg_v8",
        lambda a, b, token, *, transport_mode="car": {
            "points": [(1.0, 2.0)],
            "duration": "30 mins",
            "distance": "20 km",
        },
    )
    places = [("A", 0.0, 0.0), ("B", 1.0, 1.0), ("C", 2.0, 2.0)]
    legs = route_legs(places, "k", modes=parse_leg_modes(","))
    assert [leg["mode"] for leg in legs] == [None, None]
    assert all(leg["road"] for leg in legs)


# --- the endpoint ----------------------------------------------------------


def _widest_trip() -> tuple[str, list[str]]:
    """The mock trip with the most located places — and its id.

    `load_trips()[0]` has only six, which silently skipped the 9-leg chain
    (the actual reported repro) on every run. The widest mock trip carries
    enough places for the whole chain, so the headline case is really
    executed rather than quietly turned into a skip.
    """
    trips = [t for t in load_trips() if sum(1 for loc in t.locations if loc.lat is not None) >= 4]
    assert trips, "no trip in backend/data/trips/ has four or more located places"
    trip = max(trips, key=lambda t: sum(1 for loc in t.locations if loc.lat is not None))
    names = [loc.name for loc in trip.locations if loc.lat is not None]
    return trip.id, names


@pytest.fixture
def _stub_routing(monkeypatch):
    """Route every leg, and record which pairs HERE was asked for."""
    routed: list[tuple[str, str]] = []
    monkeypatch.setattr(
        maps_mod,
        "route_leg_v8",
        lambda a, b, token, *, transport_mode="car": (
            routed.append((a[0], b[0]))
            or {"points": [(a[1], a[2])], "duration": "2 hours", "distance": "150 km"}
        ),
    )
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    monkeypatch.setattr(
        main_mod,
        "route_legs",
        lambda places, key, *, loop=False, modes=None: route_legs(
            places, key, loop=loop, modes=modes
        ),
    )
    return routed


def test_endpoint_keeps_empty_modes_positional(_stub_routing):
    """`GET /api/maps/route?places=A,B,C&modes=flight,,drive` — leg 1 is the
    gap (`mode: null`) and leg 2 keeps its own drive."""
    trip_id, names = _widest_trip()
    r = client.get(
        f"/api/maps/route/{trip_id}",
        params={"places": ",".join(names[:3]), "modes": "flight,,drive"},
    )
    assert r.status_code == 200
    legs = r.json()["legs"]
    assert len(legs) == 2
    assert legs[0]["mode"] == "flight"
    assert legs[0]["road"] is False
    # The gap: preserved as its own leg, not slid out of the list.
    assert legs[1]["mode"] is None
    assert legs[1]["road"] is True


def test_endpoint_gap_does_not_shift_a_longer_chain(_stub_routing):
    """The full reported chain: the last leg must still be the flight.

    9 modes over 10 places with two gaps. Before the fix legs 6 and 7 took the
    values that belonged to legs 7 and 8, and leg 8 fell off the end of the
    list entirely — so it was answered with a real 1094 km road route.
    """
    trip_id, names = _widest_trip()
    if len(names) < 10:
        pytest.skip(f"widest mock trip has only {len(names)} located places")
    modes = "flight,drive,flight,drive,drive,train,,train,flight"
    r = client.get(
        f"/api/maps/route/{trip_id}",
        params={"places": ",".join(names[:10]), "modes": modes},
    )
    assert r.status_code == 200
    legs = r.json()["legs"]
    assert len(legs) == len(modes.split(",")) == 9
    assert [leg["mode"] for leg in legs] == [
        "flight",
        "drive",
        "flight",
        "drive",
        "drive",
        "train",
        None,
        "train",
        "flight",
    ]
    # The final flight is a flight: straight line, no road distance/time.
    assert legs[-1]["road"] is False
    assert legs[-1]["duration"] is None
    assert legs[-1]["distance"] is None


def test_endpoint_modes_shorter_than_places_still_covers_the_tail(_stub_routing):
    """Documented behaviour kept: a short list leaves tail legs undeclared."""
    trip_id, names = _widest_trip()
    r = client.get(
        f"/api/maps/route/{trip_id}",
        params={"places": ",".join(names[:3]), "modes": "flight"},
    )
    assert r.status_code == 200
    legs = r.json()["legs"]
    assert [leg["mode"] for leg in legs] == ["flight", None]


def test_endpoint_gap_and_no_gap_are_different_cache_entries(monkeypatch):
    """The cache key must keep the holes.

    `flight,,train` and `flight,train` describe different legs, so a response
    built for one must never be served for the other — the two used to hash
    to the same key because the empty entry had already been discarded.
    """
    trip_id, names = _widest_trip()
    seen: list[list[str | None]] = []

    def fake_route_legs(places, key, *, loop=False, modes=None):
        seen.append(list(modes) if modes else [])
        return [
            {
                "from": places[i][0],
                "to": places[i + 1][0],
                "road": True,
                "mode": (modes[i] if modes and i < len(modes) else None),
                "duration": None,
                "distance": None,
                "geometry": {"type": "LineString", "coordinates": [[1.0, 2.0]]},
            }
            for i in range(len(places) - 1)
        ]

    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    monkeypatch.setattr(main_mod, "route_legs", fake_route_legs)

    gapped = client.get(
        f"/api/maps/route/{trip_id}",
        params={"places": ",".join(names[:3]), "modes": "flight,,train"},
    ).json()
    dense = client.get(
        f"/api/maps/route/{trip_id}",
        params={"places": ",".join(names[:3]), "modes": "flight,train"},
    ).json()

    # Two distinct requests → two routing passes, not one cached answer.
    assert len(seen) == 2
    assert [leg["mode"] for leg in gapped["legs"]] == ["flight", None]
    assert [leg["mode"] for leg in dense["legs"]] == ["flight", "train"]


def test_endpoint_without_modes_is_unchanged(_stub_routing):
    """No `modes` at all: every leg is an undeclared road leg."""
    trip_id, names = _widest_trip()
    r = client.get(
        f"/api/maps/route/{trip_id}", params={"places": ",".join(names[:3])}
    )
    assert r.status_code == 200
    legs = r.json()["legs"]
    assert [leg["mode"] for leg in legs] == [None, None]
    assert all(leg["road"] for leg in legs)
