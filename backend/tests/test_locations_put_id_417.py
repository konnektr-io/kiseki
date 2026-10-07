"""PUT /locations must honour `id` as the match key (issue #417).

Before #417 the schema exposed `id` on `LocationWrite` but the diff matched on
`name` alone, so a rename sent through the documented full-array PUT minted a
NEW twin (the sent id was silently ignored) and the old id was taken over by
whatever other payload item happened to carry the old name. That detaches
every id-shaped edge to the location — a section's `locationRef` — with no
error on the wire.

Contract under test (mirrors PATCH /locations and PUT /features):

* `id` supplied  -> match that twin (unknown id = 404), rename in place,
  twin id stable across the write.
* no `id`        -> match by name (create when the name is new).
* rename onto another location's name = 409, duplicate ids = 422, two payload
  entries resolving to the same twin = 409 (never a silent merge).
* a location dropped from the array is deleted when nothing else references
  it; a location still pinned by a section/block edge is left alone rather
  than 500-ing the write (#89's no-cascade rule).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.graph.convert import graph_to_trip
from app.main import app
from app.ratelimit import reset as reset_rate_limits
from app.write import _model_kind

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
GHOST_ID = "00000000-0000-4000-8000-000000000000"


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


def _location_twins(g: FakeGraph) -> dict[str, dict]:
    return {t["$dtId"]: t for t in g.twins if _model_kind(t) == "Location"}


def _referrers(g: FakeGraph, trip_dtid: str, lid: str) -> list[dict]:
    """Every edge pointing at ``lid`` that is NOT the trip's registry edge."""
    return [
        r for r in g.rels
        if r.get("$targetId") == lid
        and not (r.get("$sourceId") == trip_dtid
                 and r.get("$relationshipName") == "atLocation")
    ]


def test_rename_by_id_keeps_twin_id_and_reclaims_old_name(
    client, rsa_keypair, graph
) -> None:
    """The issue's payload: rename an entry by id AND let a second entry take
    over the old name in the same PUT. The id-bearing entry must update its
    twin in place; the takeover entry must get its own new twin."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"

    target = trip.locations[0]
    before_ids = {loc.id for loc in trip.locations}
    others = [loc for loc in trip.locations[1:]]

    payload = [{"id": target.id, "name": "Grand Hirafu"}]
    payload += [{"id": loc.id, "name": loc.name} for loc in others]
    payload.append({"name": target.name})  # brand-new entry, old name

    r = _authz(client, "put", url, token, json={"locations": payload})
    assert r.status_code == 200, r.text
    locs = r.json()["locations"]

    renamed = next(l for l in locs if l["name"] == "Grand Hirafu")
    assert renamed["id"] == target.id, "rename minted a new twin (#417)"

    takeover = next(l for l in locs if l["name"] == target.name)
    assert takeover["id"] != target.id
    assert takeover["id"] not in before_ids, "the old name's new entry must be a new twin"

    # every other entry kept its twin id — no silent re-creation anywhere
    kept_ids = {l["id"] for l in locs}
    assert kept_ids == before_ids | {takeover["id"]}
    assert len(locs) == len(payload)


def test_rename_by_id_keeps_section_location_ref_resolving(
    client, rsa_keypair, graph
) -> None:
    """A section locationRef is an edge to the twin: after an id-keyed rename
    it must still resolve (to the new name) instead of silently detaching."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"

    section = next(s for s in trip.sections if s.locationRefs)
    ref_name = section.locationRefs[0]
    target = next(loc for loc in trip.locations if loc.name == ref_name)
    refs_before = list(section.locationRefs)

    payload = [
        {"id": loc.id, "name": "Grand Hirafu" if loc.id == target.id else loc.name}
        for loc in trip.locations
    ]
    r = _authz(client, "put", url, token, json={"locations": payload})
    assert r.status_code == 200, r.text

    doc = r.json()
    after = next(s for s in doc["sections"] if s["id"] == section.id)
    assert len(after["locationRefs"]) == len(refs_before), "locationRef detached"
    assert "Grand Hirafu" in after["locationRefs"]
    assert ref_name not in after["locationRefs"]
    # the section's edge still points at the same twin, now carrying the new name
    assert _referrers(g, trip.id, target.id), "section edge lost its target"


def test_put_locations_rejects_bad_ids(client, rsa_keypair, graph) -> None:
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    first = trip.locations[0]

    # unknown id -> 404 (never silently ignored again)
    r = _authz(client, "put", url, token, json={"locations": [
        {"id": GHOST_ID, "name": "Ghost"},
    ]})
    assert r.status_code == 404, r.text

    # duplicate ids in one payload -> 422 (PUT's duplicate-key convention)
    r = _authz(client, "put", url, token, json={"locations": [
        {"id": first.id, "name": first.name},
        {"id": first.id, "name": "Other"},
    ]})
    assert r.status_code == 422, r.text

    # a rejected payload must not have touched the registry: the 404 above
    # fires before any edge is dropped
    after = _trip_of(g)
    assert [loc.id for loc in after.locations] == [loc.id for loc in trip.locations]


def test_put_locations_rename_onto_a_pinned_name_is_409(
    client, rsa_keypair, graph
) -> None:
    """Renaming onto a location that survives this write (its name is pinned by
    another edge, so it stays in the graph) collides — 409, nothing written."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"

    pinned = next(
        loc for loc in trip.locations[1:] if _referrers(g, trip.id, loc.id)
    )
    mover = next(loc for loc in trip.locations if loc.id != pinned.id)

    payload = [
        {"id": loc.id,
         "name": pinned.name if loc.id == mover.id else loc.name}
        for loc in trip.locations
        if loc.id != pinned.id
    ]
    r = _authz(client, "put", url, token, json={"locations": payload})
    assert r.status_code == 409, r.text
    assert [loc.id for loc in _trip_of(g).locations] == [loc.id for loc in trip.locations]


def test_put_locations_rename_onto_a_dropped_name_is_allowed(
    client, rsa_keypair, graph
) -> None:
    """The flip side: dropping a location AND moving another one onto its name
    in one PUT is a legal edit — the name frees up with its twin."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    base = [{"id": loc.id, "name": loc.name} for loc in trip.locations]

    # a throwaway location: nothing references it, so the next PUT may drop it
    r = _authz(client, "put", url, token,
               json={"locations": base + [{"name": "Freeby"}]})
    assert r.status_code == 200, r.text
    freeby = next(l for l in r.json()["locations"] if l["name"] == "Freeby")
    assert not _referrers(g, trip.id, freeby["id"])

    mover = trip.locations[0]
    payload = [loc for loc in base if loc["id"] != mover.id]
    payload.append({"id": mover.id, "name": "Freeby"})  # drop Freeby, take its name

    r = _authz(client, "put", url, token, json={"locations": payload})
    assert r.status_code == 200, r.text

    locs = r.json()["locations"]
    moved = next(l for l in locs if l["id"] == mover.id)
    assert moved["name"] == "Freeby"
    assert freeby["id"] not in _location_twins(g), "dropped twin leaked as an orphan"
    assert mover.id in _location_twins(g)
    assert len(locs) == len(payload)


def test_put_locations_two_entries_one_twin_is_409_not_a_merge(
    client, rsa_keypair, graph
) -> None:
    """One entry matching by name and another matching the same twin by id
    describe ONE registry row as two — refuse it instead of collapsing the
    payload silently (the merge is what made #417's old twin carry a
    different payload item)."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"

    target = trip.locations[0]
    payload = [{"id": loc.id, "name": loc.name} for loc in trip.locations[1:]]
    payload.append({"name": target.name})                 # matches target by name
    payload.append({"id": target.id, "name": "Renamed"})  # matches target by id

    r = _authz(client, "put", url, token, json={"locations": payload})
    assert r.status_code == 409, r.text
    assert target.name in [loc.name for loc in _trip_of(g).locations]


def test_put_locations_deletes_removed_twin_but_spares_referenced_ones(
    client, rsa_keypair, graph
) -> None:
    """The diff's delete leg (it never ran: the old code keyed the lookup by
    name and probed it with an id). A removed location with nothing else
    pointing at it goes away; one still pinned by a section/block edge is
    kept, because the graph server refuses a non-cascade delete (#89)."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/locations"
    base = [{"id": loc.id, "name": loc.name} for loc in trip.locations]
    pinned = next(
        (loc for loc in trip.locations if _referrers(g, trip.id, loc.id)), None
    )

    # a throwaway location: nothing references it, so the next PUT may drop it
    r = _authz(client, "put", url, token,
               json={"locations": base + [{"name": "Throwaway"}]})
    assert r.status_code == 200, r.text
    throwaway = next(l for l in r.json()["locations"] if l["name"] == "Throwaway")
    assert not _referrers(g, trip.id, throwaway["id"])

    drop_names = {"Throwaway"}
    if pinned is not None:
        drop_names.add(pinned.name)
    payload = [loc for loc in base if loc["name"] not in drop_names]

    r = _authz(client, "put", url, token, json={"locations": payload})
    assert r.status_code == 200, r.text
    names = [loc["name"] for loc in r.json()["locations"]]

    assert "Throwaway" not in names
    assert throwaway["id"] not in _location_twins(g), "removed twin leaked as an orphan"
    if pinned is not None:
        # referenced: left in the graph (a cascade delete would have 500'd the
        # write), but out of the registry — no root edge points at it now
        assert pinned.name not in names
        assert pinned.id in _location_twins(g)
        assert not [
            r for r in g.rels
            if r.get("$sourceId") == trip.id
            and r.get("$relationshipName") == "atLocation"
            and r.get("$targetId") == pinned.id
        ]
