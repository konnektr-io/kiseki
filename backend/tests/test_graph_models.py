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
    # DTDL v4: every model element must be @type Interface. Complex schemas
    # (Enum/Object) are embedded inline in the property `schema` (Tutorial06) —
    # NOT top-level elements and NOT nested `schemas` blocks (the live pg-age
    # resolver does not resolve nested-schema *references* at upload time).
    # Verify Block.kind is an inline Enum and that no top-level non-Interface
    # elements exist.
    for d in doc:
        assert d["@type"] == "Interface", f"{d['@id']}: top-level must be Interface"
    blk = by_id[mid("Block")]
    kind = next(c for c in blk["contents"] if c["name"] == "kind")
    assert kind["schema"]["@type"] == "Enum", "Block.kind must be an inline Enum"


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
    # Embedded inline Enum (Tutorial06), not a referenced schema.
    assert kind["schema"]["@type"] == "Enum"
    assert kind["schema"]["valueSchema"] == "string"
    # Block.items is list[Any] -> Array of an inline Object schema (no @id, no
    # cross-interface reference — shared value-objects are inlined per interface).
    items = next(c for c in blk["contents"] if c["name"] == "items")
    assert items["schema"]["@type"] == "Array"
    element = items["schema"]["elementSchema"]
    assert element["@type"] == "Object" and "@id" not in element
    assert {f["name"] for f in element["fields"]} == {"label", "done", "url"}


def test_user_extends_person_and_has_no_role():
    """User IS a Person (DTDL `extends`); role is never a User/Person property
    — it lives on the hasCrew edge instead."""
    doc = json.loads(DTDL.read_text())
    by_id = {d["@id"]: d for d in doc}
    user = by_id[mid("User")]
    assert user.get("extends") == mid("Person"), "User must extend Person"
    user_props = {c["name"] for c in user["contents"] if c["@type"] == "Property"}
    # own fields only — name/contact come from Person via `extends`
    # (role/note ride the hasCrew edge, never a node)
    assert user_props == {"email", "displayName", "authProvider"}
    assert "role" not in user_props
    person_props = {c["name"] for c in by_id[mid("Person")]["contents"] if c["@type"] == "Property"}
    assert "role" not in person_props, "role must not be a Person property (carried on hasCrew edge)"
    assert "note" not in person_props, "note must not be a Person property (carried on hasCrew edge)"


def test_hascrew_edge_declares_role_and_note():
    """Trip-relative crew metadata (role + note, e.g. gear, + the crew's own
    displayName for the trip) is declared on the hasCrew edge — the
    Person/User node is shared across trips after claim, so per-trip names
    and notes must not live on the node."""
    doc = json.loads(DTDL.read_text())
    by_id = {d["@id"]: d for d in doc}
    trip_iface = by_id[mid("Trip")]
    edges = [c for c in trip_iface["contents"]
             if c["@type"] == "Relationship" and c["name"] == "hasCrew"]
    assert len(edges) == 1, "Trip must expose exactly one hasCrew edge"
    assert {p["name"] for p in edges[0].get("properties", [])} == {"role", "note", "displayName"}


def test_tripsection_has_section_relationship_edges():
    """A TripSection is a real graph node with hasDay (from its [first,last]
    range), atLocation (from locationRefs), and hasBlock (ideation content)."""
    doc = json.loads(DTDL.read_text())
    sec = {d["@id"]: d for d in doc}[mid("TripSection")]
    rels = {c["name"]: c["target"] for c in sec["contents"] if c["@type"] == "Relationship"}
    assert rels == {
        "hasBlock": mid("Block"),
        "hasDay": mid("Day"),
        "atLocation": mid("Location"),
    }, "TripSection must expose hasBlock + hasDay + atLocation edges"


def test_field_descriptions_present_in_dtdl():
    """#8: every model field carries a `description` annotation so the graph
    stays self-documenting (Niko's request)."""
    doc = json.loads(DTDL.read_text())
    for d in doc:
        if d["@type"] != "Interface":
            continue
        # each Property/Relationship content should have a description
        for c in d["contents"]:
            if c["@type"] in ("Property", "Relationship"):
                assert c.get("description"), f"{d['@id']}.{c.get('name')} missing description"
        # interface itself should have a description
        assert d.get("description"), f"{d['@id']} missing interface description"


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
    if TRIP.is_file():
        return M.Trip.model_validate_json(TRIP.read_text())
    # CI: trip.json is git-ignored; derive from anon mock
    from app.graph.convert import graph_to_trip
    return graph_to_trip(json.loads(MOCK_ANON.read_text()))


def test_graph_has_expected_counts(trip):
    g = trip_to_graph(trip)
    models = {t["$metadata"]["$model"] for t in g["twins"]}
    assert mid("Trip") in models and mid("Day") in models and mid("Block") in models
    assert mid("Location") in models and mid("Person") in models
    n_days = len(trip.days)
    n_blocks = sum(len(d.blocks) for d in trip.days)
    # sections may also own unscheduled blocks (ideation) — count those too
    n_section_blocks = sum(len(s.blocks) for s in trip.sections)
    n_expected = (
        1 + len(trip.locations) + len(trip.crew) + len(trip.features)
        + len(trip.sections) + n_days + n_blocks + n_section_blocks
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


def test_dtids_are_opaque_guid_and_unique(trip):
    """#8 id scheme: $dtId is the node's opaque content `id` (a GUID), used
    verbatim — no type/slug/date prefix. All meaning lives in $metadata.$model +
    content. Ids are unique and stable across re-seed (so re-seed replaces, not
    duplicates). No token leaks into any id."""
    import uuid as _uuid
    g = trip_to_graph(trip)
    assert g["$dtId"] == trip.id  # trip.id is the verbatim $dtId
    assert _uuid.UUID(g["$dtId"]), "root $dtId must be a valid GUID"
    dtids = [t["$dtId"] for t in g["twins"]]
    assert len(dtids) == len(set(dtids)), "dtIds must be globally unique"
    # every twin id is a valid opaque GUID (no semantic prefix)
    for did in dtids:
        _uuid.UUID(did)
    # the day's $dtId is its own opaque id, decoupled from date/position
    day_ids = [t["$dtId"] for t in g["twins"] if t["$metadata"]["$model"] == mid("Day")]
    assert day_ids[0] == trip.days[0].id
    # Trip's own $dtId appears exactly once (its twin); no other twin leaks it
    assert sum(1 for x in g["twins"] if x["$dtId"] == trip.id) == 1
    assert not any(trip.id in x["$dtId"] and x["$dtId"] != trip.id for x in g["twins"])


def test_crew_note_rides_edge_roundtrip(trip):
    """Converter moves Person.note onto the hasCrew edge (never the twin);
    graph_to_trip reads it back — so per-trip gear notes survive the graph."""
    if not trip.crew:
        pytest.skip("no crew in fixture trip")
    trip.crew[0].note = "Skis — Elan Playmaker 111"
    g = trip_to_graph(trip)
    crew_edges = [r for r in g["relationships"] if r.get("$relationshipName") == "hasCrew"]
    assert len(crew_edges) == len(trip.crew)
    edge = next(r for r in crew_edges if r["$targetId"] == trip.crew[0].id)
    assert edge.get("note") == "Skis — Elan Playmaker 111"
    assert edge.get("role") == trip.crew[0].role
    twin = next(t for t in g["twins"] if t["$dtId"] == trip.crew[0].id)
    assert "note" not in twin and "role" not in twin
    from app.graph.convert import graph_to_trip
    back = graph_to_trip(g)
    person = next(p for p in back.crew if p.id == trip.crew[0].id)
    assert person.note == "Skis — Elan Playmaker 111"
    assert person.role == trip.crew[0].role


def test_anonymize_removes_pii(trip):
    g = trip_to_graph(trip, anonymize=True)
    blob = json.dumps(g)
    # claimToken is a long random secret — must not appear verbatim in anonymized mock
    if trip.claimToken:
        # anonymized mock redacts claimToken to REDACTED or removes it — either way original secret not verbatim
        assert trip.claimToken not in blob or "REDACTED" in blob
    for p in trip.crew:
        if p.name and not p.name.startswith("Person "):
            assert p.name not in blob
    assert "Person 1" in blob


def test_anon_mock_fixture_matches_converter(trip):
    """The committed anonymized mock must stay in sync with the converter.

    Depends only on tracked files (``trip.json`` + the committed ``*.anon.json``
    mock) — never on the gitignored real mock, which carries the secret token.
    When trip.json is absent (CI, git-ignored), the anon fixture is checked
    for idempotence instead.
    """
    anon = json.loads(MOCK_ANON.read_text())
    if TRIP.is_file():
        assert anon["$dtId"] == trip.id
        expected = trip_to_graph(trip, anonymize=True)
        assert anon == expected
    else:
        from app.graph.convert import graph_to_trip
        trip_from_anon = graph_to_trip(anon)
        assert trip_from_anon.id == anon["$dtId"]
        assert trip_to_graph(trip_from_anon, anonymize=True) == anon
