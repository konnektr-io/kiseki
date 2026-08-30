"""Tests for the DTDL model generator + the trip→graph mock converter.

These guard the issue-#4 graph foundation: DTDL v4 correctness, ADT-compat
strip rules ($metadata.$model kept on twins, $lastUpdatedBy stripped, entire
$metadata stripped from relationships), and $dtId immutability.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import models as M  # noqa: E402
from scripts.gen_dtdl import main as gen_main, mid  # noqa: E402
from scripts.trip_to_graph import trip_to_graph, MODEL  # noqa: E402

DTDL = ROOT / "dtdl" / "kiseki-models.json"
TRIP = ROOT / "data" / "trips" / "canada-2027" / "trip.json"
MOCK_ANON = ROOT / "data" / "mocks" / "canada-2027.graph.anon.json"

EXPECTED_RELS = {"hasDay", "atLocation", "hasCrew", "hasFeature", "hasSection", "hasBlock"}


# --------------------------------------------------------------------------
# DTDL generation
# --------------------------------------------------------------------------
def test_dtdl_validates():
    """Run the structural validator over the generated models (must pass)."""
    rc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate_dtdl.py"), str(DTDL)],
        capture_output=True, text=True,
    )
    assert rc.returncode == 0, rc.stderr


def test_models_cover_expected_entities_and_enums():
    doc = json.loads(DTDL.read_text())
    by_id = {d["@id"]: d for d in doc}
    for name in ("Trip", "Day", "Block", "Location", "Person", "Feature", "TripSection"):
        assert mid(name) in by_id, f"missing interface {name}"
        assert by_id[mid(name)]["@type"] == "Interface"
    # DTDL forbids top-level non-interface elements: each enum must be nested in the
    # `schemas` of the Interface that uses it (a schema is not referenceable across
    # interfaces). Verify BlockKind is inlined in Block's schemas and referenced by
    # Block.kind; and that no top-level Enum/Object definitions exist.
    for d in doc:
        assert d["@type"] == "Interface", f"{d['@id']}: top-level must be Interface"
    blk = by_id[mid("Block")]
    schema_ids = {s["@id"] for s in blk.get("schemas", [])}
    assert mid("BlockKind") in schema_ids, "BlockKind enum must be inlined in Block.schemas"
    kind = next(c for c in blk["contents"] if c["name"] == "kind")
    assert kind["schema"] == mid("BlockKind")


def test_trip_has_relationship_edges():
    doc = json.loads(DTDL.read_text())
    by_id = {d["@id"]: d for d in doc}
    trip = by_id[mid("Trip")]
    rels = [c for c in trip["contents"] if c["@type"] == "Relationship"]
    assert {c["name"] for c in rels} == {
        "hasDay", "atLocation", "hasCrew", "hasFeature", "hasSection"
    }


def test_block_kind_is_enum_and_items_is_inline_object():
    doc = json.loads(DTDL.read_text())
    by_id = {d["@id"]: d for d in doc}
    blk = by_id[mid("Block")]
    kind = next(c for c in blk["contents"] if c["name"] == "kind")
    assert kind["schema"] == mid("BlockKind")
    # Block.items is list[Any] -> Array of an inline Object schema (no @id, no
    # cross-interface reference — shared value-objects are inlined per interface).
    items = next(c for c in blk["contents"] if c["name"] == "items")
    assert items["schema"]["@type"] == "Array"
    element = items["schema"]["elementSchema"]
    assert element["@type"] == "Object" and "@id" not in element
    assert {f["name"] for f in element["fields"]} == {"label", "done", "url"}


def test_gen_dtdl_is_idempotent():
    before = DTDL.read_bytes()
    argv = sys.argv
    sys.argv = ["gen_dtdl.py"]  # avoid picking up pytest flags
    try:
        assert gen_main() == 0
    finally:
        sys.argv = argv
    assert DTDL.read_bytes() == before


# --------------------------------------------------------------------------
# trip -> graph mock
# --------------------------------------------------------------------------
@pytest.fixture
def trip():
    return M.Trip.model_validate_json(TRIP.read_text())


def test_graph_has_expected_counts(trip):
    g = trip_to_graph(trip)
    models = {t["$metadata"]["$model"] for t in g["twins"]}
    assert mid("Trip") in models and mid("Day") in models and mid("Block") in models
    assert mid("Location") in models and mid("Person") in models
    n_days = len(trip.days)
    n_blocks = sum(len(d.blocks) for d in trip.days)
    n_expected = (
        1 + len(trip.locations) + len(trip.crew) + len(trip.features)
        + len(trip.sections) + n_days + n_blocks
    )
    assert len(g["twins"]) == n_expected
    assert {r["$relationshipName"] for r in g["relationships"]} == EXPECTED_RELS


def test_twin_strips_lastupdatedby_keeps_model(trip):
    g = trip_to_graph(trip)
    for t in g["twins"]:
        assert "$dtId" in t and "$metadata" in t
        assert t["$metadata"]["$model"].startswith("dtmi:kiseki:travel:")
        assert "$lastUpdatedBy" not in t["$metadata"]


def test_relationships_strip_entire_metadata(trip):
    g = trip_to_graph(trip)
    assert g["relationships"], "expected relationships"
    for r in g["relationships"]:
        assert "$metadata" not in r
        for key in ("$relationshipId", "$sourceId", "$relationshipName", "$targetId"):
            assert key in r


def test_dtids_are_immutable_structural(trip):
    g = trip_to_graph(trip)
    assert g["$dtId"] == f"trip:{trip.slug}"
    block_ids = [t["$dtId"] for t in g["twins"] if t["$metadata"]["$model"] == mid("Block")]
    assert block_ids[0].startswith(f"trip:{trip.slug}:day:0:block:")
    assert not any(trip.token in t["$dtId"] for t in g["twins"])


def test_anonymize_removes_pii(trip):
    g = trip_to_graph(trip, anonymize=True)
    blob = json.dumps(g)
    assert trip.token not in blob
    for p in trip.crew:
        if p.name:
            assert p.name not in blob
    assert "Person 1" in blob


def test_anon_mock_fixture_matches_converter(trip):
    """The committed anonymized mock must stay in sync with the converter.

    Depends only on tracked files (``trip.json`` + the committed ``*.anon.json``
    mock) — never on the gitignored real mock, which carries the secret token.
    """
    anon = json.loads(MOCK_ANON.read_text())
    assert anon["$dtId"] == f"trip:{trip.slug}"
    # Regenerate in-memory and compare as dicts (formatting-independent) so the
    # committed fixture can never silently drift from the converter.
    expected = trip_to_graph(trip, anonymize=True)
    assert anon == expected
