"""Rating maturity: Google rating snapshots are short-lived (issue #15).

Storage rule: only ``place_id`` may be persisted indefinitely. ``rating``
is accepted on the write path but the READ path (``graph_to_trip``) strips
it once the trip's ``updated`` stamp is older than 30 days. Durable fields
(placeId, address, …) are never stripped.

``now`` is injected by monkeypatching ``app.graph.convert.utcnow`` (the
``app.time`` seam) — no waiting 30 days.
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from app import models as M  # noqa: E402
from app.graph import convert as convert_mod  # noqa: E402
from app.graph.convert import RATING_TTL_DAYS, graph_to_trip  # noqa: E402
from scripts.trip_to_graph import trip_to_graph  # noqa: E402

NOW = _dt.datetime(2026, 9, 7, 12, 0, 0)


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(convert_mod, "utcnow", lambda: NOW)
    yield


def _trip_with_rating(updated: str | None) -> dict:
    trip = M.Trip(
        id="11111111-1111-4111-8111-111111111111",
        slug="rating-probe",
        title="Rating probe",
        updated=updated,
        locations=[
            M.Location(
                id="22222222-2222-4222-8222-222222222222",
                name="Niseko",
                lat=42.8,
                lng=140.68,
                placeId="ChIJN1t_tDeuEmsRUsoyG83frY4",
                website="https://example.test/niseko",
                rating=4.7,
                types=["ski_resort"],
            )
        ],
    )
    return trip_to_graph(trip)


def test_fresh_trip_keeps_rating() -> None:
    out = graph_to_trip(_trip_with_rating("2026-09-01"))
    assert out.locations[0].rating == 4.7


def test_stale_trip_drops_rating_but_keeps_durable_fields() -> None:
    out = graph_to_trip(_trip_with_rating("2026-06-01"))
    loc = out.locations[0]
    assert loc.rating is None
    # Durable metadata survives — only the short-lived snapshot is stripped.
    assert loc.placeId == "ChIJN1t_tDeuEmsRUsoyG83frY4"
    assert loc.website == "https://example.test/niseko"
    assert loc.types == ["ski_resort"]
    assert loc.lat == 42.8 and loc.lng == 140.68


def test_boundary_exactly_ttl_days_keeps_rating() -> None:
    boundary = (NOW.date() - _dt.timedelta(days=RATING_TTL_DAYS)).isoformat()
    assert graph_to_trip(_trip_with_rating(boundary)).locations[0].rating == 4.7
    day_after = (NOW.date() - _dt.timedelta(days=RATING_TTL_DAYS + 1)).isoformat()
    assert graph_to_trip(_trip_with_rating(day_after)).locations[0].rating is None


def test_missing_or_bad_updated_fails_open() -> None:
    assert graph_to_trip(_trip_with_rating(None)).locations[0].rating == 4.7
    assert graph_to_trip(_trip_with_rating("not-a-date")).locations[0].rating == 4.7
