from app.maps import build_static_map_url, resolve_places
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


def test_build_static_map_url_contains_markers_path_and_key():
    from urllib.parse import unquote

    places = [("YYC", 51.1215, -114.0079), ("Banff", 51.1784, -115.5708)]
    url = unquote(build_static_map_url(places, "secret-key-123"))
    assert "staticmap" in url
    assert "key=secret-key-123" in url
    assert "51.121500,-114.007900|51.178400,-115.570800" in url  # plain pins
    assert "path=" in url and "51.121500,-114.007900|51.178400,-115.570800" in url
    assert "size=640x400" in url


def test_build_static_map_url_uses_encoded_polyline_when_given():
    url = build_static_map_url(
        [("YYC", 51.1215, -114.0079), ("Banff", 51.1784, -115.5708)],
        "k",
        polyline="sv_wHjdzvT",
    )
    assert "enc:sv_wHjdzvT" in url


def test_build_static_map_url_loop_appends_start():
    places = [("A", 1.0, 2.0), ("B", 3.0, 4.0), ("C", 5.0, 6.0)]
    url = build_static_map_url(places, "k", loop=True)
    assert "|1.000000,2.000000|3.000000,4.000000|5.000000,6.000000|1.000000,2.000000" in url


# --- Dynamic map payload (#18/#27) ---------------------------------------


def test_decode_polyline_google_reference_vector():
    """Google's own documented example — the encoding is easy to get subtly wrong."""
    from app.maps import decode_polyline

    pts = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    assert [(round(lat, 5), round(lng, 5)) for lat, lng in pts] == [
        (38.5, -120.2),
        (40.7, -120.95),
        (43.252, -126.453),
    ]


def test_decode_polyline_survives_truncated_input():
    from app.maps import decode_polyline

    # a chunk cut mid-varint must not raise — the pairs that completed survive
    pts = decode_polyline("_p~iF~ps|U_ulLnnqC_")
    assert [(round(lat, 5), round(lng, 5)) for lat, lng in pts] == [(38.5, -120.2), (40.7, -120.95)]


def _legs_with_stub(monkeypatch, points=None, loop=False):
    from app import maps as maps_mod

    def fake_leg(a, b, key):
        assert key == "k"
        return {"points": points, "duration": "1 hour 35 mins", "distance": "143 km"} if points else None

    monkeypatch.setattr(maps_mod, "directions_leg", fake_leg)
    places = [("A", 1.0, 2.0), ("B", 3.0, 4.0), ("C", 5.0, 6.0)]
    return maps_mod.route_legs(places, "k", loop=loop)


def test_route_legs_one_leg_per_consecutive_pair(monkeypatch):
    legs = _legs_with_stub(monkeypatch, points="_p~iF~ps|U_ulLnnqC")
    assert [(leg["from"], leg["to"]) for leg in legs] == [("A", "B"), ("B", "C")]
    assert all(leg["road"] for leg in legs)
    # GeoJSON is [lng, lat] — the flip is the classic bug here
    assert legs[0]["geometry"]["coordinates"] == [[-120.2, 38.5], [-120.95, 40.7]]
    assert legs[0]["duration"] == "1 hour 35 mins"


def test_route_legs_loop_closes_back_to_the_start(monkeypatch):
    legs = _legs_with_stub(monkeypatch, points="_p~iF~ps|U", loop=True)
    assert [(leg["from"], leg["to"]) for leg in legs] == [("A", "B"), ("B", "C"), ("C", "A")]


def test_route_legs_falls_back_to_a_straight_dashed_line(monkeypatch):
    """No road route (a flight leg, or Directions down) → the leg still renders."""
    legs = _legs_with_stub(monkeypatch, points=None)
    assert [leg["road"] for leg in legs] == [False, False]
    assert legs[0]["geometry"]["coordinates"] == [[2.0, 1.0], [4.0, 3.0]]
    assert legs[0]["duration"] is None


def test_route_legs_without_a_key_never_calls_google(monkeypatch):
    from app import maps as maps_mod

    def boom(*a, **k):
        raise AssertionError("directions_leg must not be called without a key")

    monkeypatch.setattr(maps_mod, "directions_leg", boom)
    legs = maps_mod.route_legs([("A", 1.0, 2.0), ("B", 3.0, 4.0)], "")
    assert len(legs) == 1 and legs[0]["road"] is False
