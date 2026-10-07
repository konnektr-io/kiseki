"""PUT /features must validate the whole payload BEFORE the destructive pass.

Before #419 the ordering in ``write.put_features`` was: drop every old
``hasFeature`` edge, delete the Feature twins that are gone, and only then walk
the payload entries — raising ``WriteError(404, "Unknown feature id …")`` or the
409 rename-collision on the first bad entry. The checks existed; they were simply
sequenced after the damage. So one unknown id in the payload returned a 404 that
*looked* like a clean rejection while every feature edge was already gone: the
read path only returns features whose target still holds a registry edge, so the
trip came back with ``features: []``.

Worse, the caller's retry could not repair it — ``features`` is empty, so a
re-send of the same titles mints NEW twins instead of reattaching the originals,
and every id the caller held is now dangling.

Contract under test (mirrors PUT /locations after #417):

* the whole payload resolves first — unknown id 404, retitle-collision 409,
  two entries onto one twin 409 — all decided before the first
  ``delete_relationship``;
* a rejected write leaves the registry byte-identical: same twin ids, same
  titles, same edge set, and the caller can retry the SAME payload successfully;
* the valid cases keep working (diff by title, rename-in-place on ``id``,
  card order = list position, deletes of dropped features).
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


def _feature_twins(g: FakeGraph) -> dict[str, dict]:
    return {t["$dtId"]: t for t in g.twins if _model_kind(t) == "Feature"}


def _feature_edges(g: FakeGraph, trip_dtid: str) -> list[dict]:
    return [
        r for r in g.rels
        if r.get("$sourceId") == trip_dtid
        and r.get("$relationshipName") == "hasFeature"
    ]


def _registry_state(g: FakeGraph, trip_dtid: str) -> list[tuple[str, str, int]]:
    """(targetId, title, index) for every card in the trip's feature registry,
    ordered by edge index — the fingerprint a rejected write must not disturb."""
    by_id = _feature_twins(g)
    rows = []
    for r in _feature_edges(g, trip_dtid):
        tid = r.get("$targetId")
        if isinstance(r.get("index"), int):
            rows.append((tid, by_id.get(tid, {}).get("title"), r["index"]))
    return sorted(rows, key=lambda row: row[2])


def _payload_from(trip) -> list[dict]:
    """The full round-trip payload the caller would send for this trip."""
    return [{"id": f.id, "title": f.title} for f in trip.features]


def test_unknown_id_leaves_the_registry_intact(client, rsa_keypair, graph) -> None:
    """The issue's repro: every entry valid except one carrying an id that does
    not exist. 404 — and NOTHING was dropped: same ids, titles, edge indexes."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/features"
    before = _registry_state(g, trip.id)
    assert len(before) >= 2

    payload = [{"id": f.id, "title": f.title} for f in trip.features[:-1]]
    payload.append({"id": GHOST_ID, "title": "Ghost"})

    r = _authz(client, "put", url, token, json={"features": payload})
    assert r.status_code == 404, r.text

    # the damage #419 is about: the 404 used to leave features: []
    after = _registry_state(g, trip.id)
    assert after == before, "a rejected PUT emptied the feature registry"
    assert [f.id for f in _trip_of(g).features] == [f.id for f in trip.features]


def test_retry_after_unknown_id_succeeds_and_keeps_twin_ids(
    client, rsa_keypair, graph
) -> None:
    """The caller's actual recovery path: send the corrected payload. The ids it
    held must still resolve to the SAME twins — before #419 the retry minted new
    twins because the registry was already empty."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/features"

    bad = _payload_from(trip)
    bad.append({"id": GHOST_ID, "title": "Ghost"})
    assert _authz(client, "put", url, token, json={"features": bad}).status_code == 404

    payload = _payload_from(trip)
    r = _authz(client, "put", url, token, json={"features": payload})
    assert r.status_code == 200, r.text

    feats = r.json()["features"]
    assert [f["id"] for f in feats] == [f.id for f in trip.features], \
        "the retry re-created twins instead of reattaching the originals"
    assert [f["title"] for f in feats] == [f.title for f in trip.features]


def test_retitle_collision_leaves_the_registry_intact(
    client, rsa_keypair, graph
) -> None:
    """The 409 leg, with its reachable shape: swapping two surviving cards'
    titles in one PUT. Both entries carry an id, so no title is duplicated (that
    would be the 422, which fires earlier and is also a clean rejection).

    A swap needs two PUTs — the first lands one title, the second the other — so
    a single PUT must refuse it. Both orders are refused."""
    for swap_first in (True, False):
        g = graph()
        trip = _trip_of(g)
        token = _token_of(rsa_keypair)
        url = f"/api/trips/{trip.id}/features"
        before = _registry_state(g, trip.id)

        a, b = trip.features[0], trip.features[1]
        swap = [
            {"id": a.id, "title": b.title},
            {"id": b.id, "title": a.title},
        ]
        payload = swap + [
            {"id": f.id, "title": f.title} for f in trip.features[2:]
        ]
        if not swap_first:
            payload = payload[2:] + swap

        r = _authz(client, "put", url, token, json={"features": payload})
        assert r.status_code == 409, f"swap_first={swap_first}: {r.text}"
        assert _registry_state(g, trip.id) == before, \
            "a rejected 409 disturbed the registry"


def test_duplicate_titles_422_leaves_the_registry_intact(
    client, rsa_keypair, graph
) -> None:
    """The 422 leg. It fires before anything is written (the payload-level
    check), so it must also leave the registry alone."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/features"
    before = _registry_state(g, trip.id)

    r = _authz(client, "put", url, token, json={"features": [
        {"title": trip.features[0].title},
        {"title": trip.features[0].title},
    ]})
    assert r.status_code == 422, r.text
    assert _registry_state(g, trip.id) == before, "a rejected 422 disturbed the registry"


def test_two_entries_one_twin_is_409_not_a_merge(client, rsa_keypair, graph) -> None:
    """One entry matching a twin by id and another by title describe ONE card as
    two — 409, not a silent collapse. Rejected before anything is written."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/features"
    before = _registry_state(g, trip.id)

    target = trip.features[0]
    payload = [{"id": f.id, "title": f.title} for f in trip.features[1:]]
    payload.append({"title": target.title})                  # matches by title
    payload.append({"id": target.id, "title": "Renamed"})     # matches by id

    r = _authz(client, "put", url, token, json={"features": payload})
    assert r.status_code == 409, r.text
    assert _registry_state(g, trip.id) == before, "409 disturbed the registry"


def test_rename_by_id_renames_in_place(client, rsa_keypair, graph) -> None:
    """The positive path an id-bearing entry promises: it renames its own twin
    (the id is stable), which is what makes a corrected retry meaningful."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/features"

    target = trip.features[0]
    payload = [
        {"id": f.id, "title": "Retitled card" if f.id == target.id else f.title}
        for f in trip.features
    ]
    r = _authz(client, "put", url, token, json={"features": payload})
    assert r.status_code == 200, r.text

    feats = r.json()["features"]
    renamed = next(f for f in feats if f["id"] == target.id)
    assert renamed["title"] == "Retitled card"
    assert target.title not in [f["title"] for f in feats]
    assert len(feats) == len(payload)


def test_rename_onto_a_dropped_title_is_allowed(client, rsa_keypair, graph) -> None:
    """The flip side, and the reason the collision check must not fire during
    the walk: dropping a card AND moving another onto its title in one PUT is a
    legal edit — the title frees up with its twin, in EITHER payload order."""
    g = graph()
    token = _token_of(rsa_keypair)
    base_trip = _trip_of(g)
    url = f"/api/trips/{base_trip.id}/features"

    # a throwaway card: nothing else references it, so the next PUT may drop it
    r = _authz(client, "put", url, token,
               json={"features": _payload_from(base_trip) + [{"title": "Freeby"}]})
    assert r.status_code == 200, r.text
    freeby = next(f for f in r.json()["features"] if f["title"] == "Freeby")

    for mover_first in (True, False):
        g = graph()
        trip = _trip_of(g)
        url = f"/api/trips/{trip.id}/features"
        kept = _payload_from(trip)
        # re-create the throwaway card in this fresh graph, then move one card
        # onto its title while dropping it
        r = _authz(client, "put", url, token,
                   json={"features": kept + [{"title": "Freeby"}]})
        assert r.status_code == 200, r.text
        freeby = next(f for f in r.json()["features"] if f["title"] == "Freeby")

        mover = trip.features[0]
        entries = [e for e in kept if e["id"] != mover.id]
        move = {"id": mover.id, "title": "Freeby"}
        if mover_first:
            entries.insert(0, move)
        else:
            entries.append(move)

        r = _authz(client, "put", url, token, json={"features": entries})
        assert r.status_code == 200, f"mover_first={mover_first}: {r.text}"

        feats = r.json()["features"]
        moved = next(f for f in feats if f["id"] == mover.id)
        assert moved["title"] == "Freeby", "rename did not land on the freed title"
        assert freeby["id"] not in _feature_twins(g), "dropped twin leaked as an orphan"
        assert len(feats) == len(entries)


def test_valid_put_still_edits_the_registry(client, rsa_keypair, graph) -> None:
    """Guard the fix against over-reach: a payload that passes validation still
    drops removed cards, keeps kept twins and rewrites the edge indexes."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}/features"

    kept, dropped = trip.features[0], trip.features[1]
    payload = [{"id": kept.id, "title": kept.title, "chips": ["Fresh"]}]
    payload += [{"id": f.id, "title": f.title} for f in trip.features[2:]]

    r = _authz(client, "put", url, token, json={"features": payload})
    assert r.status_code == 200, r.text

    feats = r.json()["features"]
    assert [f["id"] for f in feats] == [e["id"] for e in payload]
    assert dropped.id not in _feature_twins(g), "removed twin leaked as an orphan"
    kept_out = feats[0]
    assert kept_out["chips"] == ["Fresh"]
    # card order = list position
    assert [r["index"] for r in _feature_edges(g, trip.id)] == list(range(len(payload)))