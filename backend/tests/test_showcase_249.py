"""The signed-out landing's showcase read (issue #249).

Only one of these is a feature test. The rest pin the rule that makes the
feature safe to expose without a session:

  * ``GET /api/showcase`` answers an ANONYMOUS caller with public, discoverable
    trips as cards, cached for a minute.
  * the rule holds on every path that can serve it — the Cypher filter (live
    graph) and the fixture fallback (dev/CI) — so a private trip, or a public
    trip that opted out of being listed, is never on the front door.
  * a graph outage collapses the band instead of 500-ing the landing page.

The committed fixtures make this testable without a graph: ``japan-campervan-2028``
is anonymised as ``private``, and none of them carry ``discoverable`` — which
must therefore never read as "listable".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import models as M
from app.graph.client import (
    _Q_SHOWCASE_TRIPS,
    SHOWCASE_LIMIT_DEFAULT,
    SHOWCASE_LIMIT_MAX,
    GraphReadClient,
    GraphWriteClient,
    clamp_showcase_limit,
)
from app.graph.convert import graph_to_trip
from app.main import app
from app.store import list_showcase_trips

MOCK_DIR = Path(__file__).resolve().parent.parent / "data" / "mocks"
PRIVATE_SLUG = "japan-campervan-2028"  # committed as visibility=private
PUBLIC_SLUG = "canada-2027"
PUBLIC_SLUG_2 = "chile-peru-2027"


def _trip(slug: str, *, discoverable: bool, visibility: str = "public") -> M.Trip:
    """A fixture trip with ``discoverable``/``visibility`` set as the test needs.

    ``visibility`` is a plain ``Literal["public", "private"]`` string on the
    model, so these assignments are the whole mechanism — no enum juggling.
    """
    raw = json.loads((MOCK_DIR / f"{slug}.graph.anon.json").read_text(encoding="utf-8"))
    trip = graph_to_trip(raw)
    trip.discoverable = discoverable
    trip.visibility = visibility  # type: ignore[assignment]
    return trip


def _listed(slug: str) -> M.Trip:
    """Public AND discoverable — the only shape the showcase may return."""
    return _trip(slug, discoverable=True, visibility="public")


def _private(slug: str) -> M.Trip:
    """Discoverable but private: the case that must never be listed."""
    return _trip(slug, discoverable=True, visibility="private")


# --------------------------------------------------------------------------
# The rule
# --------------------------------------------------------------------------


def test_query_text_requires_public_and_discoverable() -> None:
    """The Cypher filter is the lock on the graph path — keep both conditions.

    A future "the landing is empty" fix that drops ``discoverable`` from this
    WHERE clause would publish trips whose owner opted out of being listed.
    """
    assert "visibility = 'public'" in _Q_SHOWCASE_TRIPS
    assert "discoverable = true" in _Q_SHOWCASE_TRIPS
    assert "LIMIT {limit}" in _Q_SHOWCASE_TRIPS, "the read must stay bounded"


@pytest.mark.parametrize(
    "row",
    [
        pytest.param(None, id="not-a-row"),
        pytest.param([], id="list-row"),
        pytest.param({"visibility": "public", "discoverable": True}, id="no-dtid"),
        pytest.param(
            {"dtId": "x", "visibility": "private", "discoverable": True}, id="private"
        ),
        pytest.param(
            {"dtId": "x", "visibility": "public", "discoverable": False}, id="opted-out"
        ),
        pytest.param({"dtId": "x", "visibility": "public"}, id="flag-absent"),
    ],
)
def test_card_mapper_refuses_anything_not_listable(row) -> None:
    assert GraphReadClient._trip_card_from_row(row) is None


def test_card_mapper_returns_an_allowlist_not_the_row() -> None:
    """Extra columns on the query must not ride along to an anonymous caller."""
    card = GraphReadClient._trip_card_from_row(
        {
            "dtId": "trip-1",
            "visibility": "public",
            "discoverable": True,
            "title": "A trip",
            "subtitle": "Somewhere",
            "stage": "booked",
            "startDate": "2027-02-15",
            "endDate": "2027-03-02",
            "cover": "/media/trip-1/cover.jpg",
            # none of these are part of the read, but a query edit could add
            # them — the mapper is what stops them leaving the process:
            "claimToken": "secret",
            "crew": [{"name": "someone"}],
            "practical": {"notes": "private"},
        }
    )
    assert card is not None
    assert set(card) == {
        "dtId",
        "title",
        "subtitle",
        "stage",
        "startDate",
        "endDate",
        "cover",
    }


def test_the_write_client_inherits_the_read() -> None:
    """``store`` builds a GraphWriteClient, so the read must live where it sees it."""
    assert hasattr(GraphWriteClient, "list_showcase_trips")


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (None, SHOWCASE_LIMIT_DEFAULT),
        ("abc", SHOWCASE_LIMIT_DEFAULT),
        (0, 1),
        (-5, 1),
        (3, 3),
        (10**6, SHOWCASE_LIMIT_MAX),
    ],
)
def test_limit_is_clamped(given, expected) -> None:
    assert clamp_showcase_limit(given) == expected


# --------------------------------------------------------------------------
# The fixture fallback (dev / CI — the same rule, no graph)
# --------------------------------------------------------------------------


def test_fallback_lists_the_public_discoverable_fixtures(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.store._anon_trips",
        lambda: [_listed(PUBLIC_SLUG), _listed(PUBLIC_SLUG_2)],
    )
    trips = list_showcase_trips()
    assert [t["dtId"] for t in trips] == [
        _listed(PUBLIC_SLUG).id,
        _listed(PUBLIC_SLUG_2).id,
    ]
    assert trips[0]["title"]


def test_fallback_never_lists_a_private_trip(monkeypatch) -> None:
    """The whole point: a private trip stays private even if it is discoverable."""
    monkeypatch.setattr(
        "app.store._anon_trips",
        lambda: [
            _listed(PUBLIC_SLUG),
            _private(PRIVATE_SLUG),
            _trip(PUBLIC_SLUG_2, discoverable=False),
        ],
    )
    listed = {t["dtId"] for t in list_showcase_trips()}
    assert listed == {_listed(PUBLIC_SLUG).id}


def test_fallback_bounds_the_list(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.store._anon_trips",
        lambda: [_listed(PUBLIC_SLUG), _listed(PUBLIC_SLUG_2), _listed(PUBLIC_SLUG)],
    )
    assert len(list_showcase_trips(limit=2)) == 2
    assert len(list_showcase_trips(limit=999)) == 3


def test_fallback_is_empty_without_the_flag(monkeypatch) -> None:
    """Committed fixtures carry no ``discoverable``: absence is not consent.

    This is also the honest dev/CI state — the band collapses rather than
    showing trips nobody opted into listing.
    """
    monkeypatch.setattr(
        "app.store._anon_trips",
        lambda: [
            _trip(PUBLIC_SLUG, discoverable=False),
            _trip(PUBLIC_SLUG_2, discoverable=False),
        ],
    )
    assert list_showcase_trips() == []


def test_graph_failure_collapses_the_band(monkeypatch, capsys) -> None:
    """A marketing page must not 500 because the graph is down."""

    class Boom:
        def query_twins(self, *args, **kwargs):
            raise RuntimeError("graph down")

    client = GraphReadClient.__new__(GraphReadClient)
    client._client = Boom()
    monkeypatch.setattr(client, "is_enabled", lambda: True)
    assert client.list_showcase_trips() == []
    assert "showcase read failed" in capsys.readouterr().out


def test_empty_read_says_so_in_the_log(monkeypatch, capsys) -> None:
    """A valid query matching nothing is the failure that hides — log it."""

    class Empty:
        def query_twins(self, *args, **kwargs):
            return []

    client = GraphReadClient.__new__(GraphReadClient)
    client._client = Empty()
    monkeypatch.setattr(client, "is_enabled", lambda: True)
    assert client.list_showcase_trips() == []
    assert "listed no trips" in capsys.readouterr().out


# --------------------------------------------------------------------------
# The endpoint
# --------------------------------------------------------------------------


def test_endpoint_is_anonymous_and_cached() -> None:
    resp = TestClient(app).get("/api/showcase")
    assert resp.status_code == 200
    assert resp.json() == {"trips": []}  # no graph in tests → band collapses
    cache = resp.headers["cache-control"]
    assert "public" in cache and "max-age=60" in cache


def test_endpoint_returns_cards_and_nothing_else(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.main.list_showcase_trips",
        lambda limit: [
            {
                "dtId": "trip-1",
                "title": "A trip",
                "subtitle": "Somewhere",
                "stage": "booked",
                "startDate": "2027-02-15",
                "endDate": "2027-03-02",
                "cover": "/media/trip-1/original/cover.jpg",
            }
        ],
    )
    body = TestClient(app).get("/api/showcase?limit=3").json()
    assert len(body["trips"]) == 1
    card = body["trips"][0]
    assert card["cover"] == "/media/trip-1/original/cover.jpg"
    blob = json.dumps(body)
    for forbidden in ("claimToken", "followToken", "crew", "practical", "$metadata"):
        assert forbidden not in blob
