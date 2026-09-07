"""Tests for scripts/verify_dtdl_models.py — the post-deploy DTDL drift checker.

Pure-function part only (no live graph access): parse the committed
``dtdl/kiseki-models.json`` shape into per-model property sets and diff them
against a simulated live registration. The live-fetch path is deliberately
untested here — it needs cluster credentials.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.verify_dtdl_models import diff_models, expected_properties, short_name

DTDL = ROOT / "dtdl" / "kiseki-models.json"
LOCATION_ID = "dtmi:kiseki:travel:Location;1"


def _mini_doc():
    return [
        {
            "@id": LOCATION_ID,
            "@type": "Interface",
            "contents": [
                {"@type": "Property", "name": "name", "schema": "string"},
                {"@type": "Property", "name": "placeId", "schema": "string"},
                {"@type": "Property", "name": "address", "schema": "string"},
                {"@type": "Relationship", "name": "atLocation", "target": "dtmi:kiseki:travel:Trip;1"},
            ],
        },
        {
            "@id": "dtmi:kiseki:travel:Trip;1",
            "@type": "Interface",
            "contents": [
                {"@type": "Property", "name": "title", "schema": "string"},
            ],
        },
    ]


def test_short_name_strips_dtmi_wrapper():
    assert short_name(LOCATION_ID) == "Location"
    assert short_name("dtmi:kiseki:travel:TripSection;1") == "TripSection"


def test_expected_properties_keeps_only_properties():
    expected = expected_properties(_mini_doc())
    assert expected[LOCATION_ID] == {"name", "placeId", "address"}
    # relationships are not properties — never reported as missing
    assert "atLocation" not in expected[LOCATION_ID]


def test_diff_reports_missing_properties_sorted():
    expected = expected_properties(_mini_doc())
    live = {LOCATION_ID: {"name"}, "dtmi:kiseki:travel:Trip;1": {"title"}}
    missing = diff_models(expected, live)
    assert missing == {"Location": ["address", "placeId"]}


def test_diff_ignores_extra_live_properties():
    expected = expected_properties(_mini_doc())
    live = {
        LOCATION_ID: {"name", "placeId", "address", "legacyField"},
        "dtmi:kiseki:travel:Trip;1": {"title", "somethingNew"},
    }
    assert diff_models(expected, live) == {}


def test_diff_reports_entirely_missing_model():
    expected = expected_properties(_mini_doc())
    live = {"dtmi:kiseki:travel:Trip;1": {"title"}}
    missing = diff_models(expected, live)
    assert missing["Location"] == ["address", "name", "placeId"]


def test_committed_models_contain_location_place_metadata():
    """Pin the v0.23.12 lesson to the real file: Location must carry the
    place-metadata properties whose absence 500'd the first live PUT."""
    doc = json.loads(DTDL.read_text(encoding="utf-8"))
    expected = expected_properties(doc)
    for prop in ("placeId", "address", "website", "phone", "types", "summary"):
        assert prop in expected[LOCATION_ID], f"Location missing {prop} in committed models"
    # ... and a live graph without them must be flagged.
    live_without_place_meta = {
        mid: ({p for p in props if p not in ("placeId", "address", "website", "phone", "types", "summary")} if mid == LOCATION_ID else set(props))
        for mid, props in expected.items()
    }
    missing = diff_models(expected, live_without_place_meta)
    assert "Location" in missing
    assert "placeId" in missing["Location"]
