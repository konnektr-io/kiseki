"""Location photo fields (#95, option b) — rights-clean stored imagery.

The new durable Location fields (photo / photoCredit / photoLicense /
photoSourceUrl) ride the location write paths like the other place-metadata
fields, and a bare media filename `photo` canonicalizes to
/media/<trip_id>/<file> at serialization. Never Google imagery: those live
only behind /api/places/photo.
"""

from app.models import Location, Trip
from app.media import resolve_media_urls
from app.write import LocationWrite, _location_pairs


def test_photo_fields_roundtrip_via_write_models():
    """The write API accepts the new fields and _LOCATION_PROPS carries them."""
    entry = LocationWrite.model_validate(
        {
            "name": "Rusutsu",
            "photo": "abc123.jpg",
            "photoCredit": "Photo: Rusutsu Resort",
            "photoLicense": "© resort press kit",
            "photoSourceUrl": "https://rusutsu.example/press",
        }
    )
    pairs = dict(_location_pairs(entry))
    assert pairs["photo"] == "abc123.jpg"
    assert pairs["photoCredit"] == "Photo: Rusutsu Resort"
    assert pairs["photoLicense"] == "© resort press kit"
    assert pairs["photoSourceUrl"] == "https://rusutsu.example/press"
    # absent fields stay untouched (explicit-clear contract)
    entry2 = LocationWrite.model_validate({"name": "Rusutsu", "photo": "x.jpg"})
    assert "photoCredit" not in dict(_location_pairs(entry2))


def test_photo_bare_filename_canonicalizes_to_media_url():
    """resolve_media_urls rewrites a bare photo filename like other media."""
    doc = {"locations": [{"name": "Rusutsu", "photo": "c383ce57abc.jpg"}]}
    out = resolve_media_urls(doc, "trip-uuid")
    assert out["locations"][0]["photo"] == "/media/trip-uuid/c383ce57abc.jpg"
    # external URLs pass through untouched
    doc2 = {"locations": [{"name": "R", "photo": "https://example.com/x.jpg"}]}
    out2 = resolve_media_urls(doc2, "trip-uuid")
    assert out2["locations"][0]["photo"] == "https://example.com/x.jpg"


def test_photo_fields_survive_model_roundtrip():
    """The Location model carries the fields through (graph read path uses
    model_validate directly on the twin dict)."""
    loc = Location.model_validate(
        {
            "id": "loc-1",
            "name": "Rusutsu",
            "photo": "rusutsu-winter.jpg",
            "photoCredit": "Photo: Rusutsu Resort",
            "photoLicense": "CC BY-SA 4.0",
            "photoSourceUrl": "https://rusutsu.example/press",
        }
    )
    assert loc.photo == "rusutsu-winter.jpg"
    assert loc.photoCredit == "Photo: Rusutsu Resort"
    assert loc.photoLicense == "CC BY-SA 4.0"
    assert loc.photoSourceUrl == "https://rusutsu.example/press"
    dumped = loc.model_dump()
    assert dumped["photoSourceUrl"] == "https://rusutsu.example/press"


def test_photo_fields_absent_by_default():
    loc = Location.model_validate({"id": "loc-1", "name": "Rusutsu"})
    assert loc.photo is None
    assert loc.photoCredit is None
    assert loc.photoLicense is None
    assert loc.photoSourceUrl is None
