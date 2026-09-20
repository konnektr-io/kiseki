from app.maps import resolve_places
from app.models import Location, Trip


def _trip_with_locations():
    t = Trip(
        id="t",
        slug="t",
        title="T",
        token="tok",
        claimToken="claimtok",
        locations=[
            Location(id="t-yyc", name="YYC", alias=["Calgary"], lat=51.1215, lng=-114.0079),
            Location(id="t-banff", name="Banff", lat=51.1784, lng=-115.5708),
        ],
    )
    return t


def test_resolve_places_names_and_aliases():
    t = _trip_with_locations()
    resolved = resolve_places(t, ["YYC", "banff", "Calgary", "Nowhere"])
    assert [(n, round(lat, 4), round(lng, 4)) for n, lat, lng in resolved] == [
        ("YYC", 51.1215, -114.0079),
        ("Banff", 51.1784, -115.5708),
        ("YYC", 51.1215, -114.0079),
    ]


def test_resolve_places_skips_missing_coords():
    t = _trip_with_locations()
    t.locations.append(Location(id="t-nocoords", name="NoCoords"))
    assert resolve_places(t, ["YYC", "NoCoords"]) == [("YYC", 51.1215, -114.0079)]


# --- Dynamic map payload (#18/#27/#15) -----------------------------------


def test_decode_flexpolyline_reference_vector():
    """HERE's own documented example — the encoding is easy to get subtly wrong.

    Spec vector from https://github.com/heremaps/flexible-polyline
    ("B F oz5xJ 67i1B 1B 7P zI ha xL 7Y", precision 5, no 3rd dimension).
    """
    from app.here import decode_flexpolyline

    pts = decode_flexpolyline("BFoz5xJ67i1B1B7PzIhaxL7Y")
    assert [(round(lat, 5), round(lng, 5)) for lat, lng in pts] == [
        (50.10228, 8.69821),
        (50.10201, 8.69567),
        (50.10063, 8.69150),
        (50.09878, 8.68752),
    ]


def test_decode_flexpolyline_survives_truncated_input():
    from app.here import decode_flexpolyline

    # a varint cut mid-chunk must not raise — pairs that completed survive
    pts = decode_flexpolyline("BFoz5xJ67i1B1B7Po")
    # first two points decode (the third delta is incomplete), that is enough
    assert len(pts) >= 2
    assert (round(pts[0][0], 5), round(pts[0][1], 5)) == (50.10228, 8.69821)


def _legs_with_stub(monkeypatch, points=None, loop=False, modes=None):
    from app import maps as maps_mod

    def fake_leg(a, b, token, *, transport_mode="car"):
        assert token == "k"
        return (
            {"points": points, "duration": "1 hour 35 mins", "distance": "143 km"}
            if points
            else None
        )

    monkeypatch.setattr(maps_mod, "route_leg_v8", fake_leg)
    places = [("A", 1.0, 2.0), ("B", 3.0, 4.0), ("C", 5.0, 6.0)]
    return maps_mod.route_legs(places, "k", loop=loop, modes=modes)


def test_route_legs_flight_leg_skips_the_car_query(monkeypatch):
    """A declared flight leg never routes as a road — SCL→CUZ is a plane (#15)."""
    from app import maps as maps_mod

    def failing_leg(a, b, token, *, transport_mode="car"):
        raise AssertionError(f"HERE was called for a flight leg: {a[0]}→{b[0]}")

    monkeypatch.setattr(maps_mod, "route_leg_v8", failing_leg)
    places = [("Santiago", -33.4, -70.6), ("Cusco", -13.5, -72.0)]
    legs = maps_mod.route_legs(places, "k", modes=["flight"])
    assert len(legs) == 1
    assert legs[0]["road"] is False
    assert legs[0]["duration"] is None
    assert legs[0]["geometry"]["coordinates"] == [[-70.6, -33.4], [-72.0, -13.5]]


def test_route_legs_one_leg_per_consecutive_pair(monkeypatch):
    legs = _legs_with_stub(monkeypatch, points=[(38.5, -120.2), (40.7, -120.95)])
    assert [(leg["from"], leg["to"]) for leg in legs] == [("A", "B"), ("B", "C")]
    assert all(leg["road"] for leg in legs)
    # GeoJSON is [lng, lat] — the flip is the classic bug here
    assert legs[0]["geometry"]["coordinates"] == [[-120.2, 38.5], [-120.95, 40.7]]
    assert legs[0]["duration"] == "1 hour 35 mins"


def test_route_legs_loop_closes_back_to_the_start(monkeypatch):
    legs = _legs_with_stub(monkeypatch, points=[(38.5, -120.2)], loop=True)
    assert [(leg["from"], leg["to"]) for leg in legs] == [("A", "B"), ("B", "C"), ("C", "A")]


def test_route_legs_falls_back_to_a_straight_dashed_line(monkeypatch):
    """No road route (a flight leg, or Routing down) → the leg still renders."""
    legs = _legs_with_stub(monkeypatch, points=None)
    assert [leg["road"] for leg in legs] == [False, False]
    assert legs[0]["geometry"]["coordinates"] == [[2.0, 1.0], [4.0, 3.0]]
    assert legs[0]["duration"] is None


def test_route_legs_without_a_token_never_calls_here(monkeypatch):
    from app import maps as maps_mod

    def boom(*a, **k):
        raise AssertionError("route_leg_v8 must not be called without a token")

    monkeypatch.setattr(maps_mod, "route_leg_v8", boom)
    legs = maps_mod.route_legs([("A", 1.0, 2.0), ("B", 3.0, 4.0)], "")
    assert len(legs) == 1 and legs[0]["road"] is False


def test_route_legs_echo_mode_on_every_leg(monkeypatch):
    """#357 slice 3A (E1): each leg carries its declared mode back.

    Additive only — `road` stays the authoritative road/not-road signal and
    every previously asserted field is unchanged.
    """
    legs = _legs_with_stub(
        monkeypatch,
        points=[(38.5, -120.2), (40.7, -120.95)],
        modes=["drive", None],
    )
    assert [leg["mode"] for leg in legs] == ["drive", None]
    assert all(leg["road"] for leg in legs)


def test_route_legs_echo_mode_on_skipped_and_fallback_legs(monkeypatch):
    from app import maps as maps_mod

    def failing_leg(a, b, token, *, transport_mode="car"):
        raise AssertionError(f"HERE was called for a flight leg: {a[0]}→{b[0]}")

    monkeypatch.setattr(maps_mod, "route_leg_v8", failing_leg)
    places = [("Santiago", -33.4, -70.6), ("Cusco", -13.5, -72.0)]
    legs = maps_mod.route_legs(places, "k", modes=["ferry"])
    assert len(legs) == 1
    assert legs[0]["road"] is False
    assert legs[0]["mode"] == "ferry"

    # Routing down (no points) still echoes the declared mode.
    fallback = _legs_with_stub(monkeypatch, points=None, modes=["train", None])
    assert [leg["mode"] for leg in fallback] == ["train", None]
    assert all(leg["road"] is False for leg in fallback)
