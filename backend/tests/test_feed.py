"""Tests for the writer-ordered trip reads behind the activity feed (#199).

Two seams, because they catch different bugs:

* ``GraphReadClient.trips_for_user_ordered`` / ``trips_of_followed`` — the real
  query text and the row mapping. The graph itself does the ordering, so what
  can break here is the query SHAPE (a bound ``LIMIT``, a missing ``ORDER BY``,
  a reversed edge direction) and the metadata mapping (an absent write time
  must read back as ``None``, not an invented date). A recording SDK stub
  asserts exactly that — the double cannot, it never runs Cypher.
* ``FakeGraph`` (below) — the double the endpoint tests drive, which must
  mirror the ordering the real query asks the graph for.
"""

from __future__ import annotations

import pytest

from app.graph import client as graph_client_mod

SUB = "google-oauth2|100613034256980569871"
OTHER = "google-oauth2|222222222222222222222"
TRIP_A = "aaaaaaaa-1111-4111-8111-111111111111"
TRIP_B = "bbbbbbbb-2222-4222-8222-222222222222"


@pytest.fixture(autouse=True)
def _clear_graph_cache():
    """The ordered reads are TTL-cached in-process; a cached hit leaking across
    tests would hide a query-shape regression."""
    graph_client_mod._GRAPH_CACHE.clear()
    yield
    graph_client_mod._GRAPH_CACHE.clear()


class _RecordingClient:
    """Minimal SDK stand-in: records (query, params), yields canned rows."""

    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows = rows or []
        self.calls: list[tuple[str, dict]] = []

    def query_twins(self, query: str, query_parameters: dict | None = None):
        self.calls.append((query, query_parameters or {}))
        yield from self.rows


def _client_with(monkeypatch, rows=None):
    fake = _RecordingClient(rows)
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_URL", "http://graph.test")
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_TOKEN", "t")
    c = graph_client_mod.GraphReadClient()
    c._client = fake  # type: ignore[attr-defined]
    return c, fake


# ------------------------------------------------------- stream 1: my trips


def test_my_trips_query_shape(monkeypatch) -> None:
    c, fake = _client_with(monkeypatch)
    c.trips_for_user_ordered(SUB, limit=5)
    query, params = fake.calls[0]
    # Trip -> Person, not the reverse: the other direction returns 0 rows.
    assert "MATCH (trip:Twin)-[:hasCrew]->(me:Twin)" in query
    assert "ORDER BY at DESC" in query
    assert "LIMIT 5" in query
    assert "{limit}" not in query  # the template was filled, not shipped
    assert params == {"uid": SUB}  # the sub is a bound parameter, never inlined


def test_my_trips_limit_is_clamped_to_the_max(monkeypatch) -> None:
    c, fake = _client_with(monkeypatch)
    c.trips_for_user_ordered(SUB, limit=10_000)
    assert f"LIMIT {graph_client_mod.FEED_LIMIT_MAX}" in fake.calls[0][0]


@pytest.mark.parametrize("bad", ["nope", None, -4, 0])
def test_my_trips_bad_limit_is_defensive_not_fatal(monkeypatch, bad) -> None:
    """AGE refuses bound parameters in LIMIT, so the value is interpolated —
    a caller-supplied `limit` must never be able to carry Cypher."""
    c, fake = _client_with(monkeypatch)
    c.trips_for_user_ordered(SUB, limit=bad)  # type: ignore[arg-type]
    inlined = int(fake.calls[0][0].rsplit("LIMIT", 1)[1])
    assert 1 <= inlined <= graph_client_mod.FEED_LIMIT_MAX


def test_my_trips_row_mapping_carries_write_metadata(monkeypatch) -> None:
    rows = [{
        "dtId": TRIP_A, "title": "Canada 2027", "slug": "canada-2027",
        "visibility": "public", "stage": "booked",
        "at": "2026-09-14T09:00:00Z", "by": SUB,
        "meta": {"$model": "dtmi:kiseki:travel:Trip;1",
                 "title": {"$lastUpdateTime": "2026-09-14T09:00:00Z"}},
    }]
    c, _ = _client_with(monkeypatch, rows)
    [trip] = c.trips_for_user_ordered(SUB)
    assert trip["dtId"] == TRIP_A and trip["slug"] == "canada-2027"
    assert trip["at"] == "2026-09-14T09:00:00Z" and trip["by"] == SUB
    # The per-property times are what let the feed say WHAT changed.
    assert trip["meta"]["title"]["$lastUpdateTime"] == "2026-09-14T09:00:00Z"


def test_my_trips_unstamped_twin_has_no_invented_date(monkeypatch) -> None:
    """The committed mocks carry `$metadata.$model` only: no write time means
    the row says None rather than epoch / now."""
    rows = [{"dtId": TRIP_A, "title": "Canada 2027", "slug": "canada-2027",
             "visibility": "public", "stage": "idea", "at": None, "by": None,
             "meta": {}}]
    c, _ = _client_with(monkeypatch, rows)
    [trip] = c.trips_for_user_ordered(SUB)
    assert trip["at"] is None and trip["by"] is None


def test_my_trips_do_not_claim_a_discoverable_flag(monkeypatch) -> None:
    """`_Q_TRIPS_FOR_ME_ORDERED` does not return `discoverable`; the mapping must
    not invent `False` — "not asked" is not "not listed"."""
    c, _ = _client_with(monkeypatch, [{"dtId": TRIP_A, "title": "t", "slug": "s"}])
    [trip] = c.trips_for_user_ordered(SUB)
    assert "discoverable" not in trip


def test_ordered_reads_return_empty_when_disabled(monkeypatch) -> None:
    """`is_enabled()` is ``_client is not None``, snapshotted at construction: a
    graph that is not configured must short-circuit without touching the SDK."""
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_URL", "")
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_TOKEN", "")
    c = graph_client_mod.GraphReadClient()
    assert not c.is_enabled()
    assert c.trips_for_user_ordered(SUB) == []
    assert c.trips_of_followed(SUB) == []


def test_ordered_reads_skip_the_sdk_on_an_empty_sub(monkeypatch) -> None:
    """`_USER_RE` is deliberately permissive — it only rejects characters that
    would break a quoted Cypher string — so the EMPTY id is what short-circuits
    here. An odd-but-quotable id is the graph's business, not ours."""
    c, fake = _client_with(monkeypatch, [{"dtId": TRIP_A}])
    assert c.trips_for_user_ordered("") == []
    assert c.trips_of_followed("") == []
    assert fake.calls == []


def test_an_odd_but_quotable_sub_still_asks_the_graph(monkeypatch) -> None:
    """The id is BOUND (never inlined), so unusual ids are allowed through: the
    graph answers with no rows for a node that does not exist."""
    c, fake = _client_with(monkeypatch, [])
    c.trips_for_user_ordered("not-a-sub")
    assert len(fake.calls) == 1
    assert fake.calls[0][1] == {"uid": "not-a-sub"}


def test_ordered_reads_return_empty_on_sdk_error(monkeypatch) -> None:
    def boom(*_a, **_k):
        raise RuntimeError("graph down")

    c, _ = _client_with(monkeypatch)
    c._client.query_twins = boom  # type: ignore[attr-defined]
    assert c.trips_for_user_ordered(SUB) == []
    assert c.trips_of_followed(SUB) == []


# ------------------------------------------------- stream 2: followed people


def test_followed_trips_query_shape(monkeypatch) -> None:
    c, fake = _client_with(monkeypatch)
    c.trips_of_followed(SUB, limit=7)
    query, params = fake.calls[0]
    assert "MATCH (me:Twin)-[:follows]->(person:Twin)" in query
    assert "MATCH (trip:Twin)-[:hasCrew]->(person)" in query
    assert "trip.discoverable" in query  # the listing flag the feed filters on
    assert "ORDER BY at DESC" in query and "LIMIT 7" in query
    assert params == {"uid": SUB}


def test_followed_trips_row_mapping_reads_discoverable(monkeypatch) -> None:
    rows = [{"dtId": TRIP_B, "title": "Urban Legends", "slug": "urban-legends",
             "discoverable": True, "visibility": "public",
             "at": "2026-09-14T10:00:00Z", "by": OTHER}]
    c, _ = _client_with(monkeypatch, rows)
    [trip] = c.trips_of_followed(SUB)
    assert trip["discoverable"] is True
    assert trip["by"] == OTHER  # attribution is free: the graph records it
