"""The server-side route chain (#457) — parity, rules, and the cost budget.

The chain used to exist only as TypeScript in the SPA (``route-surface.ts`` +
``day-surface.ts``), so the booklet, the PDF and every agent had to
re-implement or reverse-engineer it. ``app/journey.py`` is a 1:1 port; these
tests pin it two ways:

* **golden parity** — the committed fixtures' expected output was CAPTURED from
  the TypeScript implementation at the port's base commit (see
  ``fixtures/journey/README.md``). A mismatch is a porting bug, never a fixture
  update: the rules are meant to be bug-for-bug identical until a follow-up
  issue changes them deliberately.
* **the rules themselves** — one fixture per named regression shape, asserted
  by hand so a future refactor that keeps the goldens green still has to keep
  the behaviour (#91 scaffold, #435 day trip, #433 re-visited base + reversed
  block, #361 gateway, #438/#435 IATA shorthand, #454 shared-day ordering).

Fixtures are synthetic on purpose: trip content does not belong in the code
repo, and a synthetic trip can state exactly one rule at a time.
"""

from __future__ import annotations

import ast
import copy
import json
import statistics
import time
from pathlib import Path

import pytest

from app import journey

FIXTURES = Path(__file__).parent / "fixtures" / "journey"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def _expected(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.expected.json").read_text())


def _wire(trip: dict) -> dict:
    """Run ``attach`` exactly as the API does and return the wire shape."""
    doc = copy.deepcopy(trip)
    journey.attach(doc)
    return {"journey": doc["journey"], "days": [d.get("surface") for d in doc["days"]]}


CASES = sorted(p.stem for p in FIXTURES.glob("*.json") if not p.name.endswith(".expected.json"))


def test_the_fixture_set_covers_every_named_regression_shape() -> None:
    """A silently missing fixture would make the parity suite weaker, not wrong."""
    assert CASES == [
        "alias-nested-name",
        "day-trip-from-base",
        "gateway-flight",
        "iata-title-shorthand",
        "revisited-base",
        "scaffold-registry",
        "shared-day-hub",
    ]


@pytest.mark.parametrize("name", CASES)
def test_golden_parity_with_the_typescript_implementation(name: str) -> None:
    """Byte-for-byte the same journey and day surfaces the SPA derived."""
    assert _wire(_fixture(name)) == _expected(name)


# --------------------------------------------------------------- the rules


def test_scaffold_chains_the_registry_in_marker_order() -> None:
    """#91: with no re-base evidence the registry IS the author's intent."""
    j = _wire(_fixture("scaffold-registry"))["journey"]
    assert j["chain"] == ["Alpha Camp", "Beta Pass", "Gamma Lake", "Delta Hut"]
    # Every pair is unauthored → a gap, never a road.
    assert [leg["gap"] for leg in j["legs"]] == [True, True, True]
    assert {leg["stage"] for leg in j["legs"]} == {"provisional"}


def test_a_day_trip_is_not_a_re_base() -> None:
    """#435: the trailhead is driven to and back from — an excursion, no leg."""
    j = _wire(_fixture("day-trip-from-base"))["journey"]
    assert j["chain"] == ["Base Village", "Far City"]
    assert "Summit Trailhead" in j["excursions"]
    assert {"Summit Trailhead"} & {leg["to"] for leg in j["legs"]} == set()


def test_a_revisited_base_chains_once_per_stay() -> None:
    """#433: arrival → mountain → night bus back is THREE visits, not two."""
    j = _wire(_fixture("revisited-base"))["journey"]
    assert j["chain"] == ["Home City", "Mountain Town", "Home City"]
    assert j["loop"] is True
    assert len(j["legs"]) == 2
    assert [leg["stage"] for leg in j["legs"]] == ["booked", "booked"]


def test_the_legs_own_direction_wins_over_an_earlier_reversed_block() -> None:
    """#433: b4 (Home → Mountain) sits earlier in block order and its endpoints
    fit the return leg reversed; the authored return card must still win.

    This is the exact shape that drew the Peru night bus on a leg the traveller
    flies: a direction-insensitive match hands the leg a card it contradicts.
    """
    j = _wire(_fixture("revisited-base"))["journey"]
    home_to_mountain, mountain_to_home = j["legs"]
    assert home_to_mountain["blockId"] == "b4"
    assert mountain_to_home["blockId"] == "b7"
    assert mountain_to_home["gap"] is False
    assert mountain_to_home["stage"] == "booked"


def test_an_airport_flight_reaches_the_city_leg_by_gateway() -> None:
    """#361: the chain nodes are cities, the block names airports ~17 km away."""
    j = _wire(_fixture("gateway-flight"))["journey"]
    assert j["chain"] == ["Coast City", "Inland City"]
    (leg,) = j["legs"]
    assert leg["blockId"] == "b3"
    assert leg["mode"] == "flight"
    assert {"Coast Airport", "Inland Airport"} <= set(j["excursions"])


def test_an_iata_code_in_a_day_title_is_shorthand() -> None:
    """#435/#438: `MCY → CCY` in a title must not open two same-day stays."""
    j = _wire(_fixture("iata-title-shorthand"))["journey"]
    assert j["chain"] == ["Mountain City", "Coast City"]
    assert {"Mountain Airport", "Coast Airport"} <= set(j["excursions"])
    # The hop is unauthored, so it is an honest gap — not a phantom road.
    (leg,) = j["legs"]
    assert leg["gap"] is True and leg["mode"] is None


def test_a_shared_day_is_ordered_by_its_movements_not_the_registry() -> None:
    """#454 + #438: the hub day runs springs → airport → coast, whatever order
    the author registered the places in (the fixture lists them the wrong way)."""
    trip = _fixture("shared-day-hub")
    registry = [l["name"] for l in trip["locations"]]
    j = _wire(trip)["journey"]
    day_three = [v["place"] for v in j["visits"] if 3 in v["days"]]
    # Valley Town is still on day 3 (the drive out of it names it), then the
    # day's own movement order — springs, airport, coast.
    assert day_three == ["Valley Town", "Termal Springs", "Hub Airport", "Coast City"]
    # The registry lists the airport BEFORE the springs; movement order is the
    # other way round, so this pair can only be right if the walk ran.
    assert day_three != [p for p in registry if p in day_three]
    # The pass-through airport is a chain node (#438), with both hops authored.
    assert [leg["mode"] for leg in j["legs"]] == ["flight", "drive", "drive", "flight"]


def test_an_alias_nested_in_a_longer_name_is_not_a_second_hit() -> None:
    """#457 port: "Sapporo Kokusai" is its own place; "Sapporo" must not claim it."""
    j = _wire(_fixture("alias-nested-name"))["journey"]
    assert j["chain"] == ["Sapporo Kokusai", "Sapporo Teine"]
    # New Chitose stays a single-day endpoint → excursion, which only holds if
    # the nested "Sapporo" alias hit was dropped.
    assert j["excursions"] == ["New Chitose"]


def test_the_rail_handle_answers_from_the_payload() -> None:
    """``placeRailHandle`` moved server-side: a chapter ref wins, else the day."""
    j = _wire(_fixture("day-trip-from-base"))["journey"]
    assert j["rail"]["Base Village"] == {"kind": "pill", "refs": ["Base Village"]}
    # A place with attributed days but no chapter ref scrolls to its first day.
    assert j["rail"]["Summit Trailhead"] == {"kind": "day", "dayIdx": 2}


# ------------------------------------------------------- cost and isolation


def _big_trip(places: int = 63, blocks: int = 89, days: int = 17) -> dict:
    """A trip the size of the largest real one (Chile 2027), content-free."""
    locations = [
        {"name": f"Place {i:02d}", "lat": 40.0 + i * 0.05, "lng": -70.0 + i * 0.05, "alias": [f"P{i}"]}
        for i in range(places)
    ]
    day_list = []
    per_day = max(1, blocks // days)
    block_id = 0
    for d in range(days):
        day_blocks = []
        for _ in range(per_day):
            block_id += 1
            day_blocks.append(
                {
                    "id": f"b{block_id}",
                    "kind": "activity",
                    "title": f"Activity {block_id} at Place {d % places:02d}",
                    "location": f"Place {d % places:02d}",
                    "order": block_id,
                }
            )
        if d + 1 < places:
            day_blocks.append(
                {
                    "id": f"t{d}",
                    "kind": "transport",
                    "title": f"Drive Place {d:02d} → Place {d + 1:02d}",
                    "from": f"Place {d:02d}",
                    "to": f"Place {d + 1:02d}",
                    "mode": "drive",
                    "order": 0,
                    "status": "planned",
                }
            )
        day_list.append({"title": f"Day {d}", "blocks": day_blocks})
    sections = [
        {"title": f"Chapter {i}", "days": [i * 4, min(days - 1, i * 4 + 3)], "locationRefs": [f"Place {i * 3:02d}"]}
        for i in range(days // 4)
    ]
    return {
        "id": "fixture-big",
        "slug": "fixture-big",
        "title": "Big synthetic trip",
        "stage": "shortlist",
        "visibility": "public",
        "startDate": "2027-01-01",
        "endDate": "2027-01-20",
        "locations": locations,
        "days": day_list,
        "sections": sections,
    }


def test_the_derivation_is_pure_python_with_no_network_path() -> None:
    """Acceptance: "derives the chain with no network access".

    Checked structurally rather than hoped for: the module may only import
    ``__future__``, ``math``, ``re`` and ``typing``, so a future edit cannot
    quietly reach for the store, HERE, or an HTTP client.
    """
    tree = ast.parse(Path(journey.__file__).read_text())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert imported <= {"__future__", "math", "re", "typing"}, imported


def test_the_largest_trip_derives_inside_the_budget() -> None:
    """Acceptance: < 20 ms for a trip the size of Chile 2027 (63 places, 89 blocks).

    Measured as a median of 7 runs, once warm: a single cold read includes the
    interpreter's first regex compile and is a property of pytest, not the port.
    """
    trip = _big_trip()
    journey.attach(copy.deepcopy(trip))  # warm the caches/patterns
    timings = []
    for _ in range(7):
        doc = copy.deepcopy(trip)
        started = time.perf_counter()
        journey.attach(doc)
        timings.append((time.perf_counter() - started) * 1000)
    assert statistics.median(timings) < 20, timings


def test_the_payload_stays_a_small_fraction_of_the_document() -> None:
    """The compact projection is why this rides on every trip read.

    The first draft of the design returned the raw ``Journey`` objects (every
    ``TripLocation`` four times, every leg's whole ``Block``), which measured
    +16…109% of the document; this one measured 3–14% on the real trips. The
    bound is deliberately loose — it catches a regression back to fat objects,
    not a byte or two.
    """
    trip = _big_trip()
    doc = copy.deepcopy(trip)
    journey.attach(doc)
    document = len(json.dumps(doc, separators=(",", ":")).encode())
    without = len(json.dumps(trip, separators=(",", ":")).encode())
    added = document - without
    # Per-place bound, not a ratio: this fixture's blocks are deliberately tiny,
    # so a percentage of the document would measure the fixture, not the payload.
    # The real trips measured 3–14% (+8.0 kB journey for 63 places on a 70 kB doc).
    assert added / len(trip["locations"]) < 200, (added, len(trip["locations"]))


def test_a_derived_journey_never_carries_a_redacted_field() -> None:
    """The payload must be safe for a stranger (it ships on public reads).

    Costs, booking codes and the crew's checklist are stripped for non-crew
    readers (#249). The journey is derived from the FULL document — so it must
    not carry any of that: only place names, day indices, modes, stages and
    block ids.
    """
    doc = copy.deepcopy(_fixture("revisited-base"))
    doc["days"][0]["blocks"][1]["cost"] = 5880.0
    doc["days"][0]["blocks"][1]["currency"] = "CAD"
    doc["days"][0]["blocks"][1]["bookingCode"] = "9GMOL3"
    payload = json.dumps(journey.journey_payload(doc))
    for secret in ("5880", "CAD", "9GMOL3"):
        assert secret not in payload
