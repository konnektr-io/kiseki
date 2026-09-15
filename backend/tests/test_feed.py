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
from app import auth as auth_module
from app import feed as feed_mod
from app.auth import Auth0JWTValidator
from app.graph import client as graph_client_mod
from app.main import app
from conftest import CLIENT_ID, TENANT, _claims, _sign
from fastapi.testclient import TestClient

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
        "dtId": TRIP_A, "title": "Canada 2027",
        "visibility": "public", "stage": "booked",
        # Raw query row, as `_Q_TRIPS_FOR_ME_ORDERED` returns it — hence `actor`.
        "at": "2026-09-14T09:00:00Z", "actor": SUB,
        "meta": {"$model": "dtmi:kiseki:travel:Trip;1",
                 "title": {"$lastUpdateTime": "2026-09-14T09:00:00Z"}},
    }]
    c, _ = _client_with(monkeypatch, rows)
    [trip] = c.trips_for_user_ordered(SUB)
    assert trip["dtId"] == TRIP_A and trip["title"] == "Canada 2027"
    assert trip["at"] == "2026-09-14T09:00:00Z" and trip["by"] == SUB
    # The per-property times are what let the feed say WHAT changed.
    assert trip["meta"]["title"]["$lastUpdateTime"] == "2026-09-14T09:00:00Z"


def test_my_trips_unstamped_twin_has_no_invented_date(monkeypatch) -> None:
    """The committed mocks carry `$metadata.$model` only: no write time means
    the row says None rather than epoch / now."""
    rows = [{"dtId": TRIP_A, "title": "Canada 2027",
             "visibility": "public", "stage": "idea", "at": None, "actor": None,
             "meta": {}}]
    c, _ = _client_with(monkeypatch, rows)
    [trip] = c.trips_for_user_ordered(SUB)
    assert trip["at"] is None and trip["by"] is None


def test_my_trips_do_not_claim_a_discoverable_flag(monkeypatch) -> None:
    """`_Q_TRIPS_FOR_ME_ORDERED` does not return `discoverable`; the mapping must
    not invent `False` — "not asked" is not "not listed"."""
    c, _ = _client_with(monkeypatch, [{"dtId": TRIP_A, "title": "t"}])
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
    rows = [{"dtId": TRIP_B, "title": "Urban Legends",
             "discoverable": True, "visibility": "public",
             "at": "2026-09-14T10:00:00Z", "actor": OTHER}]
    c, _ = _client_with(monkeypatch, rows)
    [trip] = c.trips_of_followed(SUB)
    assert trip["discoverable"] is True
    assert trip["by"] == OTHER  # attribution is free: the graph records it


# ------------------------------------------------ feed.py: rank, cap, describe


def _row(dtid, name, at=None, by=None, meta=None, title=None, **extra):
    """A trip row as the client hands it to feed.py (see ``_ordered_trip_row``)."""
    row = {"dtId": dtid, "title": title or name.replace("-", " ").title(),
           "at": at, "by": by}
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
    assert [i["tripId"] for i in out["items"]] == [TRIP_B, TRIP_A]
    assert [i["source"] for i in out["items"]] == ["followed-user", "my-trip"]
    assert out["items"][0]["href"] == f"/t/{TRIP_B}"
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
    assert [i["tripId"] for i in out["items"]] == [TRIP_B]


def test_feed_keeps_unstamped_trips_last_and_only_on_the_first_page() -> None:
    client = _Streams(mine=[
        _row(TRIP_A, "no-write-time"),  # the committed mocks have no write time
        _row(TRIP_B, "stamped", "2026-09-14T10:00:00Z"),
    ])
    out = feed_mod.build_feed(SUB, client=client)
    assert [i["tripId"] for i in out["items"]] == [TRIP_B, TRIP_A]
    assert out["nextBefore"] is None  # a page that ends unstamped cannot be resumed
    paged = feed_mod.build_feed(SUB, client=client, before="2026-09-14T10:00:00Z")
    assert paged["items"] == []


def test_feed_caps_to_the_limit_and_only_then_offers_a_cursor() -> None:
    client = _Streams(mine=[
        _row(TRIP_A, "a", "2026-09-14T09:00:00Z"),
        _row(TRIP_B, "b", "2026-09-14T10:00:00Z"),
    ])
    out = feed_mod.build_feed(SUB, client=client, limit=1)
    assert [i["tripId"] for i in out["items"]] == [TRIP_B]
    assert out["nextBefore"] == "2026-09-14T10:00:00Z"  # there is more behind it


def test_feed_pages_with_the_cursor_without_repeating_an_entry() -> None:
    client = _Streams(mine=[
        _row(TRIP_A, "a", "2026-09-14T09:00:00Z"),
        _row(TRIP_B, "b", "2026-09-14T10:00:00Z"),
    ])
    first = feed_mod.build_feed(SUB, client=client, limit=1)
    second = feed_mod.build_feed(SUB, client=client, limit=1, before=first["nextBefore"])
    assert [i["tripId"] for i in second["items"]] == [TRIP_A]
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
            return [{"dtId": TRIP_A, "title": "Canada 2027",
                     "at": "2026-09-14T09:00:00Z", "by": sub,
                     "meta": {"title": {"$lastUpdateTime": "2026-09-14T09:00:00Z"}}}]

        def trips_of_followed(self, sub, limit=30):
            return [
                {"dtId": TRIP_B, "title": "Burning Man 2027",
                 "discoverable": True, "at": "2026-09-14T11:00:00Z", "by": OTHER},
                # A followed person's private trip: listed or not, it must not
                # appear — `follows` grants no access (#196).
                {"dtId": TRIP_C, "title": "Private Thing",
                 "discoverable": False, "at": "2026-09-14T12:00:00Z", "by": OTHER},
            ]

    monkeypatch.setattr(feed_mod, "get_graph_client", lambda: _Graph())
    r = client.get("/api/feed?limit=30", headers=_auth(rsa_keypair))
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    ids = [i["tripId"] for i in body["items"]]
    assert ids == [TRIP_B, TRIP_A]
    assert [i["source"] for i in body["items"]] == ["followed-user", "my-trip"]
    assert body["items"][1]["changes"] == ["title"]
    assert TRIP_C not in ids
    # Routes carry the trip id, never the repo-folder slug.
    assert body["items"][0]["href"] == f"/t/{TRIP_B}"


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


# ------------------------------------------------------- item-level entries
# Task 7 of the plan: a followed trip contributes its ITEMS, not just the trip
# row. The write times come from the RAW bundle ``fetch_graph`` returns (it is
# the same cached copy the trip page reads); ``convert.py`` strips ``$metadata``,
# which is exactly why the feed must not go through the converted model.


def _raw_twin(dtid, model, *, at=None, by=None, props_meta=None, **props):
    """One ADT-shaped twin: ``$metadata.$model`` + per-property write stamps.

    The graph stamps EVERY property with its own ``$lastUpdateTime`` — that is
    what lets the feed say what changed, and which write a row is about.
    """
    meta: dict = {"$model": f"dtmi:konnektr:kiseki:{model};4"}
    if at:
        meta["$lastUpdateTime"] = at
    if by:
        meta["$lastUpdatedBy"] = by
    for key, value in (props_meta or {}).items():
        meta[key] = value
    return {"$dtId": dtid, "$metadata": meta, **props}


DAY_ID = "burning-man-2027-2027-02-15"
GALLERY_ID = "block-gallery-0000-0000-000000000001"
NOTE_ID = "block-note-0000-0000-000000000002"


def _day_bundle(*, gallery_at="2026-09-14T11:45:00Z", note_at="2026-09-14T10:00:00Z"):
    """A followed trip's raw bundle: one day, a 4-photo gallery, one note block."""
    return {
        "$dtId": TRIP_B,
        "twins": [
            _raw_twin(TRIP_B, "Trip", at="2026-09-14T11:00:00Z", by=OTHER,
                      title="Burning Man 2027"),
            _raw_twin(DAY_ID, "Day", at="2026-09-14T11:30:00Z", by=OTHER,
                      date="2027-02-15", title="Arrival"),
            _raw_twin(
                GALLERY_ID, "Block", at="2026-09-14T09:00:00Z", by=OTHER,
                kind="gallery", title="Camp", items=["a.jpg", "b.jpg", "c.jpg", "d.jpg"],
                props_meta={"items": {"$lastUpdateTime": gallery_at, "$lastUpdatedBy": OTHER}},
            ),
            _raw_twin(
                NOTE_ID, "Block", at=note_at, by=OTHER, kind="note", title="Packing",
                description="Bring the good boots.",
                props_meta={"description": {"$lastUpdateTime": note_at}},
            ),
        ],
        "relationships": [
            {"$sourceId": TRIP_B, "$targetId": DAY_ID,
             "$relationshipName": "hasDay", "index": 0},
            {"$sourceId": DAY_ID, "$targetId": GALLERY_ID,
             "$relationshipName": "hasBlock", "index": 0},
            {"$sourceId": DAY_ID, "$targetId": NOTE_ID,
             "$relationshipName": "hasBlock", "index": 1},
        ],
    }


def _items(**kwargs):
    return feed_mod.items_of_trip(
        _day_bundle(**kwargs), trip_id=TRIP_B, trip_title="Burning Man 2027",
        source="followed-user",
    )


def test_items_of_trip_shows_the_newest_days_photos_with_inline_thumbs() -> None:
    """The acceptance scenario: the newest day's photos, visible in the feed.

    A follower must see the photos WITHOUT opening the trip, so the row has to
    carry thumbnails of its own — a label alone is not the feature.
    """
    newest = _items()[0]
    assert newest["kind"] == "item"
    assert newest["dayIndex"] == 0
    assert newest["dayTitle"] == "Arrival"
    assert newest["label"] == "4 photos added"
    assert newest["at"] == "2026-09-14T11:45:00Z"
    assert newest["by"] == OTHER
    assert newest["tripId"] == TRIP_B
    assert newest["source"] == "followed-user"
    assert newest["href"] == f"/t/{TRIP_B}/day/0"
    assert newest["thumbs"] == [
        f"/media/{TRIP_B}/a.jpg", f"/media/{TRIP_B}/b.jpg", f"/media/{TRIP_B}/c.jpg",
    ]


def test_items_of_trip_names_a_content_write_and_claims_no_photos() -> None:
    """A description edit is not a photo row: no thumbs, and it says what moved."""
    older = _items()[1]
    assert older["label"] == "description updated"
    assert older["thumbs"] == []
    assert older["at"] == "2026-09-14T10:00:00Z"


def test_items_of_trip_counts_a_card_images_write_too() -> None:
    """`images` (a card strip) is a photo write just like a gallery's `items`."""
    bundle = _day_bundle()
    for twin in bundle["twins"]:
        if twin["$dtId"] == GALLERY_ID:
            twin.pop("items")
            twin["images"] = ["solo.jpg"]
            twin["$metadata"]["images"] = {
                "$lastUpdateTime": "2026-09-14T11:45:00Z", "$lastUpdatedBy": OTHER,
            }
            twin["$metadata"].pop("items")
    rows = feed_mod.items_of_trip(
        bundle, trip_id=TRIP_B, trip_title="Burning Man 2027",
        source="followed-user",
    )
    assert rows[0]["label"] == "1 photo added"  # singular, not "1 photos"
    assert rows[0]["thumbs"] == [f"/media/{TRIP_B}/solo.jpg"]


def test_items_of_trip_caps_rows_and_gives_the_slots_to_the_photos() -> None:
    """A busy trip may not push every trip row off the page — and (#253) its
    photoless writes may not eat the slots the pictures need."""
    bundle = _day_bundle()
    ids = []
    for i in range(6):
        bid = f"block-extra-0000-0000-00000000000{i}"
        ids.append(bid)
        bundle["twins"].append(
            _raw_twin(bid, "Block", at=f"2026-09-14T1{i}:00:00Z", by=OTHER,
                      kind="note", title=f"Extra {i}")
        )
        bundle["relationships"].append(
            {"$sourceId": DAY_ID, "$targetId": bid, "$relationshipName": "hasBlock", "index": i + 2}
        )
    rows = feed_mod.items_of_trip(
        bundle, trip_id=TRIP_B, trip_title="Burning Man 2027",
        source="followed-user",
    )
    assert len(rows) == feed_mod.ITEMS_PER_TRIP
    # Newest first: the extra blocks are stamped 10:00..15:00, the gallery 11:45.
    assert [row["at"] for row in rows] == sorted(
        (row["at"] for row in rows), reverse=True
    )
    assert rows[0]["at"] == "2026-09-14T15:00:00Z"
    # The photo row kept its slot: six newer photoless writes did not evict it,
    # so only the newest five of them fit beside it.
    assert [row["blockTitle"] for row in rows if row["thumbs"]] == ["Camp"]
    assert [row["blockTitle"] for row in rows if not row["thumbs"]] == [
        "Extra 5", "Extra 4", "Extra 3", "Extra 2", "Extra 1",
    ]


def test_items_of_trip_keeps_the_photos_when_the_prose_moves_after_them() -> None:
    """#253: place the photos, then edit the text — the row still shows them.

    The most ordinary sequence of writes on a trip, and exactly what blanked the
    feed: the block's own stamp is newer than the photo stamp, and gating the
    thumbnails on the photo stamp degraded the row to a bare "updated".
    """
    bundle = _day_bundle()
    for twin in bundle["twins"]:
        if twin["$dtId"] == GALLERY_ID:
            twin["$metadata"]["$lastUpdateTime"] = "2026-09-14T12:30:00Z"
            twin["$metadata"]["description"] = {
                "$lastUpdateTime": "2026-09-14T12:30:00Z", "$lastUpdatedBy": OTHER,
            }
            twin["description"] = "Sunset over the playa."
    rows = feed_mod.items_of_trip(
        bundle, trip_id=TRIP_B, trip_title="Burning Man 2027", source="followed-user",
    )
    gallery = next(row for row in rows if row["blockTitle"] == "Camp")
    assert gallery["thumbs"] == [
        f"/media/{TRIP_B}/a.jpg", f"/media/{TRIP_B}/b.jpg", f"/media/{TRIP_B}/c.jpg",
    ]
    # ...and the label still says what moved after the photos.
    assert gallery["label"] == "4 photos · description updated"
    assert gallery["at"] == "2026-09-14T12:30:00Z"
    assert gallery["by"] == OTHER


def test_items_of_trip_counts_photo_objects_not_just_bare_filenames() -> None:
    """#247 stores gallery photos as `{"url": …}`; the feed read must see them.

    `items` is the array the gallery and todo kinds SHARE, and that object is
    the only shape the graph's DTDL `items` schema accepts — a read that keeps
    `str` values only, as the feed did, reports a full photo gallery as
    photoless (#253).
    """
    bundle = _day_bundle()
    for twin in bundle["twins"]:
        if twin["$dtId"] == GALLERY_ID:
            twin["items"] = [
                {"url": "a.jpg"},
                {"url": "/media/an-old-slug/c.jpg"},         # legacy path: canonicalized
                {"label": "Bring water", "done": False},     # a todo item, not a picture
                {"url": "https://example.com/hotlink.jpg"},  # external: not trip media
            ]
    rows = feed_mod.items_of_trip(
        bundle, trip_id=TRIP_B, trip_title="Burning Man 2027", source="followed-user",
    )
    gallery = next(row for row in rows if row["blockTitle"] == "Camp")
    assert gallery["label"] == "2 photos added"
    assert gallery["thumbs"] == [f"/media/{TRIP_B}/a.jpg", f"/media/{TRIP_B}/c.jpg"]


class _ItemsGraph:
    """A read client whose bundles are known, and which records what it walked.

    Only the two ordered reads + ``fetch_graph`` are defined: if feed.py ever
    reaches for anything else, this double fails loudly instead of silently
    passing.
    """

    def __init__(self, followed: list[dict], bundles: dict[str, dict], *, raising=False,
                 own: list[dict] | None = None):
        self._followed = followed
        self._own = list(own or [])
        self._bundles = bundles
        self._raising = raising
        self.walked: list[str] = []

    def trips_for_user_ordered(self, sub, limit=30):
        return list(self._own)

    def trips_of_followed(self, sub, limit=30):
        return list(self._followed)

    def fetch_graph(self, trip_dtid: str):
        self.walked.append(trip_dtid)
        if self._raising:
            raise RuntimeError("graph down")
        return self._bundles.get(trip_dtid)


def _followed_row(dtid, *, at, discoverable=True, title="A Trip"):
    return {"dtId": dtid, "title": title, "visibility": "public",
            "discoverable": discoverable, "at": at, "by": OTHER}


def _own_row(dtid, *, at, title="My Trip"):
    """A stream-1 row as ``trips_for_user_ordered`` maps it (meta included)."""
    return {"dtId": dtid, "title": title, "visibility": "public", "stage": "planning",
            "at": at, "by": SUB, "meta": {"title": {"$lastUpdateTime": at}}}


def test_build_feed_merges_a_followed_trips_items_into_the_ranked_list() -> None:
    graph = _ItemsGraph([_followed_row(TRIP_B, at="2026-09-14T11:00:00Z",
                                       title="Burning Man 2027")],
                        {TRIP_B: _day_bundle()})
    feed = feed_mod.build_feed(SUB, client=graph)
    kinds = [(i["kind"], i.get("label") or i.get("tripTitle")) for i in feed["items"]]
    # Newest write first: 11:45 photos, 11:00 the trip row, 10:00 the note.
    assert kinds == [("item", "4 photos added"), ("trip", "Burning Man 2027"),
                     ("item", "description updated")]
    assert graph.walked == [TRIP_B]


def test_build_feed_never_walks_a_private_followed_trip() -> None:
    """The listing rule (#196) gates the ITEMS too — and savings: no bundle read."""
    graph = _ItemsGraph([_followed_row(TRIP_B, at="2026-09-14T11:00:00Z", discoverable=False)],
                        {TRIP_B: _day_bundle()})
    feed = feed_mod.build_feed(SUB, client=graph)
    assert graph.walked == []
    assert [i["kind"] for i in feed["items"]] == []


def test_build_feed_walks_only_the_top_k_followed_trips() -> None:
    """The bundle read is the expensive one (~540 ms walk) — it is capped."""
    rows, bundles = [], {}
    for n in range(feed_mod.ITEMS_TRIPS + 2):
        dtid = f"{n}0000000-0000-4000-8000-000000000000"
        rows.append(_followed_row(dtid, at=f"2026-09-14T{10 + n}:00:00Z"))
        bundles[dtid] = _day_bundle()
    graph = _ItemsGraph(rows, bundles)
    feed_mod.build_feed(SUB, client=graph)
    newest = [r["dtId"] for r in rows][::-1][: feed_mod.ITEMS_TRIPS]
    assert graph.walked == newest


def test_build_feed_degrades_to_trip_rows_when_a_bundle_is_missing() -> None:
    graph = _ItemsGraph([_followed_row(TRIP_B, at="2026-09-14T11:00:00Z")], {})
    feed = feed_mod.build_feed(SUB, client=graph)
    assert [i["kind"] for i in feed["items"]] == ["trip"]


def test_build_feed_survives_a_bundle_read_that_raises() -> None:
    """A graph hiccup on the optional part must not empty the feed."""
    graph = _ItemsGraph([_followed_row(TRIP_B, at="2026-09-14T11:00:00Z")], {},
                        raising=True)
    feed = feed_mod.build_feed(SUB, client=graph)
    assert [i["kind"] for i in feed["items"]] == ["trip"]


def test_items_of_trip_names_the_block_that_moved() -> None:
    """A row names the BLOCK, not just the day: a day holds several of them, so
    two writes on one day would otherwise read identically."""
    labels = {(row["blockTitle"], row["label"]) for row in _items()}
    assert ("Camp", "4 photos added") in labels
    assert ("Packing", "description updated") in labels


def test_items_of_trip_falls_back_to_updated_and_still_names_the_block() -> None:
    """A write that stamps only the twin leaves no property to name — the row
    must still identify WHICH block moved ("updated" alone says nothing)."""
    bundle = _day_bundle()
    for twin in bundle["twins"]:
        if twin["$dtId"] == NOTE_ID:
            twin["$metadata"].pop("description")
    rows = feed_mod.items_of_trip(
        bundle, trip_id=TRIP_B, trip_title="Burning Man 2027", source="followed-user",
    )
    note = next(row for row in rows if row["blockTitle"] == "Packing")
    assert note["label"] == "updated"


def test_build_feed_walks_my_own_trips_for_items_too() -> None:
    """A bare "Updated" on my OWN trip row says nothing either: my newest trips
    contribute their blocks the same way a followed trip does."""
    graph = _ItemsGraph([], {TRIP_B: _day_bundle()},
                        own=[_own_row(TRIP_B, at="2026-09-14T11:00:00Z")])
    feed = feed_mod.build_feed(SUB, client=graph)
    assert graph.walked == [TRIP_B]
    items = [i for i in feed["items"] if i["kind"] == "item"]
    assert items and {i["source"] for i in items} == {"my-trip"}


def test_build_feed_lists_a_trip_i_am_crew_on_once() -> None:
    """A followed person's trip I am ALSO crew on is one row, and it is mine
    (stream 2 carries less metadata) — and its bundle is walked once."""
    graph = _ItemsGraph(
        [_followed_row(TRIP_B, at="2026-09-14T11:00:00Z", title="Burning Man 2027")],
        {TRIP_B: _day_bundle()},
        own=[_own_row(TRIP_B, at="2026-09-14T11:00:00Z", title="Burning Man 2027")],
    )
    feed = feed_mod.build_feed(SUB, client=graph)
    trips = [i for i in feed["items"] if i["kind"] == "trip"]
    assert [(t["tripId"], t["source"]) for t in trips] == [(TRIP_B, "my-trip")]
    assert graph.walked == [TRIP_B]


def test_build_feed_caps_the_bundle_walk_across_both_streams() -> None:
    """The cap bounds the whole feed's cost, not each stream separately."""
    own_rows = [
        _own_row(f"a{n}000000-0000-4000-8000-000000000000", at=f"2026-09-14T{8 + n:02d}:00:00Z")
        for n in range(feed_mod.ITEMS_TRIPS)
    ]
    followed_rows = [
        _followed_row(f"b{n}000000-0000-4000-8000-000000000000",
                      at=f"2026-09-14T{11 + n:02d}:00:00Z")
        for n in range(3)
    ]
    bundles = {r["dtId"]: _day_bundle() for r in own_rows + followed_rows}
    graph = _ItemsGraph(followed_rows, bundles, own=own_rows)
    feed_mod.build_feed(SUB, client=graph)
    assert len(graph.walked) == feed_mod.ITEMS_TRIPS
    # Newest first, so the followed rows (11:00+) edge out my own (08:00+).
    assert set(graph.walked) == {r["dtId"] for r in followed_rows}


def test_ordered_queries_do_not_alias_a_reserved_word() -> None:
    """`AS by` breaks the graph's own SQL planner — and no FakeGraph test can see it.

    The alias survives translation into SQL, where BY is reserved:

        42601: syntax error at or near "by"

    Both feed reads then raise, `trips_for_user_ordered` / `trips_of_followed`
    swallow the error and return [], and the feed renders EMPTY instead of
    failing — which is exactly how v0.35.0 shipped. Found only by smoking the
    live endpoint: see the kiseki skill's feed-199 reference.
    """
    from app.graph import client as graph_client

    for query in (
        graph_client._Q_TRIPS_FOR_ME_ORDERED,
        graph_client._Q_TRIPS_OF_FOLLOWED,
    ):
        assert "AS by" not in query
        assert "AS actor" in query


def test_ordered_trip_row_reads_the_actor_alias() -> None:
    from app.graph.client import _ordered_trip_row

    row = _ordered_trip_row(
        {"dtId": "t1", "title": "T", "at": "2026-09-14T10:00:00Z", "actor": "auth0|me"}
    )
    assert row["by"] == "auth0|me"
    assert row["at"] == "2026-09-14T10:00:00Z"
