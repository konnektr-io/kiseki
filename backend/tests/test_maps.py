from app.maps import build_static_map_url, resolve_places
from app.models import Location, Trip


def _trip_with_locations():
    t = Trip(
        slug="t",
        title="T",
        token="tok",
        locations=[
            Location(name="YYC", alias=["Calgary"], lat=51.1215, lng=-114.0079),
            Location(name="Banff", lat=51.1784, lng=-115.5708),
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
    t.locations.append(Location(name="NoCoords"))
    assert resolve_places(t, ["YYC", "NoCoords"]) == [("YYC", 51.1215, -114.0079)]


def test_build_static_map_url_contains_markers_path_and_key():
    from urllib.parse import unquote

    places = [("YYC", 51.1215, -114.0079), ("Banff", 51.1784, -115.5708)]
    url = unquote(build_static_map_url(places, "secret-key-123"))
    assert "staticmap" in url
    assert "key=secret-key-123" in url
    assert "label:1|51.121500,-114.007900" in url
    assert "label:2|51.178400,-115.570800" in url
    assert "path=" in url and "51.121500,-114.007900|51.178400,-115.570800" in url
    assert "size=640x400" in url
