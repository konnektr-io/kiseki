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
