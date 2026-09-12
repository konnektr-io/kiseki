"""Account erasure + portability export (issue #196, phase C).

Covers the two phase-C surfaces against the in-memory ``FakeGraph`` with the
REAL auth/ACL/store/service code (same harness as ``test_identity_196.py`` /
``test_profile_196.py``):

Erasure (``DELETE /api/me`` — the inverse of the claim flow):
1. Happy path on a trip the caller does NOT own: the trip keeps its crew row
   (same trip-relative name, role, note) as an unclaimed placeholder again.
2. The ``User`` twin is gone and ``follows`` edges in BOTH directions are gone.
3. Another user's trip is untouched (bundle-identical) and their twin intact;
   no ``hasCrew`` edge anywhere still points at the erased sub.
4. Owner gate: a caller who still owns a trip gets 409 and NOTHING is deleted.
5. No twin → 404. M2M token → 403.
6. Ordering/honesty: the fake refuses twin deletes with incident edges, and
   the erasure leaves edges-before-twin (no orphan edge, no dangling target).

Export (``GET /api/me/export``):
7. Shape: the six top-level keys; ``ownedTrips`` holds a full trip document;
   ``crewEntries`` holds the caller's row on someone else's trip.
8. Leak guard: no peer email and no other user's trip-relative note anywhere.
9. M2M → 403; caller with no twin → 404 (documented: erasure/export need an
   identity — the client calls ``ensure`` first, same rule as ``PUT /api/me``).
10. Both routes are registered on the app.
"""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.graph.convert import graph_to_trip
from app.main import app
from app.models import Trip
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
OTHER = "auth0|user-b-0000000001"
THIRD = "auth0|user-c-0000000002"
AGENT_CLIENT = "cyKpzLkq8J5LMFPfWYOioG8VzYsMgm8U"
PROFILE = {"email": "niko@example.com", "name": "Niko Raes"}


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
    monkeypatch.setattr(auth_module, "fetch_userinfo", lambda token: dict(PROFILE))
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


def _trip_of(g: FakeGraph) -> Trip:
    return graph_to_trip(g.fetch_graph(g.root))


def _ensure_user(g: FakeGraph, sub: str, name: str) -> None:
    assert g.create_user_twin(sub, {"email": f"{name}@example.com", "name": name})


def _add_trip(g: FakeGraph, title: str, visibility: str = "private",
              discoverable: bool = False, crew: dict | None = None) -> str:
    """Stage a second trip twin (+ hasCrew edges) inside the same FakeGraph."""
    tid = str(uuid.uuid4())
    twin = {
        "$dtId": tid,
        "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"},
        "title": title,
        "slug": title.lower().replace(" ", "-"),
        "visibility": visibility,
        "stage": "planned",
    }
    if discoverable:
        twin["discoverable"] = True
    g.twins.append(twin)
    for i, (sub, role) in enumerate((crew or {}).items()):
        g.rels.append({
            "$relationshipId": f"{tid}__hasCrew__{sub}",
            "$sourceId": tid,
            "$relationshipName": "hasCrew",
            "$targetId": sub,
            "role": role,
            "index": i,
        })
    return tid


def _crew_edge(g: FakeGraph, trip_dtid: str, target: str) -> dict | None:
    return next(
        (r for r in g.rels
         if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
         and r.get("$targetId") == target),
        None,
    )


# ------------------------------------------------------- 1–3. erasure happy path

def _erasure_setup(g: FakeGraph) -> None:
    """SUB is a viewer (NOT owner) with a trip-relative name + note that
    differs from the account name; SUB follows OTHER; THIRD follows SUB."""
    edge = _crew_edge(g, g.root, SUB)
    assert edge is not None
    edge["role"] = "viewer"
    edge["displayName"] = "Crew Nick"
    edge["note"] = "skis hard"
    _ensure_user(g, OTHER, "Other User")
    _ensure_user(g, THIRD, "Third Person")
    assert g.follow_user(SUB, OTHER)
    assert g.follow_user(THIRD, SUB)


def test_erasure_reverts_crew_row_and_drops_identity(client, rsa_keypair, graph) -> None:
    g = graph(role="viewer")
    _erasure_setup(g)
    old_edge = dict(_crew_edge(g, g.root, SUB) or {})
    token = _token_of(rsa_keypair)

    r = client.delete("/api/me", headers=_auth(token))
    assert r.status_code == 200
    body = r.json()["deleted"]
    assert body == {
        "sub": SUB,
        "crewEntriesReverted": 1,
        "followsRemoved": 2,
        "twinDeleted": True,
    }

    # The trip still exists with the SAME row — the crew's name, not the
    # account's ("Test Owner") — now an unclaimed placeholder again.
    trip = _trip_of(g)
    me = next(c for c in trip.crew if c.name == "Crew Nick")
    assert me.role == "viewer"
    assert me.note == "skis hard"
    assert me.claimed is False
    twin = g.twin(me.id)
    assert twin is not None
    assert (twin.get("$metadata") or {}).get("$model") == "dtmi:kiseki:travel:Person;1"
    # The new edge carries the same trip-relative facts at the same position.
    new_edge = _crew_edge(g, g.root, me.id)
    assert new_edge is not None
    assert new_edge.get("role") == old_edge.get("role")
    assert new_edge.get("index") == old_edge.get("index")
    assert new_edge.get("note") == "skis hard"
    assert new_edge.get("displayName") == "Crew Nick"

    # The account is gone: no twin, no follows either way.
    assert g.user_twin_exists(SUB) is False
    assert g.following_of(SUB) == []
    assert g.followers_of(SUB) == []
    assert g.following_of(THIRD) == []  # the third party no longer follows them

    # Second call: nothing left to erase → 404 (documented idempotency).
    assert client.delete("/api/me", headers=_auth(token)).status_code == 404


def test_erasure_revert_never_names_the_placeholder_with_the_sub(
    client, rsa_keypair, graph,
) -> None:
    """#213: a crew edge that stored the opaque auth sub as its label reverts
    onto a placeholder named the ACCOUNT name — a sub is not a crew label."""
    g = graph(role="viewer")
    edge = _crew_edge(g, g.root, SUB)
    assert edge is not None
    edge["role"] = "viewer"
    edge["displayName"] = SUB

    r = client.delete("/api/me", headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 200
    assert r.json()["deleted"]["crewEntriesReverted"] == 1

    trip = _trip_of(g)
    assert trip.crew
    assert all(c.name != SUB for c in trip.crew)
    mine = [c for c in trip.crew if c.name == "Test Owner"]  # the account name
    assert len(mine) == 1
    assert mine[0].id != SUB
    assert mine[0].claimed is False
    # The revert carries no label, so the read path falls back to the twin.
    new_edge = _crew_edge(g, g.root, mine[0].id)
    assert new_edge is not None
    assert new_edge.get("displayName") is None


def test_erasure_leaves_other_trips_and_users_untouched(
    client, rsa_keypair, graph,
) -> None:
    g = graph(role="viewer")
    _erasure_setup(g)
    other_tid = _add_trip(g, "Other Trip", crew={OTHER: "viewer", THIRD: "editor"})
    other_edge = _crew_edge(g, other_tid, OTHER)
    assert other_edge is not None
    other_edge["note"] = "OTHER-SECRET-NOTE"
    # The fake is one store: scope the snapshot to the other trip's own twin,
    # its crew edges and the other users' twins (the root trip's crew row is
    # SUPPOSED to change — that is the revert under test).
    other_twin_before = dict(g.twin(other_tid) or {})
    other_edges_before = [
        dict(r) for r in g.rels if r.get("$sourceId") == other_tid
    ]
    other_twin_user_before = dict(g.twin(OTHER) or {})
    third_twin_before = dict(g.twin(THIRD) or {})

    r = client.delete("/api/me", headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 200

    # The other trip is otherwise untouched: same twin, same crew edges, same
    # other users — and its crew still resolves through the converter.
    assert g.twin(other_tid) == other_twin_before
    assert [dict(r) for r in g.rels if r.get("$sourceId") == other_tid] == other_edges_before
    assert g.twin(OTHER) == other_twin_user_before
    assert g.twin(THIRD) == third_twin_before
    assert _crew_edge(g, other_tid, OTHER) is not None
    # No hasCrew edge anywhere still points at the erased sub.
    assert not [
        rel for rel in g.rels
        if rel.get("$relationshipName") == "hasCrew" and rel.get("$targetId") == SUB
    ]


# ------------------------------------------------------- 4–6. gates + ordering

def test_erasure_owner_gate_names_trip_and_deletes_nothing(
    client, rsa_keypair, graph,
) -> None:
    g = graph(role="owner")
    _ensure_user(g, OTHER, "Other User")
    assert g.follow_user(SUB, OTHER)
    twins_before = len(g.twins)
    rels_before = len(g.rels)
    trip = _trip_of(g)

    r = client.delete("/api/me", headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 409
    # The response names the blocking trip (id + title/slug).
    detail = r.json()["detail"]
    assert trip.title in json.dumps(detail)
    assert trip.id in json.dumps(detail)
    assert trip.slug in json.dumps(detail)

    # NOTHING was deleted: twin, crew edge and follows all still there.
    assert g.user_twin_exists(SUB) is True
    assert _crew_edge(g, g.root, SUB) is not None
    assert g.following_of(SUB) == [OTHER]
    assert len(g.twins) == twins_before
    assert len(g.rels) == rels_before


def test_erasure_no_twin_404_and_m2m_403(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    graph(role="owner")
    ghost = _token_of(rsa_keypair, sub="auth0|ghost-0000000009")
    assert client.delete("/api/me", headers=_auth(ghost)).status_code == 404

    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    m2m = _token_of(rsa_keypair, gty="client-credentials", azp=AGENT_CLIENT,
                    sub=f"{AGENT_CLIENT}@clients")
    assert client.delete("/api/me", headers=_auth(m2m)).status_code == 403
    assert client.delete(
        "/api/me", headers={**_auth(m2m), "X-Act-As-Sub": SUB}
    ).status_code == 403


def test_fake_refuses_twin_delete_with_incident_edges() -> None:
    """The double must refuse non-cascade deletes like the server — otherwise
    the erasure could delete the twin first and the tests would stay green."""
    g = FakeGraph()
    g.add_user_role(g.root, SUB, "viewer")
    assert g.delete_user_twin(SUB) is False  # the hasCrew edge is still there
    assert g.user_twin_exists(SUB) is True
    g.rels = [r for r in g.rels if r.get("$targetId") != SUB]
    assert g.delete_user_twin(SUB) is True
    assert g.user_twin_exists(SUB) is False
    assert g.delete_user_twin(SUB) is False  # already gone


# ------------------------------------------------------- 7–8. export

def _export_setup(g: FakeGraph) -> str:
    """SUB owns the root trip; SUB is a follower with a note on Other Trip;
    OTHER (with a secret note + email) is crew there too; social both ways."""
    other_tid = _add_trip(g, "Other Trip", crew={SUB: "follower", OTHER: "viewer"})
    sub_edge = _crew_edge(g, other_tid, SUB)
    assert sub_edge is not None
    sub_edge["note"] = "my packing list"
    sub_edge["displayName"] = "Crew Nick"
    other_edge = _crew_edge(g, other_tid, OTHER)
    assert other_edge is not None
    other_edge["note"] = "OTHER-SECRET-NOTE-XYZ"
    _ensure_user(g, OTHER, "Other User")
    _ensure_user(g, THIRD, "Third Person")
    assert g.follow_user(SUB, OTHER)
    assert g.follow_user(THIRD, SUB)
    return other_tid


def test_export_shape(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    other_tid = _export_setup(g)
    trip = _trip_of(g)

    r = client.get("/api/me/export", headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 200
    assert r.headers["content-disposition"] == 'attachment; filename="kiseki-export.json"'
    body = r.json()
    assert set(body) == {
        "generatedAt", "profile", "ownedTrips",
        "crewEntries", "following", "followers",
    }

    # Own twin props incl. the caller's own email — no $-prefixed keys.
    assert body["profile"]["email"] == "agent@test.local"
    assert not [k for k in body["profile"] if k.startswith("$")]

    # Owned trips hold FULL trip documents (a real field, not just non-empty).
    (owned,) = [t for t in body["ownedTrips"] if t["id"] == trip.id]
    assert owned["title"] == trip.title
    assert len(owned["days"]) == len(trip.days) > 0
    assert "claimToken" not in owned

    # Crew entries hold the caller's row on the trip they do NOT own.
    (entry,) = [e for e in body["crewEntries"] if e["tripId"] == other_tid]
    assert entry == {
        "tripId": other_tid,
        "title": "Other Trip",
        "slug": "other-trip",
        "role": "follower",
        "note": "my packing list",
        "displayName": "Crew Nick",
    }

    # Social graph: public-ish peer fields only.
    assert body["following"] == [
        {"sub": OTHER, "name": "Other User", "displayName": "Other User"}
    ]
    assert body["followers"] == [
        {"sub": THIRD, "name": "Third Person", "displayName": "Third Person"}
    ]


def test_export_leaks_no_peer_private_data(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _export_setup(g)

    r = client.get("/api/me/export", headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 200
    text = json.dumps(r.json())
    assert "OTHER-SECRET-NOTE-XYZ" not in text  # another user's trip note
    assert "Other User@example.com" not in text  # a peer's email
    assert "Third Person@example.com" not in text


def test_export_m2m_403_and_no_twin_404(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    graph(role="owner")
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    m2m = _token_of(rsa_keypair, gty="client-credentials", azp=AGENT_CLIENT,
                    sub=f"{AGENT_CLIENT}@clients")
    assert client.get("/api/me/export", headers=_auth(m2m)).status_code == 403

    ghost = _token_of(rsa_keypair, sub="auth0|ghost-0000000009")
    assert client.get("/api/me/export", headers=_auth(ghost)).status_code == 404


# ------------------------------------------------------- 10. route registration

def test_both_routes_are_registered() -> None:
    """Phase C's two routes exist on the app (user-token-only, like the other
    ``/api/me*`` routes — the 403 guards above pin the rule)."""
    routes = {(r.path, next(iter(getattr(r, "methods", []) or []))) for r in app.routes}
    assert ("/api/me", "DELETE") in routes
    assert ("/api/me/export", "GET") in routes


# ----------------------------------- 11. review fix: erasure must not replay PII

def test_erasure_does_not_replay_the_subjects_own_details(
    client, rsa_keypair, graph,
) -> None:
    """Erasure keeps the crew-authored trip row, but must NOT re-create the
    subject's own PII (#196 phase C review fix).

    The first cut read the account twin and wrote its ``contact`` onto the
    fresh placeholder, so a phone number/email held on the person's account
    survived the erasure on every trip they were crew on — the opposite of
    art. 17. The placeholder is name-only now; the trip-relative row
    (name/role/index/note/displayName) still survives (test 1).
    """
    g = graph(role="viewer")
    _erasure_setup(g)
    account_before = dict(g.twin(SUB) or {})
    secret_email = account_before.get("email")
    assert secret_email, "fixture must create the User twin with an email"
    secret_contact = "SUB-PHONE-555-0199"
    g.twin(SUB)["contact"] = secret_contact  # e.g. crew-typed via patch_crew

    assert client.delete(
        "/api/me", headers=_auth(_token_of(rsa_keypair))
    ).status_code == 200

    # Nothing anywhere in the store still carries the subject's own details...
    dump = json.dumps({"twins": g.twins, "rels": g.rels})
    assert secret_contact not in dump
    assert secret_email not in dump

    # ...and the placeholder the crew reads back is name-only: the trip's
    # trip-relative row survives, the person's contact details do not.
    me = next(c for c in _trip_of(g).crew if c.name == "Crew Nick")
    twin = g.twin(me.id)
    assert twin is not None
    assert "contact" not in twin
    assert "email" not in twin
    assert me.contact is None
    assert me.note == "skis hard"
    assert me.role == "viewer"
    assert me.claimed is False


# ------------------------------------- 12. review fix: partial failure resumes

def _edges_to(g: FakeGraph, sub: str) -> list[dict]:
    return [
        r for r in g.rels
        if r.get("$relationshipName") == "hasCrew" and r.get("$targetId") == sub
    ]


def test_erasure_is_retryable_after_a_partial_graph_failure(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A mid-way graph failure must not leave a HALF-erased account, and the
    retry must resume without double-reverting a crew row.

    The twin is deleted last and the work list comes from the live edges, so
    an already-reverted entry drops out of the list — this test pins both.
    """
    g = graph(role="viewer")
    _erasure_setup(g)  # SUB is crew on the root trip (crew name "Crew Nick")
    _add_trip(g, "Second Trip", crew={SUB: "viewer", OTHER: "editor"})
    token = _token_of(rsa_keypair)
    assert len(_edges_to(g, SUB)) == 2
    edges_before = len([r for r in g.rels if r.get("$relationshipName") == "hasCrew"])

    real = g.revert_crew_person
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:  # first revert succeeds, second one fails
            return False
        return real(*args, **kwargs)

    monkeypatch.setattr(g, "revert_crew_person", flaky)
    r = client.delete("/api/me", headers=_auth(token))
    assert r.status_code == 503
    assert calls["n"] == 2          # it stopped at the failure, no silent skip

    # NOT half-erased: the account, its follows and its remaining crew edge are
    # all still there, and only the one already-reverted row is a placeholder.
    assert g.user_twin_exists(SUB) is True
    assert g.following_of(SUB) == [OTHER]
    assert g.followers_of(SUB) == [THIRD]
    assert len(_edges_to(g, SUB)) == 1
    # A revert swaps an edge, it never loses or duplicates a crew row.
    assert len([r for r in g.rels if r.get("$relationshipName") == "hasCrew"]) == edges_before

    # Retry with the graph healthy again: it resumes, reverts only what is left
    # (one row, not two), and finishes the erasure.
    monkeypatch.setattr(g, "revert_crew_person", real)
    r2 = client.delete("/api/me", headers=_auth(token))
    assert r2.status_code == 200
    assert r2.json()["deleted"]["crewEntriesReverted"] == 1  # no double-revert
    assert _edges_to(g, SUB) == []
    assert g.user_twin_exists(SUB) is False
    assert client.delete("/api/me", headers=_auth(token)).status_code == 404
