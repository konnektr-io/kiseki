"""Crew-only redaction of a trip document (#249).

Niko's report (2026-09-15): the landing page linked to real trips, and an
anonymous read of one returned `bookingCode: "9GMOL3"`, `cost: 5880.0` and the
crew's checklist. "Public" means the route, the days, the places and the photos —
not the crew's paperwork.

These are MODEL-level tests deliberately. The committed ANON fixtures are a RENDER
fixture (they carry no costs, no booking codes, no checklist), so a fixture-driven
test here would pass while exercising nothing. The route-level wiring is covered
separately by
`test_follow_197.py::test_every_registered_crew_only_field_is_hidden_from_a_follower`,
which walks `CREW_ONLY_FIELDS` itself.
"""

from __future__ import annotations

from app.main import CREW_ONLY_BLOCK_KINDS, CREW_ONLY_KEYS, _public_trip, _redact_non_crew
from app.models import Block, Day, Practical, TodoItem, Trip

# The live Canada trip's booking block, verbatim: the amount and the balance live
# in the description, which is why a key-strip alone was not enough.
BOOKING_PROSE = "Deposit paid ($2,964.15 CAD, 35%). Balance due Dec 10, 2026."


def _trip_with_paperwork() -> Trip:
    """A trip whose day carries the crew's paperwork next to real content."""
    return Trip(
        id="redaction-249",
        slug="redaction-249",
        title="A trip with paperwork",
        days=[
            Day(
                id="d1",
                date="2027-02-15",
                blocks=[
                    Block(
                        id="b1",
                        kind="transport",
                        title="Fly to Calgary",
                        mode="flight",
                        cost=5880.0,
                        currency="CAD",
                        bookingCode="9GMOL3",
                    ),
                    Block(
                        id="b2",
                        kind="booking",
                        title="Selkirk Tangiers — check-in",
                        description=BOOKING_PROSE,
                        bookingCode="STHS Feb 20–24",
                        status="booked",
                    ),
                    Block(id="b3", kind="activity", title="Heli day 1"),
                ],
            )
        ],
        practical=Practical(
            todos=[TodoItem(label="Pay the balance for the lodge", when="Feb 15")]
        ),
    )


def test_a_non_crew_reader_gets_no_paperwork() -> None:
    anon = _public_trip(_trip_with_paperwork())

    kinds = [b["kind"] for b in anon["days"][0]["blocks"]]
    assert "booking" not in kinds, "the crew's reservation block reached a stranger"
    assert "todos" not in anon["practical"], "the crew's checklist reached a stranger"

    # The booking's PROSE is the reason the whole block goes: the amount and the
    # balance are in the description, not in a field a key-strip could drop.
    assert BOOKING_PROSE not in str(anon)

    transport = next(b for b in anon["days"][0]["blocks"] if b["kind"] == "transport")
    for leaked in ("cost", "currency", "bookingCode"):
        assert leaked not in transport, f"a stranger was handed a block's {leaked}"

    # …and this is a redaction, not a lockout: the trip itself still renders.
    assert transport["title"] == "Fly to Calgary"
    assert transport["mode"] == "flight"
    assert [b["title"] for b in anon["days"][0]["blocks"] if b["kind"] == "activity"] == [
        "Heli day 1"
    ]
    assert anon["title"] == "A trip with paperwork"


def test_the_crew_still_gets_all_of_it() -> None:
    """The other half of the contract — a redaction that drops everything is a bug."""
    crew = _public_trip(_trip_with_paperwork(), my_role="owner")
    transport, booking, _activity = crew["days"][0]["blocks"]
    assert transport["bookingCode"] == "9GMOL3"
    assert transport["cost"] == 5880.0
    assert transport["currency"] == "CAD"
    assert booking["description"] == BOOKING_PROSE
    assert crew["practical"]["todos"][0]["label"] == "Pay the balance for the lodge"


def test_the_walk_covers_every_container_and_reports_its_work() -> None:
    """Blocks move containers; neither registry may depend on where they sit.

    `days[].blocks[]` is only today's home — `sections[].blocks[]` holds unscheduled
    ideas, and the next container is the one nobody thought of. Hence a
    name-and-kind matched recursive walk, asserted here on a shape that has no
    model yet.
    """
    data = {
        "days": [{"blocks": [{"cost": 1}, {"bookingCode": "x", "title": "keep me"}]}],
        "sections": [{"blocks": [{"currency": "CAD"}, {"kind": "booking", "cost": 2}]}],
        "futureContainer": {"nested": [{"deep": {"bookingCode": "y"}}]},
    }
    keys, blocks = _redact_non_crew(data)
    assert (keys, blocks) == (4, 1)
    assert data["days"][0]["blocks"][1]["title"] == "keep me"
    assert "bookingCode" not in data["futureContainer"]["nested"][0]["deep"]

    # A walk that matches nothing must be distinguishable from one that worked.
    assert _redact_non_crew({"title": "nothing sensitive"}) == (0, 0)


def test_the_registries_are_the_contract() -> None:
    """Cheap guard on the two spellings that would silently disable the rules."""
    assert CREW_ONLY_KEYS == {"cost", "currency", "bookingCode"}
    assert CREW_ONLY_BLOCK_KINDS == {"booking"}
