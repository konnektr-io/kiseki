"""DELETE /api/trips/{trip_id} — delete a whole trip (issue #163).

Complement to test_create_trip.py (POST /api/trips, #9): the terminal
affordance for a botched half-create. Every test runs against the in-memory
``FakeGraph`` (seeded from the committed canada anon fixture) with the REAL
ACL + store + service code. The fake enforces the live server's rules the
service must satisfy:

  - twin deletes do NOT cascade — a twin with incident edges refuses to die
    ("Cannot delete a vertex that has edge(s)", #89), so the service must
    delete edges before twins;
  - relationship deletes are scoped under the edge's SOURCE twin — passing
    the trip id for a section/day/block-sourced edge fails like the live
    graph 404s (#89).

The under-test invariants: the trip is GONE (404 on re-read), nothing
trip-scoped survives in the fake's twins/rels, and claimed User twins do.
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

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"


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


# ------------------------------------------------------------------ happy path
def test_delete_trip_204_and_trip_is_gone(client, rsa_keypair, graph) -> None:
    """Owner delete → 204 no body, re-read 404, trip twin + everything
    scoped to it (days/sections/blocks/features/crew) gone from the graph."""
    g = graph()
    trip = _trip_of(g)
    scoped_ids = (
        {trip.id}
        | {d.id for d in trip.days}
        | {s.id for s in trip.sections}
        | {b.id for d in trip.days for b in d.blocks}
        | {b.id for s in trip.sections for b in (s.blocks or [])}
    )
    before_twin_kinds = {t["$dtId"]: t["$metadata"]["$model"] for t in g.twins}

    r = _authz(client, "delete", f"/api/trips/{trip.id}", _token_of(rsa_keypair))
    assert r.status_code == 204, r.text[:300]
    assert not r.content  # 204 carries no body — no trip document to return

    # A re-read is a 404 — the trip is gone for everyone.
    token = _token_of(rsa_keypair)
    got = client.get(f"/api/trips/{trip.id}", headers=_auth(token))
    assert got.status_code == 404

    # Nothing trip-scoped survived in the graph…
    twin_ids = {t["$dtId"] for t in g.twins}
    assert not (scoped_ids & twin_ids), sorted(scoped_ids & twin_ids)
    # …no trip-scoped relationships either…
    assert g.rels == [], [r_["$relationshipId"] for r_ in g.rels]
    # …and no User twin was ever deleted along with the trip.
    assert g.twin(SUB) is not None
    # Feature/Location twins only exist in this fixture as trip content.
    assert before_twin_kinds  # sanity: the fixture had twins to delete


def test_delete_trip_wipes_fixture_completely(client, rsa_keypair, graph) -> None:
    """The canada fixture has no foreign twins — after the delete the fake
    holds only the (surviving) test User twin. Proves the twin sweep reached
    every kind (Trip/Day/Block/Section/Feature/Location/Person placeholder)."""
    g = graph()
    trip = _trip_of(g)
    r = _authz(client, "delete", f"/api/trips/{trip.id}", _token_of(rsa_keypair))
    assert r.status_code == 204, r.text[:300]
    assert {t["$dtId"] for t in g.twins} == {SUB}


def test_delete_trip_edges_removed_before_twins(client, rsa_keypair, graph) -> None:
    """Edges-first ordering (the #89 no-cascade rule): every relationship
    delete must land BEFORE the twin deletes that would still touch it. The
    FakeGraph raises on any out-of-order delete, so a passing run IS the
    ordering proof; this additionally asserts no half-deleted husk is left:
    with edges gone and twins gone, a re-fetch is None."""
    g = graph()
    trip = _trip_of(g)
    r = _authz(client, "delete", f"/api/trips/{trip.id}", _token_of(rsa_keypair))
    assert r.status_code == 204, r.text[:300]
    assert g.fetch_graph(trip.id)["twins"] == []  # live-shaped Trip-less bundle (#171)


# ------------------------------------------------------------------ roles
def test_delete_trip_roles(client, rsa_keypair, graph) -> None:
    """Role gating: anonymous 401, follower/viewer/editor 403, owner 204.
    A non-owner must NOT have deleted anything."""
    g = graph()
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{g.root}"

    assert client.delete(url).status_code == 401

    for role in ("follower", "viewer", "editor"):
        gr = graph(role=role)
        trip = _trip_of(gr)
        r = _authz(client, "delete", f"/api/trips/{trip.id}", token)
        assert r.status_code == 403, f"{role} got {r.status_code}"
        # Nothing was deleted by the denied call.
        assert client.get(f"/api/trips/{trip.id}", headers=_auth(token)).status_code == 200

    go = graph(role="owner")
    tripo = _trip_of(go)
    assert _authz(client, "delete", f"/api/trips/{tripo.id}", token).status_code == 204


def test_delete_trip_404_on_second_delete(client, rsa_keypair, graph) -> None:
    """The cleanup-loop termination condition (issue #163 AC): the second
    delete is a 404 — 'Trip not found' — not a role-shaped 403, so callers
    can loop 'DELETE until 404' to finish a failed half-create cleanup.
    The existence check must precede the role verdict: even the OWNER gets
    the 404 (there is no role left to hold)."""
    g = graph()
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)
    url = f"/api/trips/{trip.id}"
    assert _authz(client, "delete", url, token).status_code == 204
    r2 = _authz(client, "delete", url, token)
    assert r2.status_code == 404
    assert r2.json()["detail"] == "Trip not found"
    # Auth still comes first: an anonymous second delete is a 401, not a 404.
    assert client.delete(url).status_code == 401


def test_delete_trip_404_unknown_trip(client, rsa_keypair, graph) -> None:
    """An unknown id is a 404 (for a valid token); anonymous stays 401
    (auth first)."""
    token = _token_of(rsa_keypair)
    unknown = "00000000-0000-4000-8000-000000000000"
    assert client.delete(f"/api/trips/{unknown}").status_code == 401
    r = _authz(client, "delete", f"/api/trips/{unknown}", token)
    assert r.status_code == 404
    assert r.json()["detail"] == "Trip not found"


def test_delete_trip_404_malformed_id_not_captured_by_spa(client, rsa_keypair, graph) -> None:
    """A non-UUID path under /api/trips must never fall through to the SPA
    shell (a 200 HTML would read as 'exists'); it is a route miss → 404 JSON
    with a valid token (or 401 without one)."""
    token = _token_of(rsa_keypair)
    r = client.delete("/api/trips/not-a-uuid", headers=_auth(token))
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")


def test_delete_trip_editor_403_detail(client, rsa_keypair, graph) -> None:
    """The 403 names the missing role, like every other gate on the API."""
    g = graph(role="editor")
    trip = _trip_of(g)
    r = _authz(client, "delete", f"/api/trips/{trip.id}", _token_of(rsa_keypair))
    assert r.status_code == 403
    assert "owner" in r.json()["detail"]


# ------------------------------------------------------------------ identity
def test_delete_trip_preserves_claimed_user_twins(client, rsa_keypair, graph) -> None:
    """Claimed User twins are global identities ($dtId = auth sub) — they
    survive a trip delete (only the trip-scoped hasCrew edge goes). The
    fixture's placeholder Persons are trip-scoped and DO go."""
    g = graph()
    trip = _trip_of(g)
    # Promote the fixture's owner placeholder into a claimed User twin
    # (what #6's claim does) alongside a still-placeholder Person viewer.
    placeholder = next(t for t in g.twins
                       if t["$metadata"]["$model"].endswith("Person;1"))
    user_twin = {**placeholder, "$dtId": SUB,
                 "$metadata": {"$model": "dtmi:kiseki:travel:User;1"}}
    g.twins = [t for t in g.twins if t["$dtId"] != placeholder["$dtId"]]
    g.twins.append(user_twin)
    # re-grant roles: owner (the claimed user) + a viewer on a placeholder
    g.rels = [r_ for r_ in g.rels if r_.get("$relationshipName") != "hasCrew"]
    g.add_user_role(trip.id, SUB, "owner")
    placeholder2_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    g.twins.append({
        "$dtId": placeholder2_id,
        "$metadata": {"$model": "dtmi:kiseki:travel:Person;1"},
        "name": "Pending Invitee",
    })
    g.rels.append({
        "$relationshipId": f"{trip.id}__hasCrew__{placeholder2_id}",
        "$sourceId": trip.id,
        "$relationshipName": "hasCrew",
        "$targetId": placeholder2_id,
        "role": "viewer",
        "index": 1,
    })

    r = _authz(client, "delete", f"/api/trips/{trip.id}", _token_of(rsa_keypair))
    assert r.status_code == 204, r.text[:300]
    assert g.twin(SUB) is not None  # claimed identity survives
    assert g.twin(placeholder2_id) is None  # placeholder goes with the trip


def test_delete_trip_keeps_crew_user_twins_out_of_trip_edges(
    client, rsa_keypair, graph
) -> None:
    """#222: a crew member's claimed User twin is a GLOBAL identity — its
    out-of-trip edges (``follows``) must survive a trip delete exactly like the
    twin itself, and the delete must still answer 204.

    The read bundle is deliberately wider than the trip (``MAX_HOPS = 3`` — the
    same reachability that finds ``hasCrew``), so it carries the crew's User
    twins *and their own outgoing* ``follows`` edges. The edge sweep must scope
    itself by the source twin's MODEL KIND — the twin sweep already skips User
    twins — instead of deleting whatever the bundle happened to return.

    Before the fix the sweep fed that follows edge (source = the owner's auth
    sub, ``google-oauth2|…``, not a UUID) to ``delete_relationship``, whose
    content guard refuses it: a ``GraphWriteError`` the route does not map, so a
    500 to the caller — with the trip-sourced edges already deleted, which left
    an orphan trip twin that retried as a 403 (its ``hasCrew`` edges were gone)
    and could no longer be deleted through the API at all.
    """
    g = graph()
    trip = _trip_of(g)
    other = "auth0|6a9adc933ad72cae116327a0"
    # A second crew member (claimed User twin) the owner follows — the follows
    # edge is sourced at the owner's sub, i.e. OUTSIDE the trip.
    g.add_user_role(trip.id, other, "viewer", name="Followed Person")
    assert g.follow_user(SUB, other) is True
    assert g.following_of(SUB) == [other]  # sanity: the out-of-trip edge exists

    r = _authz(client, "delete", f"/api/trips/{trip.id}", _token_of(rsa_keypair))
    assert r.status_code == 204, r.text[:300]

    # The trip is gone…
    assert g.fetch_graph(trip.id)["twins"] == []
    # …but both global identities survive, and so does the owner's follows edge.
    assert g.twin(SUB) is not None
    assert g.twin(other) is not None
    assert g.following_of(SUB) == [other]
    # The trip-scoped crew edges are gone all the same (no orphan hasCrew edge).
    assert g.rels_from(trip.id, "hasCrew") == []


def test_delete_trip_agent_act_as_owner_allowed(
    client, rsa_keypair, graph, monkeypatch
) -> None:
    """Mode 2 (the interim content-agent): the sanctioned M2M token acts AS
    Niko — his real owner crew role gates the delete, attribution is his sub
    (never the client's <client>@clients)."""
    AGENT_CLIENT = "cyKpzLkq8J5LMFPfWYOioG8VzYsMgm8U"
    from app import acl as acl_module

    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", SUB)
    g = graph()  # SUB holds the owner edge
    trip = _trip_of(g)
    claims = _claims()
    claims.update(azp=AGENT_CLIENT, gty="client-credentials")
    agent_token = _sign(rsa_keypair, claims)

    r = _authz(client, "delete", f"/api/trips/{trip.id}", agent_token)
    assert r.status_code == 204, r.text[:300]
    assert g.fetch_graph(trip.id)["twins"] == []  # live-shaped Trip-less bundle (#171)
    # attribution rode the user's sub on the graph writes
    assert any(h.get("x-user-id") == SUB for h in g.write_headers)
    assert all(h.get("x-user-id") != f"{AGENT_CLIENT}@clients" for h in g.write_headers)


def test_delete_trip_agent_owner_fallback_unattended(
    client, rsa_keypair, graph, monkeypatch
) -> None:
    """Unattended mode (no ACT_AS): the sanctioned M2M token is the
    documented owner-level service principal (AGENTS.md mode 3) — it may
    delete, attribution is the client sub, and NO twin is ever provisioned
    for it. Same contract as every other write gate (test_write_api.py
    test_agent_m2m_owner_fallback_without_twin); a whole-trip delete is not
    special-cased away from it."""
    AGENT_CLIENT = "cyKpzLkq8J5LMFPfWYOioG8VzYsMgm8U"
    from app import acl as acl_module

    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "")  # unattended
    g = graph()
    trip = _trip_of(g)
    agent_sub = f"{AGENT_CLIENT}@clients"
    claims = _claims(sub=agent_sub)
    claims.update(azp=AGENT_CLIENT, gty="client-credentials")
    agent_token = _sign(rsa_keypair, claims)

    r = _authz(client, "delete", f"/api/trips/{trip.id}", agent_token)
    assert r.status_code == 204, r.text[:300]
    assert g.fetch_graph(trip.id)["twins"] == []  # live-shaped Trip-less bundle (#171)
    # attribution rode the client sub; nothing was provisioned for it
    assert any(h.get("x-user-id") == agent_sub for h in g.write_headers)
    assert all(t.get("$dtId") != agent_sub for t in g.twins)
