"""Write-path endpoint tests (issue #46).

Every test runs against the in-memory ``FakeGraph`` (seeded from a committed
anon fixture) with the REAL ACL + store + service code — the fake is swapped in
only at ``store._graph_client``. So a write test asserts the full chain:

    auth token → require_trip_role (role from the fake's hasCrew edge)
              → write service (validation, JSON-Patch ops, ordering)
              → fake graph applies the ops
              → response rebuilt from the fake (write → read roundtrip)

The test user (``google-oauth2|1234567890``) is granted a crew role via
``FakeGraph.add_user_role`` per test. ``graph()`` returns a factory: call it
with a role to stage that permission for the request.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.graph.convert import graph_to_trip
from app.main import app
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
AGENT_CLIENT = "cyKpzLkq8J5LMFPfWYOioG8VzYsMgm8U"


def _token_of(rsa_keypair, **overrides: object) -> str:
    return _sign(rsa_keypair, _claims(**overrides))


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    reset_rate_limits()
    yield
    reset_rate_limits()


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    return TestClient(app)


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch):
    """Factory: stage a FakeGraph + give the test user a crew role on it."""
    made: list[FakeGraph] = []

    def _make(role: str = "owner", fixture: str = "canada-2027.graph.anon.json",
              sub: str = SUB) -> FakeGraph:
        g = FakeGraph(fixture)
        g.add_user_role(g.root, sub, role)
        monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
        made.append(g)
        return g

    yield _make
    for g in made:
        store_mod._reset_store_cache()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _trip_of(g: FakeGraph):
    return graph_to_trip(g.fetch_graph(g.root))


def _authz(client, method, url, token, json=None):
    return client.request(method, url, headers=_auth(token), json=json)


# ---------------------------------------------------------------- no graph
def test_write_requires_graph_role(client, rsa_keypair) -> None:
    """Local/CI (no graph): the ACL cannot resolve ANY crew role, so a write
    with a valid token is 403 (never a fake success against anon mocks). A 503
    still surfaces when the graph is configured but unreachable (service
    guard / GraphWriteError)."""
    token = _token_of(rsa_keypair)
    r = client.put("/api/trips/00000000-0000-4000-8000-000000000000",
                   headers=_auth(token), json={"title": "x"})
    assert r.status_code in (403, 503)
    assert client.put("/api/trips/00000000-0000-4000-8000-000000000000",
                      json={"title": "x"}).status_code == 401


# ---------------------------------------------------------------- ACL matrix
@pytest.mark.parametrize("method,path_suffix,body", [
    ("put", "", {"title": "Renamed"}),
    ("put", "/practical", {"todos": [], "links": [], "notes": "n", "contacts": []}),
    ("post", "/practical/todos", {"label": "Book lift passes"}),
    ("put", "/days/DAY", {"title": "New day title"}),
    ("put", "/sections/SEC", {"title": "New section title"}),
    ("post", "/blocks", {"kind": "note", "title": "n", "container": {"type": "day", "id": "DAY"}}),
    ("put", "/blocks/BLK", {"title": "edited"}),
    ("delete", "/blocks/BLK", None),
    ("post", "/blocks/BLK/move", {"container": {"type": "day", "id": "DAY"}}),
    ("patch", "/crew/PER", {"note": "gear"}),
    ("post", "/crew", {"name": "New Person"}),
    ("put", "/locations", {"locations": []}),
])
def test_write_acl_matrix(client, rsa_keypair, graph, method, path_suffix, body) -> None:
    """Every write endpoint: 401 anonymous, 403 for viewer/follower, 200/201
    for editor+, owner-only delete-crew separated below."""
    g = graph(role="owner")
    trip = _trip_of(g)
    url = f"/api/trips/{trip.id}{path_suffix}".replace(
        "/DAY", f"/{trip.days[0].id}"
    ).replace("/SEC", f"/{trip.sections[0].id}").replace(
        "/BLK", f"/{trip.days[0].blocks[0].id}"
    ).replace("/PER", f"/{trip.crew[0].id}")
    # Body placeholders ("DAY"/"SEC" container refs) need the real ids too.
    if body is not None:
        import json as _json
        body = _json.loads(_json.dumps(body)
                           .replace('"DAY"', f'"{trip.days[0].id}"')
                           .replace('"SEC"', f'"{trip.sections[0].id}"'))

    # anonymous
    assert client.request(method, url, json=body).status_code in (401,)
    # viewer + follower: read-only
    for low_role in ("viewer", "follower"):
        g.add_user_role(trip.id, SUB, low_role)
        low = _token_of(rsa_keypair)
        r = client.request(method, url, headers=_auth(low), json=body)
        assert r.status_code == 403, f"{method} {path_suffix} allowed {low_role}: {r.status_code}"
        g.add_user_role(trip.id, SUB, "owner")  # restore for next role leg
    # editor
    g.add_user_role(trip.id, SUB, "editor")
    token = _token_of(rsa_keypair)
    r = client.request(method, url, headers=_auth(token), json=body)
    assert r.status_code in (200, 201), f"{method} {path_suffix}: {r.status_code} {r.text[:200]}"


def test_delete_crew_owner_only(client, rsa_keypair, graph) -> None:
    g = graph(role="editor")
    trip = _trip_of(g)
    url = f"/api/trips/{trip.id}/crew/{trip.crew[0].id}"
    r = client.delete(url, headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 403
    g.add_user_role(trip.id, SUB, "owner")
    r = client.delete(url, headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 200


# ---------------------------------------------------------------- trip level
def test_put_trip_edits_fields_and_attribution(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    r = _authz(client, "put", f"/api/trips/{trip.id}", token, json={
        "title": "Canada Heliski + Resorts",
        "stage": "live",
        "timezone": "America/Vancouver",
        "theme": {"primary": "#7f1d1d"},
        "cover": "c383ce57.jpg",  # bare media filename, canonicalized on write-back
    })
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Canada Heliski + Resorts"
    assert body["stage"] == "live"
    assert body["timezone"] == "America/Vancouver"
    assert body["theme"]["primary"] == "#7f1d1d"
    assert body["theme"]["accent"] == trip.theme.accent  # untouched partial theme
    assert body["cover"] == f"/media/{trip.id}/c383ce57.jpg"  # canonicalized, not bare
    assert "claimToken" not in body
    # x-user-id attribution reached the graph client
    assert any(h.get("x-user-id") == SUB for h in g.write_headers)


def test_put_trip_rejects_claim_token_and_unknown_fields(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    r = _authz(client, "put", f"/api/trips/{trip.id}", token,
               json={"claimToken": "leak-me"})
    assert r.status_code == 422
    r = _authz(client, "put", f"/api/trips/{trip.id}", token, json={"madeUpField": 1})
    assert r.status_code == 422


def test_stage_machine_rules(client, rsa_keypair, graph) -> None:
    g = graph(role="editor")
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}"

    # editor: backward transition forbidden (canada is 'booked'; 'planned' is back)
    r = _authz(client, "put", url, token, json={"stage": "planned"})
    assert r.status_code == 403
    # editor: forward skip OK (booked -> archive is forward BUT owner-only)
    r = _authz(client, "put", url, token, json={"stage": "archive"})
    assert r.status_code == 403
    # owner: forward skip into archive OK
    g.add_user_role(trip.id, SUB, "owner")
    r = _authz(client, "put", url, token, json={"stage": "archive"})
    assert r.status_code == 200 and r.json()["stage"] == "archive"
    # owner: un-archive (backward) OK
    r = _authz(client, "put", url, token, json={"stage": "booked"})
    assert r.status_code == 200 and r.json()["stage"] == "booked"


def test_visibility_owner_only(client, rsa_keypair, graph) -> None:
    g = graph(role="editor")
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    r = _authz(client, "put", f"/api/trips/{trip.id}", token, json={"visibility": "private"})
    assert r.status_code == 403
    g.add_user_role(trip.id, SUB, "owner")
    r = _authz(client, "put", f"/api/trips/{trip.id}", token, json={"visibility": "private"})
    assert r.status_code == 200
    assert r.json()["visibility"] == "private"


def test_put_trip_validates_dates(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    r = _authz(client, "put", f"/api/trips/{trip.id}", _token_of(rsa_keypair),
               json={"startDate": "not-a-date"})
    assert r.status_code == 422


# ---------------------------------------------------------------- practical (the #46 proof slice)
def test_todo_toggle_roundtrip(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    url = f"/api/trips/{trip.id}"
    token = _token_of(rsa_keypair)

    # Ensure at least two todos exist
    if len(trip.practical.todos) < 2:
        for label in ("Todo A", "Todo B"):
            r = _authz(client, "post", f"{url}/practical/todos", token, json={"label": label})
            assert r.status_code == 200
        trip = _trip_of(g)

    # The smallest useful write: flip one item, leave the others untouched.
    n = len(trip.practical.todos)
    r = _authz(client, "post", f"{url}/practical/todos/0/toggle", token, json={"done": True})
    assert r.status_code == 200
    body = r.json()
    assert body["practical"]["todos"][0]["done"] is True
    assert len(body["practical"]["todos"]) == n  # nothing lost
    # Out-of-range index -> 404
    r = _authz(client, "post", f"{url}/practical/todos/{n + 5}/toggle", token, json={"done": True})
    assert r.status_code == 404


def test_concurrent_item_toggles_do_not_clobber(client, rsa_keypair, graph) -> None:
    """#46 acceptance: two crew toggling DIFFERENT todos keep both changes
    (per-item JSON-Patch paths, not whole-array replace)."""
    g = graph()
    trip = _trip_of(g)
    url = f"/api/trips/{trip.id}"
    token = _token_of(rsa_keypair)
    while len(_trip_of(g).practical.todos) < 3:
        _authz(client, "post", f"{url}/practical/todos", token, json={"label": "more"})
    r1 = _authz(client, "post", f"{url}/practical/todos/0/toggle", token, json={"done": True})
    r2 = _authz(client, "post", f"{url}/practical/todos/1/toggle", token, json={"done": True})
    assert r1.status_code == 200 and r2.status_code == 200
    todos = _trip_of(g).practical.todos
    assert todos[0].done is True and todos[1].done is True


def test_put_practical_replaces_whole_object(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    r = _authz(client, "put", f"/api/trips/{trip.id}/practical", _token_of(rsa_keypair), json={
        "todos": [{"label": "Only todo", "done": False, "when": "Feb 15"}],
        "links": [{"label": "Docs", "url": "https://example.com"}],
        "notes": "Bring the puffer.",
        "contacts": [{"label": "Lodge", "value": "+1 555 0100"}],
    })
    assert r.status_code == 200
    p = r.json()["practical"]
    assert p["todos"] == [{"label": "Only todo", "done": False, "when": "Feb 15", "links": []}]
    assert p["notes"] == "Bring the puffer."
    assert p["contacts"][0]["value"] == "+1 555 0100"


# ---------------------------------------------------------------- blocks
def _day_and_section(g):
    trip = _trip_of(g)
    return trip, trip.days[0].id, trip.sections[0].id


def test_create_block_appends_and_orders(client, rsa_keypair, graph) -> None:
    g = graph()
    trip, day_id, _ = _day_and_section(g)
    before = [b.id for b in trip.days[0].blocks]
    r = _authz(client, "post", f"/api/trips/{trip.id}/blocks", _token_of(rsa_keypair), json={
        "kind": "activity",
        "title": "Evening soak at the hot springs",
        "time": "19:00",
        "description": "Banff Upper Hot Springs",
        "cost": 16.5,
        "currency": "CAD",
        "container": {"type": "day", "id": day_id},
    })
    assert r.status_code == 201
    body = r.json()
    day = next(d for d in body["days"] if d["id"] == day_id)
    assert len(day["blocks"]) == len(before) + 1
    new_block = day["blocks"][-1]
    assert new_block["title"] == "Evening soak at the hot springs"
    assert new_block["kind"] == "activity"
    assert new_block["order"] == len(before)
    # visible on a subsequent plain GET (cache retired by the write)
    got = client.get(f"/api/trips/{trip.id}", headers=_auth(_token_of(rsa_keypair))).json()
    assert any(b["id"] == new_block["id"] for d in got["days"] for b in d["blocks"])


def test_create_block_insert_at_index_shifts(client, rsa_keypair, graph) -> None:
    g = graph()
    trip, day_id, _ = _day_and_section(g)
    blocks = trip.days[0].blocks
    r = _authz(client, "post", f"/api/trips/{trip.id}/blocks", _token_of(rsa_keypair), json={
        "kind": "note", "title": "Inserted second", "container": {"type": "day", "id": day_id},
        "index": 1,
    })
    assert r.status_code == 201
    body = r.json()
    day = next(d for d in body["days"] if d["id"] == day_id)
    by_order = sorted(day["blocks"], key=lambda b: b["order"])
    # order props are contiguous with no gaps, insertion landed at position 1
    assert [b["order"] for b in by_order] == list(range(len(by_order)))
    assert by_order[1]["title"] == "Inserted second"
    assert by_order[2]["id"] == blocks[1].id  # old second block shifted


def test_update_block_fields_and_kind_rules(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    block = trip.days[0].blocks[0]
    url = f"/api/trips/{trip.id}/blocks/{block.id}"

    r = _authz(client, "put", url, token, json={"title": "Edited title", "status": "booked"})
    assert r.status_code == 200
    got = _trip_of(g)
    edited = next(b for d in got.days for b in d.blocks if b.id == block.id)
    assert edited.title == "Edited title" and edited.status == "booked"
    # kind is immutable; transport fields rejected on non-transport kinds
    r = _authz(client, "put", url, token, json={"kind": "lodging"})
    assert r.status_code == 422
    if edited.kind != "transport":
        r = _authz(client, "put", url, token, json={"distance": "5 km"})
        assert r.status_code == 422
    # order is server-managed
    r = _authz(client, "put", url, token, json={"order": 9})
    assert r.status_code == 422


def test_concurrent_block_edits_do_not_clobber(client, rsa_keypair, graph) -> None:
    """#46 acceptance: two crew editing DIFFERENT blocks of one day keep both
    edits (per-twin writes; the day is never replaced as a whole)."""
    g = graph()
    trip = _trip_of(g)
    day = trip.days[0]
    assert len(day.blocks) >= 2, "need a day with 2+ blocks in the fixture"
    b1, b2 = day.blocks[0], day.blocks[1]
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/blocks"
    r1 = _authz(client, "put", f"{url}/{b1.id}", token, json={"title": "Changed by A"})
    r2 = _authz(client, "put", f"{url}/{b2.id}", token, json={"title": "Changed by B"})
    assert r1.status_code == 200 and r2.status_code == 200
    got = _trip_of(g)
    titles = {b.id: b.title for d in got.days for b in d.blocks}
    assert titles[b1.id] == "Changed by A"
    assert titles[b2.id] == "Changed by B"


def test_delete_block_renumbers(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    day = trip.days[0]
    victim = day.blocks[1]
    r = _authz(client, "delete", f"/api/trips/{trip.id}/blocks/{victim.id}",
               _token_of(rsa_keypair))
    assert r.status_code == 200
    got = _trip_of(g)
    remaining = [b for d in got.days if d.id == day.id for b in d.blocks]
    assert victim.id not in [b.id for b in remaining]
    assert [b.order for b in remaining] == list(range(len(remaining)))


def test_promote_section_block_to_day(client, rsa_keypair, graph) -> None:
    """DESIGN §7.5 'schedule this': a block moves section → day."""
    g = graph()
    trip, day_id, section_id = _day_and_section(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}"

    # Seed an unscheduled idea on the section.
    r = _authz(client, "post", f"{url}/blocks", token, json={
        "kind": "activity", "title": "Heli-accessed backcountry day",
        "container": {"type": "section", "id": section_id},
    })
    assert r.status_code == 201
    new_id = next(b["id"] for s in r.json()["sections"] if s["id"] == section_id
                  for b in s["blocks"] if b["title"] == "Heli-accessed backcountry day")

    # Promote it to the first day, at position 0.
    r = _authz(client, "post", f"{url}/blocks/{new_id}/move", token, json={
        "container": {"type": "day", "id": day_id}, "index": 0,
    })
    assert r.status_code == 200
    body = r.json()
    section_blocks = next(s for s in body["sections"] if s["id"] == section_id)["blocks"]
    day = next(d for d in body["days"] if d["id"] == day_id)
    assert new_id not in [b["id"] for b in section_blocks]  # left the pool
    # The promoted block sits FIRST by order (order prop is the sort key the
    # app renders by; the API lists blocks in edge order).
    day_by_order = sorted(day["blocks"], key=lambda b: b["order"])
    assert day_by_order[0]["id"] == new_id
    assert [b["order"] for b in day_by_order] == list(range(len(day_by_order)))


def test_demote_day_block_to_section_and_reorder(client, rsa_keypair, graph) -> None:
    g = graph()
    trip, day_id, section_id = _day_and_section(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}"
    victim = trip.days[0].blocks[0]

    r = _authz(client, "post", f"{url}/blocks/{victim.id}/move", token, json={
        "container": {"type": "section", "id": section_id},
    })
    assert r.status_code == 200
    body = r.json()
    assert victim.id in [b["id"] for s in body["sections"] if s["id"] == section_id
                         for b in s["blocks"]]
    day = next(d for d in body["days"] if d["id"] == day_id)
    assert victim.id not in [b["id"] for b in day["blocks"]]
    day_by_order = sorted(day["blocks"], key=lambda b: b["order"])
    assert [b["order"] for b in day_by_order] == list(range(len(day_by_order)))

    # Pure reorder via block-order (exact set, reversed).
    ids = [b["id"] for b in day_by_order]
    r = _authz(client, "put", f"{url}/containers/{day_id}/block-order", token,
               json={"block_ids": list(reversed(ids))})
    assert r.status_code == 200
    reordered = next(d for d in r.json()["days"] if d["id"] == day_id)["blocks"]
    assert [b["id"] for b in sorted(reordered, key=lambda b: b["order"])] == list(reversed(ids))
    # Non-exact set -> 422
    r = _authz(client, "put", f"{url}/containers/{day_id}/block-order", token,
               json={"block_ids": ids[:-1]})
    assert r.status_code == 422


def test_unknown_block_and_day_404(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    unknown = "00000000-0000-4000-8000-000000000000"
    r = _authz(client, "put", f"/api/trips/{trip.id}/blocks/{unknown}", token, json={"title": "x"})
    assert r.status_code == 404
    r = _authz(client, "put", f"/api/trips/{trip.id}/days/{unknown}", token, json={"title": "x"})
    assert r.status_code == 404


# ---------------------------------------------------------------- day/section
def test_put_day_and_section(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    day = trip.days[0]
    r = _authz(client, "put", f"/api/trips/{trip.id}/days/{day.id}", token, json={
        "title": "Arrival day (edited)", "meta": [{"label": "Stay", "value": "Banff"}],
    })
    assert r.status_code == 200
    d = next(x for x in r.json()["days"] if x["id"] == day.id)
    assert d["title"] == "Arrival day (edited)"
    assert d["meta"][0]["value"] == "Banff"
    # date is immutable
    r = _authz(client, "put", f"/api/trips/{trip.id}/days/{day.id}", token,
               json={"date": "2030-01-01"})
    assert r.status_code == 422

    section = trip.sections[0]
    name = trip.locations[0].name
    r = _authz(client, "put", f"/api/trips/{trip.id}/sections/{section.id}", token, json={
        "title": "Chapter 1", "locationRefs": [name],
    })
    assert r.status_code == 200
    s = next(x for x in r.json()["sections"] if x["id"] == section.id)
    assert s["title"] == "Chapter 1"
    assert name in s["locationRefs"]
    # unknown location name -> 422
    r = _authz(client, "put", f"/api/trips/{trip.id}/sections/{section.id}", token,
               json={"locationRefs": ["Nopeville"]})
    assert r.status_code == 422


def _section_days_of(s: Any) -> list[int]:
    d = s.days if hasattr(s, "days") else s["days"]
    return list(d)


def _section_by_days(doc_sections: list[Any], days: list[int]) -> Any:
    return next(s for s in doc_sections if _section_days_of(s) == days)


def test_section_location_refs_removal(client, rsa_keypair, graph) -> None:
    """Regression for issue #89's live 500: removing a section's locationRef
    deletes the atLocation edge UNDER THE SECTION (not the trip). The strict
    FakeGraph now enforces source scoping exactly like the real server."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    section = _section_by_days(trip.sections, [0, 1])  # Arrival & First Turns
    assert section.locationRefs  # fixture has at least one ref
    r = _authz(client, "put", f"/api/trips/{trip.id}/sections/{section.id}", token,
               json={"locationRefs": []})
    assert r.status_code == 200
    s = next(x for x in r.json()["sections"] if x["id"] == section.id)
    assert s["locationRefs"] == []


def test_section_days_trim_and_restore(client, rsa_keypair, graph) -> None:
    """PUT /sections now accepts days: rewiring hasDay edges (issue #89).
    Lake Louise [12, 15] -> [12, 14] must drop day 15 (Mar 2) from the chapter."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    section = _section_by_days(trip.sections, [12, 15])
    r = _authz(client, "put", f"/api/trips/{trip.id}/sections/{section.id}", token,
               json={"days": [12, 14]})
    assert r.status_code == 200
    s = next(x for x in r.json()["sections"] if x["id"] == section.id)
    assert s["days"] == [12, 14]
    # restore
    r = _authz(client, "put", f"/api/trips/{trip.id}/sections/{section.id}", token,
               json={"days": [12, 15]})
    assert r.status_code == 200
    s = next(x for x in r.json()["sections"] if x["id"] == section.id)
    assert s["days"] == [12, 15]


def test_section_days_validation(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    section = _section_by_days(trip.sections, [12, 15])
    for bad in ([12], [15, 12], [0, 99], [-1, 2], ["a", "b"], [12, None]):
        r = _authz(client, "put", f"/api/trips/{trip.id}/sections/{section.id}", token,
                   json={"days": bad})
        assert r.status_code == 422, f"days={bad} should be a 422"
    # overlap with the Kicking Horse section ([9, 11]) -> 422
    r = _authz(client, "put", f"/api/trips/{trip.id}/sections/{section.id}", token,
               json={"days": [11, 14]})
    assert r.status_code == 422
    assert "overlap" in r.json()["detail"].lower()


def test_post_section_creates_closing_chapter(client, rsa_keypair, graph) -> None:
    """POST /sections (issue #89): the Canada 'The way home' scenario — trim
    Lake Louise to its last real day, then add the slim Mar-2 chapter so every
    trip day stays covered by exactly one section."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    ll = _section_by_days(trip.sections, [12, 15])
    assert _authz(client, "put", f"/api/trips/{trip.id}/sections/{ll.id}", token,
                  json={"days": [12, 14]}).status_code == 200

    r = _authz(client, "post", f"/api/trips/{trip.id}/sections", token,
               json={"title": "The way home", "days": [15, 15]})
    assert r.status_code == 201
    secs = r.json()["sections"]
    new = next(s for s in secs if s["title"] == "The way home")
    assert new["days"] == [15, 15]
    assert new["locationRefs"] == []
    # the closing chapter must come LAST — hasSection edges carry an `index`
    # (chapter position); a missing index sorts first (default 0)
    assert secs[-1]["title"] == "The way home"
    # tiling invariant: every one of the 16 days covered exactly once
    covered: list[int] = []
    for s in secs:
        covered += list(range(s["days"][0], s["days"][1] + 1))
    assert sorted(covered) == list(range(16))


def test_post_section_validation_and_roles(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/sections"
    # out-of-bounds + overlap + unknown location + empty title
    assert _authz(client, "post", url, token,
                  json={"title": "x", "days": [15, 16]}).status_code == 422
    assert _authz(client, "post", url, token,
                  json={"title": "x", "days": [5, 6]}).status_code == 422
    assert _authz(client, "post", url, token,
                  json={"title": "x", "locationRefs": ["Nopeville"]}).status_code == 422
    assert _authz(client, "post", url, token, json={"title": ""}).status_code == 422
    # ideation section (no days) is allowed
    r = _authz(client, "post", url, token, json={"title": "Ideas"})
    assert r.status_code == 201
    assert next(s for s in r.json()["sections"] if s["title"] == "Ideas")["days"] == []
    # viewer cannot create/edit sections
    gv = graph(role="viewer")
    tripv = _trip_of(gv)
    tv = _token_of(rsa_keypair)
    assert _authz(client, "post", f"/api/trips/{tripv.id}/sections", tv,
                  json={"title": "x", "days": [0, 1]}).status_code == 403
    assert _authz(client, "put", f"/api/trips/{tripv.id}/sections/{tripv.sections[0].id}", tv,
                  json={"days": [0, 0]}).status_code == 403


# ---------------------------------------------------------------- crew
def test_crew_note_editor_role_owner(client, rsa_keypair, graph) -> None:
    g = graph(role="editor")
    trip = _trip_of(g)
    member = trip.crew[0]
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/crew/{member.id}"

    # editor may write the note (rides the hasCrew edge)
    r = _authz(client, "patch", url, token, json={"note": "Rides the edge"})
    assert r.status_code == 200
    crew = next(c for c in r.json()["crew"] if c["id"] == member.id)
    assert crew["note"] == "Rides the edge"
    # role changes are owner-only
    r = _authz(client, "patch", url, token, json={"role": "viewer"})
    assert r.status_code == 403
    g.add_user_role(trip.id, SUB, "owner")
    r = _authz(client, "patch", url, token, json={"role": "viewer"})
    assert r.status_code == 200
    assert next(c for c in r.json()["crew"] if c["id"] == member.id)["role"] == "viewer"


def test_add_and_remove_crew(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/crew"

    r = _authz(client, "post", url, token, json={
        "name": "Stefan De Pauw", "role": "editor", "note": "gear: splitboard",
    })
    assert r.status_code == 201
    new_member = next(c for c in r.json()["crew"] if c["name"] == "Stefan De Pauw")
    assert new_member["role"] == "editor"
    assert new_member["note"] == "gear: splitboard"
    # duplicate name -> 409
    r = _authz(client, "post", url, token, json={"name": "Stefan De Pauw"})
    assert r.status_code == 409
    # remove (owner) — placeholder Person is deleted with the edge
    r = client.delete(f"{url}/{new_member['id']}", headers=_auth(token))
    assert r.status_code == 200
    assert all(c["name"] != "Stefan De Pauw" for c in r.json()["crew"])


# ---------------------------------------------------------------- agent identity
# The agent has NO identity in the graph (no User twin, no hasCrew edge).
# User-initiated writes present the acting user's token. The sanctioned M2M
# client (azp + gty=client-credentials == KISEKI_AGENT_CLIENT_ID) resolves to
# an agent actor: with KISEKI_AGENT_ACT_AS it acts AS that user (their real
# role, never widened — the Niko home-profile mode); without it, it is an
# owner-level service principal (unattended fallback). Nothing is ever
# provisioned in the graph.


def _agent_token(rsa_keypair, azp=AGENT_CLIENT, gty="client-credentials", sub=None) -> str:
    return _token_of(rsa_keypair, azp=azp, gty=gty, sub=sub or f"{azp}@clients")


def _sanction(monkeypatch, act_as: str = "") -> None:
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", act_as)


def test_agent_m2m_owner_fallback_without_twin(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unattended mode (no ACT_AS): the M2M token writes as owner even though
    its sub has NO crew edge — and creates no graph identity doing so."""
    _sanction(monkeypatch)
    g = graph()  # only SUB (a human) has a crew edge — not the agent
    trip = _trip_of(g)
    twin_count = len(g.twins)
    agent_sub = f"{AGENT_CLIENT}@clients"

    r = _authz(client, "put", f"/api/trips/{trip.id}", _agent_token(rsa_keypair),
               json={"stage": "live"})
    assert r.status_code == 200
    body = r.json()
    assert body["stage"] == "live"
    assert body.get("myRole") == "owner"
    # attribution carries the agent client sub, but no twin was ever created
    assert any(h.get("x-user-id") == agent_sub for h in g.write_headers)
    assert len(g.twins) == twin_count
    assert all(t.get("$dtId") != agent_sub for t in g.twins)
    assert all(c.get("id") != agent_sub for c in body["crew"])


def test_agent_m2m_act_as_user(client, rsa_keypair, graph, monkeypatch) -> None:
    """Niko-profile mode (ACT_AS = a real user): the M2M call acts AS that
    user — ACL from their hasCrew edge, attribution = their sub, no agent
    twin, and the agent has no more power than the user."""
    _sanction(monkeypatch, act_as=SUB)
    g = graph()  # SUB holds the owner edge
    trip = _trip_of(g)
    twin_count = len(g.twins)

    r = _authz(client, "put", f"/api/trips/{trip.id}", _agent_token(rsa_keypair),
               json={"stage": "live"})
    assert r.status_code == 200
    assert r.json().get("myRole") == "owner"
    assert r.json()["stage"] == "live"
    # attribution is the USER's sub, not the agent client's
    assert any(h.get("x-user-id") == SUB for h in g.write_headers)
    assert all(h.get("x-user-id") != f"{AGENT_CLIENT}@clients" for h in g.write_headers)
    assert len(g.twins) == twin_count  # still nothing provisioned


def test_agent_m2m_act_as_respects_user_role(client, rsa_keypair, graph, monkeypatch) -> None:
    """Act-as grants exactly the mapped user's role — a viewer-mapped agent
    cannot write, and a user with no access maps to no access."""
    _sanction(monkeypatch, act_as=SUB)
    g = graph(role="viewer")
    trip = _trip_of(g)
    r = _authz(client, "put", f"/api/trips/{trip.id}", _agent_token(rsa_keypair),
               json={"stage": "live"})
    assert r.status_code == 403
    # mapped user has no edge at all → agent has no access either
    _sanction(monkeypatch, act_as="google-oauth2|999")
    r = _authz(client, "put", f"/api/trips/{trip.id}", _agent_token(rsa_keypair),
               json={"stage": "live"})
    assert r.status_code == 403


def test_agent_m2m_reads_private_trip(client, rsa_keypair, graph, monkeypatch) -> None:
    _sanction(monkeypatch)
    g = graph()
    trip = _trip_of(g)
    g.set_twin_prop(trip.id, "visibility", "private")
    r = client.get(f"/api/trips/{trip.id}", headers=_auth(_agent_token(rsa_keypair)))
    assert r.status_code == 200
    assert r.json().get("myRole") == "owner"


def test_agent_m2m_requires_sanctioned_client(client, rsa_keypair, graph, monkeypatch) -> None:
    _sanction(monkeypatch)
    g = graph()
    trip = _trip_of(g)
    url = f"/api/trips/{trip.id}"

    # A different M2M client is NOT privileged.
    other = _agent_token(rsa_keypair, azp="some-other-client-123")
    assert _authz(client, "put", url, other, json={"stage": "live"}).status_code == 403
    # An interactive token for the agent client (no gty=client-credentials) is NOT.
    interactive = _agent_token(rsa_keypair, gty="authorization_code")
    assert _authz(client, "put", url, interactive, json={"stage": "live"}).status_code == 403
    # Unsanctioned deployment (env unset): the M2M token is just another caller.
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", "")
    assert _authz(client, "put", url, _agent_token(rsa_keypair),
                  json={"stage": "live"}).status_code == 403


def test_user_token_still_requires_crew_edge(client, rsa_keypair, graph, monkeypatch) -> None:
    """Sanctioning the agent client never widens HUMAN tokens: a user without
    a crew edge stays 403 even with the agent client configured."""
    _sanction(monkeypatch)
    g = graph()
    trip = _trip_of(g)
    nobody = _token_of(rsa_keypair, sub="google-oauth2|999", azp=CLIENT_ID)
    assert _authz(client, "put", f"/api/trips/{trip.id}", nobody,
                  json={"stage": "live"}).status_code == 403


# ---------------------------------------------------------------- locations
def test_put_locations_reconciles_by_name(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"

    old_names = [loc.name for loc in trip.locations]
    kept = old_names[0]
    dropped = old_names[1]
    body = {
        "locations": [
            {"name": kept, "lat": 51.2, "lng": -115.5},          # kept + coords
            {"name": "New Place", "alias": ["NP"], "marker": 9},  # brand new
        ]
    }
    r = _authz(client, "put", url, token, json=body)
    assert r.status_code == 200
    locs = r.json()["locations"]
    assert [l["name"] for l in locs] == [kept, "New Place"]
    kept_out = next(l for l in locs if l["name"] == kept)
    assert kept_out["lat"] == 51.2 and kept_out["lng"] == -115.5
    new_out = next(l for l in locs if l["name"] == "New Place")
    assert new_out["alias"] == ["NP"] and new_out["marker"] == 9
    assert dropped not in [l["name"] for l in locs]
    # duplicate names -> 422
    r = _authz(client, "put", url, token, json={"locations": [
        {"name": "A"}, {"name": "A"}
    ]})
    assert r.status_code == 422
