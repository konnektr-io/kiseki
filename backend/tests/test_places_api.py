"""Live place overlay endpoints (#95) — Google Places (New) behind the proxy.

The key stays server-side; failures answer {"available": false} (HTTP 200)
so cards render nothing instead of breaking. Photo bytes are proxied with a
short-TTL in-process cache — nothing Google-derived is ever persisted
(#15/#95 storage rule). All external calls are mocked here.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app import places as places_mod
from app.main import app
from app.ratelimit import reset as reset_rate_limits

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    reset_rate_limits()
    places_mod.clear_caches()
    yield
    reset_rate_limits()
    places_mod.clear_caches()


def _google_details_body():
    return {
        "id": "ChIJtest123",
        "rating": 4.4,
        "userRatingCount": 1092,
        "googleMapsUri": "https://maps.google.com/?cid=123",
        "reviews": [
            {
                "text": {"text": "Best powder in Hokkaido.", "languageCode": "en"},
                "relativePublishTimeDescription": "a month ago",
                "authorAttribution": {
                    "displayName": "Snow Fan",
                    "uri": "https://www.google.com/maps/contrib/1",
                },
                "googleMapsUri": "https://maps.google.com/?cid=123&review=1",
            },
            {
                "text": {"text": "Second review.", "languageCode": "en"},
                "authorAttribution": {"displayName": "B", "uri": "https://x/b"},
            },
            {
                "text": {"text": "Third review.", "languageCode": "en"},
                "authorAttribution": {"displayName": "C", "uri": "https://x/c"},
            },
            {
                "text": {"text": "Fourth — must be dropped.", "languageCode": "en"},
                "authorAttribution": {"displayName": "D", "uri": "https://x/d"},
            },
        ],
        "photos": [
            {
                "name": "places/ChIJtest123/photos/abc",
                "widthPx": 2000,
                "heightPx": 1500,
                "authorAttributions": [{"displayName": "Snow Fan"}],
            },
            {"name": "places/ChIJtest123/photos/def", "widthPx": 100, "heightPx": 100},
            {"name": "places/ChIJtest123/photos/ghi", "widthPx": 100, "heightPx": 100},
            {"name": "places/ChIJtest123/photos/jkl", "widthPx": 100, "heightPx": 100},
        ],
    }


def test_place_details_no_key_is_none(monkeypatch):
    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "")
    calls = []

    def boom(*a, **k):
        calls.append(1)
        raise AssertionError("Google must not be called without a key")

    monkeypatch.setattr(places_mod, "_request", boom)
    assert places_mod.place_details("ChIJtest123") is None
    assert not calls


def test_place_details_happy_path_shape_and_cache(monkeypatch):
    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "secret-key")
    calls = []

    def fake_request(url, **kwargs):
        calls.append(url)
        return 200, json.dumps(_google_details_body()).encode()

    monkeypatch.setattr(places_mod, "_request", fake_request)
    out = places_mod.place_details("ChIJtest123")
    assert out["available"] is True
    assert out["rating"] == 4.4
    assert out["userRatingCount"] == 1092
    assert out["googleMapsUri"] == "https://maps.google.com/?cid=123"
    # reviews capped at 3, author attribution carried
    assert len(out["reviews"]) == 3
    assert out["reviews"][0]["text"] == "Best powder in Hokkaido."
    assert out["reviews"][0]["authorName"] == "Snow Fan"
    assert out["reviews"][0]["authorUri"] == "https://www.google.com/maps/contrib/1"
    # photos: metadata only, capped at 3 — never bytes
    assert len(out["photos"]) == 3
    assert out["photos"][0]["name"] == "places/ChIJtest123/photos/abc"
    assert out["photos"][0]["authorAttributions"] == [{"displayName": "Snow Fan"}]
    # second call is served from the TTL cache — no second Google hit
    places_mod.place_details("ChIJtest123")
    assert len(calls) == 1


def test_place_details_google_failure_is_none(monkeypatch):
    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "secret-key")
    monkeypatch.setattr(places_mod, "_request", lambda *a, **k: (500, b"boom"))
    assert places_mod.place_details("ChIJtest123") is None
    # malformed JSON — the same quiet None
    monkeypatch.setattr(places_mod, "_request", lambda *a, **k: (200, b"not json"))
    assert places_mod.place_details("ChIJtest123") is None


def test_photo_media_url_never_propagates_a_keyed_url(monkeypatch):
    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "secret-key")

    def keyed(*a, **k):
        return 200, b'{"photoUri": "https://lh3.google.com/img?key=secret-key"}'

    monkeypatch.setattr(places_mod, "_request", keyed)
    assert places_mod.photo_media_url("places/p/photos/x") is None

    def clean(*a, **k):
        return 200, b'{"photoUri": "https://lh3.google.com/img?w=400"}'

    monkeypatch.setattr(places_mod, "_request", clean)
    assert places_mod.photo_media_url("places/p/photos/x") == "https://lh3.google.com/img?w=400"


def test_photo_by_name_shape_guard_blocks_arbitrary_urls(monkeypatch):
    """The /api/places/photo proxy only ever resolves photo resource names —
    never an arbitrary URL (no open proxy)."""

    def boom(*a, **k):
        raise AssertionError("no fetch may happen for a non photo-resource ref")

    monkeypatch.setattr(places_mod, "photo_media_url", boom)
    assert places_mod.photo_by_name("https://evil.example.com/secret") is None
    assert places_mod.photo_by_name("../../etc/passwd") is None
    assert places_mod.photo_by_name("") is None


def test_photo_by_name_happy_path_and_content_type(monkeypatch):
    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "secret-key")
    monkeypatch.setattr(places_mod, "photo_media_url", lambda name, **k: "https://lh3/img")
    calls = []

    def fake_fetch(uri, **k):
        calls.append(uri)
        return (b"\x89PNG\r\n\x1a\nfakepng", "image/png")

    monkeypatch.setattr(places_mod, "photo_bytes", fake_fetch)
    got = places_mod.photo_by_name("places/ChIJtest123/photos/abc")
    assert got == (b"\x89PNG\r\n\x1a\nfakepng", "image/png")
    assert calls == ["https://lh3/img"]


def test_photo_bytes_sniffs_content_type_and_caches(monkeypatch):
    calls = []

    def fake_request(url, **kwargs):
        calls.append(url)
        return 200, b"\xff\xd8\xff\xe0jpegbytes"

    monkeypatch.setattr(places_mod, "_request", fake_request)
    raw, ctype = places_mod.photo_bytes("https://lh3/img")
    assert ctype == "image/jpeg"
    places_mod.photo_bytes("https://lh3/img")
    assert len(calls) == 1  # TTL cache absorbed the second fetch


# ------------------------------------------------------------------ endpoints


def test_details_endpoint_unavailable(monkeypatch):
    monkeypatch.setattr(main_mod, "place_details", lambda pid: None)
    r = client.get("/api/places/details/ChIJtest123")
    assert r.status_code == 200
    assert r.json() == {"available": False}


def test_details_endpoint_payload(monkeypatch):
    monkeypatch.setattr(
        main_mod,
        "place_details",
        lambda pid: {"available": True, "placeId": pid, "rating": 4.4},
    )
    r = client.get("/api/places/details/ChIJtest123")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["rating"] == 4.4


def test_photo_endpoint_serves_bytes(monkeypatch):
    monkeypatch.setattr(
        main_mod, "place_photo_bytes", lambda ref: (b"fakepng", "image/png")
    )
    r = client.get("/api/places/photo", params={"ref": "places/p/photos/x"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
    assert r.headers["cache-control"] == "private, max-age=900"
    assert r.content == b"fakepng"


def test_photo_endpoint_404_when_unavailable(monkeypatch):
    monkeypatch.setattr(main_mod, "place_photo_bytes", lambda ref: None)
    r = client.get("/api/places/photo", params={"ref": "places/p/photos/gone"})
    assert r.status_code == 404


# ------------------------------------------- venue resolution (#187)

def _google_search_body():
    return {
        "places": [
            {
                "id": "ChIJgyoen123",
                "displayName": {"text": "Shinjuku Gyoen National Garden"},
                "formattedAddress": "11 Naitomachi, Shinjuku City, Tokyo",
                "location": {"latitude": 35.6852, "longitude": 139.7100},
                "googleMapsUri": "https://maps.google.com/?cid=9",
                "primaryType": "national_park",
            }
        ]
    }


def test_search_place_resolves_a_venue_name(monkeypatch):
    """A venue NAME in → the durable place_id + exact coordinates out (#187).

    This is the step that turns an activity anchored to "Tokyo" into a real
    venue pin; before it, nothing in the API could resolve a name.
    """
    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "secret-key")
    calls = []

    def fake_request(url, *, method="GET", field_mask=None, body=None):
        calls.append({"url": url, "method": method, "mask": field_mask, "body": body})
        return 200, json.dumps(_google_search_body()).encode()

    monkeypatch.setattr(places_mod, "_request", fake_request)

    out = places_mod.search_place("Shinjuku Gyoen, Tokyo")
    assert out is not None
    assert out["available"] is True
    assert out["placeId"] == "ChIJgyoen123"
    assert out["name"] == "Shinjuku Gyoen National Garden"
    assert out["lat"] == 35.6852 and out["lng"] == 139.71
    assert out["address"].startswith("11 Naitomachi")
    assert out["primaryType"] == "national_park"

    assert len(calls) == 1
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"].endswith("/places:searchText")
    assert calls[0]["mask"].startswith("places.id")
    assert json.loads(calls[0]["body"])["textQuery"] == "Shinjuku Gyoen, Tokyo"

    # a repeat lookup is served from the TTL cache — one Google call, not two
    places_mod.search_place("shinjuku gyoen, tokyo")
    assert len(calls) == 1


def test_search_place_is_none_without_key_match_or_on_failure(monkeypatch):
    """Every miss is the same quiet None — callers treat them identically."""
    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "")
    calls = []

    def boom(*a, **k):
        calls.append(1)
        raise AssertionError("Google must not be called without a key")

    monkeypatch.setattr(places_mod, "_request", boom)
    assert places_mod.search_place("Shinjuku Gyoen") is None
    assert not calls

    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "secret-key")
    monkeypatch.setattr(places_mod, "_request", lambda *a, **k: (200, b'{"places": []}'))
    assert places_mod.search_place("nowhere at all") is None
    monkeypatch.setattr(places_mod, "_request", lambda *a, **k: (403, b"denied"))
    assert places_mod.search_place("nowhere at all (2)") is None
    monkeypatch.setattr(places_mod, "_request", lambda *a, **k: (200, b"not json"))
    assert places_mod.search_place("nowhere at all (3)") is None
    # an id-less place is not a resolution either
    monkeypatch.setattr(
        places_mod, "_request",
        lambda *a, **k: (200, json.dumps({"places": [{"displayName": {"text": "X"}}]}).encode()),
    )
    assert places_mod.search_place("nowhere at all (4)") is None


def test_search_endpoint_payload_and_unavailable(monkeypatch):
    monkeypatch.setattr(main_mod, "search_place", lambda q, *, near=None, radius_m=None: None)
    r = client.get("/api/places/search", params={"q": "nothing here"})
    assert r.status_code == 200
    assert r.json() == {"available": False}

    seen: dict = {}

    def recording_search(q, *, near=None, radius_m=None):
        seen["q"], seen["near"], seen["radius_m"] = q, near, radius_m
        return {"available": True, "placeId": "ChIJ1", "lat": 1.0, "lng": 2.0, "query": q}

    monkeypatch.setattr(main_mod, "search_place", recording_search)
    r = client.get("/api/places/search", params={"q": "Shinjuku Gyoen"})
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True and body["placeId"] == "ChIJ1"
    assert seen["near"] is None and seen["radius_m"] is None  # a bare query stays bare

    # #255: a caller that knows where the trip is pins the ranking there
    r = client.get(
        "/api/places/search",
        params={"q": "Café Central", "lat": 9.93, "lng": -84.08, "radius": 200_000},
    )
    assert r.status_code == 200
    assert seen["q"] == "Café Central"
    assert seen["near"] == (9.93, -84.08)
    assert seen["radius_m"] == 200_000

    # half a coordinate is not a bias: either both or none
    r = client.get("/api/places/search", params={"q": "Hotel Presidente", "lat": 9.93})
    assert r.status_code == 200
    assert seen["near"] is None and seen["radius_m"] is None


def test_search_endpoint_needs_a_query(monkeypatch):
    monkeypatch.setattr(
        main_mod, "search_place", lambda q, *, near=None, radius_m=None: {"available": True, "placeId": "x"}
    )
    assert client.get("/api/places/search").status_code == 422
    assert client.get("/api/places/search", params={"q": "a"}).status_code == 422


def test_request_sends_content_type_with_a_body(monkeypatch):
    """Guard for the ordering bug found while adding searchText: urllib
    snapshots headers when the Request is built, so a Content-Type added after
    that never reached the wire and Google rejected the POST body."""
    captured = {}

    class _Resp:
        status = 200

        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(req, timeout=None):
        captured["content_type"] = req.get_header("Content-type")
        captured["method"] = req.get_method()
        return _Resp()

    monkeypatch.setattr(places_mod, "GOOGLE_MAPS_API_KEY", "secret-key")
    monkeypatch.setattr(places_mod.urllib.request, "urlopen", fake_urlopen)

    places_mod._request("https://example.test/x", method="POST", body=b"{}")
    assert captured["content_type"] == "application/json"
    assert captured["method"] == "POST"
