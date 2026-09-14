"""Tests for the activity feed (#199) — reads, ranking, and the endpoint.

Three seams, because they catch different bugs:

* ``GraphReadClient.trips_for_user_ordered`` / ``trips_of_followed`` — the real
  query text and the row mapping. The graph does the ordering, so what can break
  here is the query SHAPE (an inlined ``LIMIT``, a missing ``ORDER BY``, a
  reversed edge direction) and the metadata mapping (an absent write time must
  read back as ``None``, not an invented date). A recording SDK stub asserts
  exactly that — a double never runs Cypher.
* ``feed.build_feed`` — the product rules: the listing gate (#196), the
  newest-first merge, the cap, the cursor, and the "what changed" labels.
* ``GET /api/feed`` — auth first, then the cursor, then the caller's own view
  (never a third party's).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import feed as feed_mod
from app.auth import Auth0JWTValidator
from app.graph import client as graph_client_mod
from app.main import app

from conftest import CLIENT_ID, TENANT, _claims, _sign

SUB = "google-oauth2|100613034256980569871"
OTHER = "google-oauth2|222222222222222222222"
TRIP_A = "aaaaaaaa-1111-4111-8111-111111111111"
TRIP_B = "bbbbbbbb-2222-4222-8222-222222222222"
TRIP_C = "cccccccc-3333-4333-8333-333333333333"


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


# ------------------------------------------------ feed.py: rank, cap, describe


def _row(dtid, slug, at=None, by=None, meta=None, title=None, **extra):
    """A trip row as the client hands it to feed.py (see ``_ordered_trip_row``)."""
    row = {"dtId": dtid, "title": title or slug.replace("-", " ").title(),
           "slug": slug, "at": at, "by": by}
    if meta is not None:
        row["meta"] = meta
    row.update(extra)
    return row


class _Streams:
    """The read client, canned: two streams + the limits it was asked for."""

    def __init__(self, mine=(), followed=()):
        self.mine = list(mine)
        self.followed = list(followed)
        self.limits: list[tuple[str, int]] = []

    def trips_for_user_ordered(self, sub, limit=30):
        self.limits.append(("mine", limit))
        return list(self.mine)

    def trips_of_followed(self, sub, limit=30):
        self.limits.append(("followed", limit))
        return list(self.followed)


def _stamp(at: str) -> dict:
    return {"$lastUpdateTime": at}


def test_changed_properties_names_the_newest_three() -> None:
    meta = {
        "title": _stamp("2026-09-14T10:00:00Z"),
        "cover": _stamp("2026-09-14T11:00:00Z"),
        "stage": _stamp("2026-09-14T12:00:00Z"),
        "theme": _stamp("2026-09-14T09:00:00Z"),
    }
    assert feed_mod.changed_properties(meta) == ["stage", "cover photo", "title"]


def test_changed_properties_ignores_derived_and_metadata_keys() -> None:
    """`stats`/`updated` are recomputed by the app and the `$…` keys are the
    graph's own bookkeeping: none of them is something a person changed."""
    meta = {
        "stats": _stamp("2026-09-14T12:00:00Z"),
        "updated": _stamp("2026-09-14T12:00:00Z"),
        "$model": "dtmi:kiseki:travel:Trip;1",
        "$etag": _stamp("2026-09-14T12:00:00Z"),
        "$lastUpdateTime": "2026-09-14T12:00:00Z",
        "$lastUpdatedBy": SUB,
    }
    assert feed_mod.changed_properties(meta) == []


def test_changed_properties_falls_back_to_the_property_name() -> None:
    """An unmapped field is named, not dropped: a new property must not become
    invisible just because nobody updated NARRATABLE."""
    meta = {"mysteryField": _stamp("2026-09-14T10:00:00Z")}
    assert feed_mod.changed_properties(meta) == ["mysteryField"]


def test_changed_properties_is_stable_on_a_tie() -> None:
    same = "2026-09-14T10:00:00Z"
    meta = {"title": _stamp(same), "cover": _stamp(same)}
    assert feed_mod.changed_properties(meta) == ["cover photo", "title"]


def test_changed_properties_tolerates_a_twin_without_stamps() -> None:
    assert feed_mod.changed_properties({}) == []
    assert feed_mod.changed_properties({"title": "Canada 2027"}) == []


def test_feed_merges_both_streams_newest_first_with_their_source() -> None:
    client = _Streams(
        mine=[_row(TRIP_A, "canada-2027", "2026-09-14T09:00:00Z", by=SUB,
                   meta={"title": _stamp("2026-09-14T09:00:00Z")})],
        followed=[_row(TRIP_B, "burning-man-2027", "2026-09-14T11:00:00Z", by=OTHER,
                       discoverable=True,
                       meta={"cover": _stamp("2026-09-14T11:00:00Z")})],
    )
    out = feed_mod.build_feed(SUB, client=client)
    assert [i["tripSlug"] for i in out["items"]] == ["burning-man-2027", "canada-2027"]
    assert [i["source"] for i in out["items"]] == ["followed-user", "my-trip"]
    assert out["items"][0]["href"] == "/t/burning-man-2027"
    assert out["items"][0]["changes"] == ["cover photo"]
    assert out["generatedAt"].endswith("Z")
    assert out["nextBefore"] is None  # everything fit on one page


def test_feed_hides_a_followed_trip_that_is_not_discoverable() -> None:
    """The listing rule (#196) is applied HERE, not in the query: `follows`
    grants no access, so a private trip of a followed person must never appear."""
    client = _Streams(followed=[
        _row(TRIP_A, "canada-2027", "2026-09-14T10:00:00Z", discoverable=False),
        _row(TRIP_B, "urban-legends", "2026-09-14T11:00:00Z", discoverable=True),
    ])
    out = feed_mod.build_feed(SUB, client=client)
    assert [i["tripSlug"] for i in out["items"]] == ["urban-legends"]


def test_feed_keeps_unstamped_trips_last_and_only_on_the_first_page() -> None:
    client = _Streams(mine=[
        _row(TRIP_A, "no-write-time"),  # the committed mocks have no write time
        _row(TRIP_B, "stamped", "2026-09-14T10:00:00Z"),
    ])
    out = feed_mod.build_feed(SUB, client=client)
    assert [i["tripSlug"] for i in out["items"]] == ["stamped", "no-write-time"]
    assert out["nextBefore"] is None  # a page that ends unstamped cannot be resumed
    paged = feed_mod.build_feed(SUB, client=client, before="2026-09-14T10:00:00Z")
    assert paged["items"] == []


def test_feed_caps_to_the_limit_and_only_then_offers_a_cursor() -> None:
    client = _Streams(mine=[
        _row(TRIP_A, "a", "2026-09-14T09:00:00Z"),
        _row(TRIP_B, "b", "2026-09-14T10:00:00Z"),
    ])
    out = feed_mod.build_feed(SUB, client=client, limit=1)
    assert [i["tripSlug"] for i in out["items"]] == ["b"]
    assert out["nextBefore"] == "2026-09-14T10:00:00Z"  # there is more behind it


def test_feed_pages_with_the_cursor_without_repeating_an_entry() -> None:
    client = _Streams(mine=[
        _row(TRIP_A, "a", "2026-09-14T09:00:00Z"),
        _row(TRIP_B, "b", "2026-09-14T10:00:00Z"),
    ])
    first = feed_mod.build_feed(SUB, client=client, limit=1)
    second = feed_mod.build_feed(SUB, client=client, limit=1, before=first["nextBefore"])
    assert [i["tripSlug"] for i in second["items"]] == ["a"]
    assert second["nextBefore"] is None


def test_feed_clamps_an_oversized_limit_before_asking_the_graph() -> None:
    client = _Streams()
    feed_mod.build_feed(SUB, client=client, limit=10_000)
    assert dict(client.limits) == {"mine": graph_client_mod.FEED_LIMIT_MAX,
                                   "followed": graph_client_mod.FEED_LIMIT_MAX}


def test_feed_without_a_configured_graph_is_an_empty_page_not_an_error(monkeypatch) -> None:
    monkeypatch.setattr(feed_mod, "get_graph_client", lambda: None)
    out = feed_mod.build_feed(SUB)
    assert out["items"] == [] and out["nextBefore"] is None


@pytest.mark.parametrize("value,expected", [
    ("2026-09-14T11:31:29.5286173Z", True),
    ("2026-09-14T11:31:29Z", True),
    ("2026-09-14", True),  # a date-only cursor still orders correctly
    ("yesterday", False),
    ("", False),
    (None, False),
])
def test_is_iso_timestamp(value, expected) -> None:
    assert feed_mod.is_iso_timestamp(value) is expected


# --------------------------------------------------------------- GET /api/feed


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch):
    """A TestClient with the REAL validator wired to the local JWKS.

    Same fixture as test_acl.py: the route is exercised through the real token
    path, never a stubbed identity.
    """
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    return TestClient(app)


def _auth(rsa_keypair, **claims_overrides) -> dict:
    return {"Authorization": f"Bearer {_sign(rsa_keypair, _claims(**claims_overrides))}"}


def test_feed_requires_a_token(client) -> None:
    assert client.get("/api/feed").status_code == 401


def test_feed_rejects_a_cursor_that_is_not_a_timestamp(client, rsa_keypair) -> None:
    r = client.get("/api/feed?before=yesterday", headers=_auth(rsa_keypair))
    assert r.status_code == 422


def test_feed_serves_the_callers_own_view_and_is_never_cached(
    client, rsa_keypair, monkeypatch
) -> None:
    """End to end: both streams newest-first, the #196 listing gate applied to
    the followed stream, and ``no-store`` so no proxy keeps a user's feed."""

    class _Graph:
        def trips_for_user_ordered(self, sub, limit=30):
            return [{"dtId": TRIP_A, "title": "Canada 2027", "slug": "canada-2027",
                     "at": "2026-09-14T09:00:00Z", "by": sub,
                     "meta": {"title": {"$lastUpdateTime": "2026-09-14T09:00:00Z"}}}]

        def trips_of_followed(self, sub, limit=30):
            return [
                {"dtId": TRIP_B, "title": "Burning Man 2027",
                 "slug": "burning-man-2027", "discoverable": True,
                 "at": "2026-09-14T11:00:00Z", "by": OTHER},
                # A followed person's private trip: listed or not, it must not
                # appear — `follows` grants no access (#196).
                {"dtId": TRIP_C, "title": "Private Thing", "slug": "private-thing",
                 "discoverable": False, "at": "2026-09-14T12:00:00Z", "by": OTHER},
            ]

    monkeypatch.setattr(feed_mod, "get_graph_client", lambda: _Graph())
    r = client.get("/api/feed?limit=30", headers=_auth(rsa_keypair))
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    slugs = [i["tripSlug"] for i in body["items"]]
    assert slugs == ["burning-man-2027", "canada-2027"]
    assert [i["source"] for i in body["items"]] == ["followed-user", "my-trip"]
    assert body["items"][1]["changes"] == ["title"]
    assert "private-thing" not in slugs
    assert body["items"][0]["href"] == "/t/burning-man-2027"


def test_feed_clamps_the_limit_at_the_route(client, rsa_keypair, monkeypatch) -> None:
    seen: list[int] = []

    class _Graph:
        def trips_for_user_ordered(self, sub, limit=30):
            seen.append(limit)
            return []

        def trips_of_followed(self, sub, limit=30):
            return []

    monkeypatch.setattr(feed_mod, "get_graph_client", lambda: _Graph())
    r = client.get("/api/feed?limit=9999", headers=_auth(rsa_keypair))
    assert r.status_code == 200
    assert seen == [graph_client_mod.FEED_LIMIT_MAX]
