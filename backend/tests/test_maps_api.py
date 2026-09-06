"""Map proxy endpoints (#18/#27/#37).

After #37 the static-map proxy is gone — the booklet renders the SAME
MapLibre map live via Playwright, so basemap/markers/routes are identical
on screen and on paper. Only /api/maps/route (HERE Routing v8 → GeoJSON)
remains; the key endpoint is gone and the proxies are bounded and scoped.
"""

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app.main import app
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
    main_mod._here_bearer_cache = None


@pytest.fixture
def trip_token() -> str:
    trips = load_trips()
    assert trips, "no trip data found under backend/data/trips/"
    return trips[0].id


@pytest.fixture
def trip_id() -> str:
    trips = load_trips()
    assert trips, "no trip data found under backend/data/trips/"
    return trips[0].id


def test_maps_key_endpoint_is_gone(trip_token: str) -> None:
    """#27: no route may hand the routing token to the browser, ever again.

    Asserted as a 404 rather than by deleting the route, because the SPA
    catch-all would otherwise answer /api/maps/key with a 200 and the index
    shell — which reads like the endpoint is still there.
    """
    r = client.get("/api/maps/key")
    assert r.status_code == 404
    assert "AIza" not in r.text


def test_static_endpoint_is_gone(trip_token: str) -> None:
    """#37: the static Maps proxy is deleted — booklet now renders MapLibre live."""
    r = client.get(f"/api/maps/static/{trip_token}", params={"places": "A,B"})
    assert r.status_code == 404


def test_route_requires_a_valid_trip_token() -> None:
    r = client.get("/api/maps/route/not-a-real-token", params={"places": "A,B"})
    assert r.status_code == 404


def test_route_returns_geojson_legs(monkeypatch, trip_token: str) -> None:
    trip = load_trips()[0]
    if len(trip.locations) < 2:
        pytest.skip("first trip has fewer than two located places")
    names = [loc.name for loc in trip.locations if loc.lat is not None][:2]

    calls: list[tuple] = []

    def fake_route_legs(places, key, *, loop=False):
        calls.append((tuple(p[0] for p in places), key, loop))
        return [
            {
                "from": places[0][0],
                "to": places[1][0],
                "road": True,
                "duration": "1 hour 35 mins",
                "distance": "143 km",
                "geometry": {"type": "LineString", "coordinates": [[2.0, 1.0], [4.0, 3.0]]},
            }
        ]

    monkeypatch.setattr(main_mod, "route_legs", fake_route_legs)
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "secret-token-123")

    r = client.get(f"/api/maps/route/{trip_token}", params={"places": ",".join(names)})
    assert r.status_code == 200
    legs = r.json()["legs"]
    assert len(legs) == 1
    assert legs[0]["geometry"]["type"] == "LineString"
    assert legs[0]["duration"] == "1 hour 35 mins"
    # the token is never echoed back to the client
    assert "secret-token-123" not in r.text

    # second identical call is served from cache — one map view per leg per
    # visitor would otherwise be one HERE routing call every mount
    client.get(f"/api/maps/route/{trip_token}", params={"places": ",".join(names)})
    assert len(calls) == 1


def test_route_needs_two_resolvable_places(monkeypatch, trip_token: str) -> None:
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    r = client.get(f"/api/maps/route/{trip_token}", params={"places": "Nowhere,Neverland"})
    assert r.status_code == 404


def test_route_is_rate_limited(monkeypatch, trip_token: str) -> None:
    """A share link must not be usable as free routing quota (#27)."""
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    # unresolvable places short-circuit before any routing call, but AFTER the
    # limiter — which is exactly the ordering being asserted here
    for _ in range(60):
        client.get(f"/api/maps/route/{trip_token}", params={"places": "Nowhere,Neverland"})
    r = client.get(f"/api/maps/route/{trip_token}", params={"places": "Nowhere,Neverland"})
    assert r.status_code == 429


# --- Addressing by $dtId (one graph read instead of two) ------------------


def _two_places() -> list[str]:
    trip = load_trips()[0]
    return [loc.name for loc in trip.locations if loc.lat is not None][:2]


def test_route_accepts_the_trip_dtid(monkeypatch, trip_id: str) -> None:
    """The frontend addresses maps by id: in graph mode that is one read
    (fetch_graph) where a token costs two (find_trip_dtid_by_token first)."""
    names = _two_places()
    if len(names) < 2:
        pytest.skip("first trip has fewer than two located places")
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    monkeypatch.setattr(
        main_mod,
        "route_legs",
        lambda places, key, *, loop=False: [
            {"from": places[0][0], "to": places[1][0], "road": True, "duration": None,
             "distance": None, "geometry": {"type": "LineString", "coordinates": [[2.0, 1.0], [4.0, 3.0]]}}
        ],
    )
    r = client.get(f"/api/maps/route/{trip_id}", params={"places": ",".join(names)})
    assert r.status_code == 200
    assert len(r.json()["legs"]) == 1


def test_id_forms_cache_entry(monkeypatch, trip_id: str, trip_token: str) -> None:
    """The cache is keyed on the resolved trip, not on the path param, so the
    two spellings of the same trip do not each pay for a routing call."""
    names = _two_places()
    if len(names) < 2:
        pytest.skip("first trip has fewer than two located places")
    calls: list[int] = []

    def fake_route_legs(places, key, *, loop=False):
        calls.append(1)
        return [{"from": places[0][0], "to": places[1][0], "road": True, "duration": None,
                 "distance": None, "geometry": {"type": "LineString", "coordinates": [[2.0, 1.0], [4.0, 3.0]]}}]

    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    monkeypatch.setattr(main_mod, "route_legs", fake_route_legs)
    client.get(f"/api/maps/route/{trip_id}", params={"places": ",".join(names)})
    client.get(f"/api/maps/route/{trip_token}", params={"places": ",".join(names)})
    assert len(calls) == 1


def test_unknown_dtid_is_404(monkeypatch) -> None:
    monkeypatch.setattr(main_mod, "here_bearer_token", lambda: "k")
    r = client.get("/api/maps/route/00000000-0000-0000-0000-000000000000", params={"places": "A,B"})
    assert r.status_code == 404
