"""Identity + model foundation (issue #196, phase A).

Covers the five phase-A surfaces against the in-memory ``FakeGraph`` with the
REAL auth/ACL/store/service code (same harness as ``test_write_api.py``):

1. ``Trip.discoverable`` — model default, owner-only PATCH, converter round-trip.
2. ``hasCrew.displayName`` — written on add-crew, carried through a claim
   (the trip keeps the crew's own name, not the account's), legacy fallback.
3. ``POST /api/me/ensure`` — idempotent twin provisioning, M2M refusal (403,
   act-as included), no-email ``ensured: false``, graph failure 503.
4. ``follows`` — follow/unfollow happy path, idempotency, self-follow 400,
   unknown target 404, one-directionality, M2M refusal, and NO trip access
   granted.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app import claims as claims_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.graph.convert import graph_to_trip
from app.main import app
from app.models import Trip
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph
from scripts.trip_to_graph import trip_to_graph

SUB = "google-oauth2|1234567890"
OTHER = "auth0|user-b-0000000001"
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


# ------------------------------------------------------- 1. discoverable

def test_discoverable_defaults_false() -> None:
    """The model default is False — nothing becomes listed by accident — and
    a pre-#196 bundle (no such property) reads back as False."""
    t = Trip.model_validate({
        "id": "11111111-1111-4111-8111-111111111111",
        "slug": "x", "title": "X",
    })
    assert t.discoverable is False

    g = FakeGraph()
    assert _trip_of(g).discoverable is False
    assert "discoverable" not in (g.twin(g.root) or {})


def test_discoverable_owner_only(client, rsa_keypair, graph) -> None:
    """Owner can flip the flag; a non-owner gets 403; an editor's normal
    scalar patch still works."""
    g = graph(role="owner")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)

    r = client.put(f"/api/trips/{trip.id}", headers=_auth(owner_tok),
                   json={"discoverable": True})
    assert r.status_code == 200
    assert r.json()["discoverable"] is True
    assert _trip_of(g).discoverable is True

    editor_sub = "auth0|editor-0000000002"
    g.add_user_role(g.root, editor_sub, "editor")
    editor_tok = _token_of(rsa_keypair, sub=editor_sub)
    r = client.put(f"/api/trips/{trip.id}", headers=_auth(editor_tok),
                   json={"discoverable": False})
    assert r.status_code == 403
    assert _trip_of(g).discoverable is True  # unchanged

    r = client.put(f"/api/trips/{trip.id}", headers=_auth(editor_tok),
                   json={"title": "Renamed by editor"})
    assert r.status_code == 200
    assert r.json()["title"] == "Renamed by editor"
    assert _trip_of(g).discoverable is True  # untouched by an unrelated patch


def test_discoverable_survives_trip_json_to_graph_to_trip(graph) -> None:
    """An opted-in trip carries the flag through the converter both ways —
    while a default trip emits NO such property (byte-stability for
    pre-#196 twins and fixtures)."""
    g = graph(role="owner")
    trip = _trip_of(g)

    opted = trip.model_copy(update={"discoverable": True})
    emitted = trip_to_graph(opted)
    root_twin = next(t for t in emitted["twins"] if t["$dtId"] == trip.id)
    assert root_twin.get("discoverable") is True
    assert graph_to_trip(emitted).discoverable is True

    plain = trip_to_graph(trip)
    root_plain = next(t for t in plain["twins"] if t["$dtId"] == trip.id)
    assert "discoverable" not in root_plain
    assert graph_to_trip(plain).discoverable is False


# ------------------------------------------------------- 2. hasCrew.displayName

def test_add_crew_writes_displayName_and_claim_keeps_it(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A claimed crew member keeps rendering the crew's OWN name — the
    account's name never leaks into the trip."""
    g = graph(role="owner")
    trip = _trip_of(g)
    token = _token_of(rsa_keypair)

    r = client.post(f"/api/trips/{trip.id}/crew", headers=_auth(token),
                    json={"name": "Crew Nick", "role": "viewer"})
    assert r.status_code == 201
    person_id = next(c["id"] for c in r.json()["crew"] if c["name"] == "Crew Nick")
    edge = next(
        x for x in g.rels
        if x.get("$relationshipName") == "hasCrew" and x.get("$targetId") == person_id
    )
    assert edge.get("displayName") == "Crew Nick"

    # The account behind the claim is called something else entirely.
    account = {"email": "account@example.com", "name": "Account Name"}
    monkeypatch.setattr(claims_module, "get_graph_client", lambda: g)
    claimed = claims_module.claim_identity(
        "REDACTED", person_id, "auth0|account-0000000003", account
    )
    me = next(c for c in claimed.crew if c.id == "auth0|account-0000000003")
    assert me.name == "Crew Nick"  # the crew's name, NOT "Account Name"
    assert me.claimed is True
    # ... and the placeholder is retired.
    assert not any(c.id == person_id for c in claimed.crew)


def test_crew_without_edge_displayName_falls_back_to_twin_name() -> None:
    """Legacy edges (written before #196) still read back correctly."""
    g = FakeGraph()
    trip = _trip_of(g)
    assert trip.crew, "fixture needs crew for the fallback assertion"
    for member in trip.crew:
        twin = g.twin(member.id)
        assert twin is not None
        assert member.name == twin.get("name")


def test_crew_edge_storing_the_person_id_is_not_a_name() -> None:
    """#213: an owner edge written when the token profile had no name stored
    the opaque auth sub as its ``displayName``. Readers treat that as "no
    name" and fall back to the twin, so no surface renders a sub as a person."""
    g = FakeGraph()
    edge = next(r for r in g.rels if r.get("$relationshipName") == "hasCrew")
    edge["displayName"] = edge["$targetId"]
    trip = _trip_of(g)
    member = next(c for c in trip.crew if c.id == edge["$targetId"])
    twin = g.twin(member.id)
    assert twin is not None
    assert member.name == twin.get("name")
    assert member.name != member.id


# ------------------------------------------------------- 3. ensure-my-twin

def test_ensure_graph_failure_is_503_never_ensured_false(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed twin write is a 503 — NOT ``ensured: false``, which the SPA
    reads as "no verified email, carry on". An outage must never be disguised
    as the benign missing-email case."""
    g = graph(role="owner")
    monkeypatch.setattr(g, "create_user_twin", lambda *a, **k: False)
    token = _token_of(rsa_keypair)

    r = client.post("/api/me/ensure", headers=_auth(token))
    assert r.status_code == 503
    assert "ensured" not in r.json()


def test_ensure_creates_twin_and_is_idempotent(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    assert g.twin(SUB) is not None  # crew role fixture already made the twin
    g.twins = [t for t in g.twins if t.get("$dtId") != SUB]
    g.rels = [r for r in g.rels if r.get("$targetId") != SUB]
    before = len(g.twins)

    token = _token_of(rsa_keypair)
    r = client.post("/api/me/ensure", headers=_auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body == {"sub": SUB, "ensured": True,
                    "name": "Niko Raes", "email": "niko@example.com"}
    assert len(g.twins) == before + 1

    r = client.post("/api/me/ensure", headers=_auth(token))
    assert r.status_code == 200
    assert r.json()["ensured"] is True
    assert len(g.twins) == before + 1  # second call duplicates nothing


def test_ensure_refuses_m2m_token_even_with_act_as(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``ensure`` PROVISIONS graph identity, so it obeys the claim/follow rule
    (``acl.require_user_token``): a sanctioned-agent M2M token is refused
    (403) — bare or carrying an act-as sub, because act-as must never
    provision a twin on the mapped user's behalf. Nothing is created for
    either sub."""
    g = graph(role="owner")
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    token = _token_of(rsa_keypair, gty="client-credentials", azp=AGENT_CLIENT,
                      sub=f"{AGENT_CLIENT}@clients")
    before = len(g.twins)

    r = client.post("/api/me/ensure", headers=_auth(token))
    assert r.status_code == 403

    r = client.post(
        "/api/me/ensure", headers={**_auth(token), "X-Act-As-Sub": OTHER}
    )
    assert r.status_code == 403

    assert len(g.twins) == before
    assert g.twin(OTHER) is None  # no twin for the client, none for the act-as sub


def test_ensure_without_email_reports_not_ensured(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No usable email anywhere → no broken twin, no crash: ensured false."""
    g = graph(role="owner")
    monkeypatch.setattr(auth_module, "fetch_userinfo", lambda token: {})
    token = _token_of(rsa_keypair)  # access-token claims carry no email
    before = len(g.twins)
    r = client.post("/api/me/ensure", headers=_auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["sub"] == SUB
    assert body["ensured"] is False
    assert len(g.twins) == before  # nothing provisioned


# ------------------------------------------------------- 4. follows

def _ensure_user(g: FakeGraph, sub: str, name: str) -> None:
    assert g.create_user_twin(sub, {"email": f"{name}@example.com", "name": name})


def test_follow_unfollow_happy_path_and_idempotent(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair)

    r = client.post(f"/api/users/{OTHER}/follow", headers=_auth(token))
    assert r.status_code == 200
    assert r.json() == {"sub": OTHER, "following": True}

    r = client.post(f"/api/users/{OTHER}/follow", headers=_auth(token))
    assert r.status_code == 200  # repeat follow is a no-op, not an error
    assert r.json()["following"] is True
    assert g.following_of(SUB) == [OTHER]

    r = client.delete(f"/api/users/{OTHER}/follow", headers=_auth(token))
    assert r.status_code == 200
    assert r.json() == {"sub": OTHER, "following": False}

    r = client.delete(f"/api/users/{OTHER}/follow", headers=_auth(token))
    assert r.status_code == 200  # repeat unfollow is a no-op too
    assert g.following_of(SUB) == []


def test_follow_self_is_400_and_unknown_target_is_404(client, rsa_keypair, graph) -> None:
    graph(role="owner")
    token = _token_of(rsa_keypair)

    r = client.post(f"/api/users/{SUB}/follow", headers=_auth(token))
    assert r.status_code == 400
    r = client.delete(f"/api/users/{SUB}/follow", headers=_auth(token))
    assert r.status_code == 400

    r = client.post("/api/users/auth0|no-such-user-0000/follow", headers=_auth(token))
    assert r.status_code == 404
    r = client.delete("/api/users/auth0|no-such-user-0000/follow", headers=_auth(token))
    assert r.status_code == 404


def test_follows_are_one_directional(client, rsa_keypair, graph) -> None:
    """A follows B says nothing about B follows A."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair)

    assert client.post(f"/api/users/{OTHER}/follow", headers=_auth(token)).status_code == 200
    assert g.following_of(SUB) == [OTHER]
    assert g.followers_of(OTHER) == [SUB]
    assert g.following_of(OTHER) == []
    assert g.followers_of(SUB) == []


def test_following_grants_no_trip_access(client, rsa_keypair, graph) -> None:
    """Following a person creates NO hasCrew edge: their private trip still
    403s for the follower."""
    g = graph(role="owner")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)
    # The followed user owns a PRIVATE trip; the follower is a stranger to it.
    g.add_user_role(g.root, OTHER, "owner")
    r = client.put(f"/api/trips/{trip.id}", headers=_auth(owner_tok),
                   json={"visibility": "private"})
    assert r.status_code == 200

    follower_sub = "auth0|follower-0000000004"
    _ensure_user(g, follower_sub, "Fan")
    follower_tok = _token_of(rsa_keypair, sub=follower_sub)
    # Step out of the crew: the follower must be a non-crew stranger.
    g.rels = [x for x in g.rels if x.get("$targetId") != follower_sub]
    g.twins = [t for t in g.twins if t.get("$dtId") != follower_sub]
    _ensure_user(g, follower_sub, "Fan")

    assert g.role_for_user_on_trip(g.root, follower_sub) is None
    r = client.post(f"/api/users/{OTHER}/follow", headers=_auth(follower_tok))
    assert r.status_code == 200
    assert g.following_of(follower_sub) == [OTHER]
    # Still no crew edge — the follow is social only.
    assert g.role_for_user_on_trip(g.root, follower_sub) is None

    r = client.get(f"/api/trips/{trip.id}", headers=_auth(follower_tok))
    assert r.status_code == 403


def test_follow_unfollow_refuse_m2m_token(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Follow writes a graph edge from the actor's own twin, so it obeys the
    claim/follow rule (``acl.require_user_token``): an M2M client token is
    refused (403) — bare or with an act-as sub — and no edge is written for
    anyone, not even for the mapped user."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    token = _token_of(rsa_keypair, gty="client-credentials", azp=AGENT_CLIENT,
                      sub=f"{AGENT_CLIENT}@clients")

    for headers in (_auth(token), {**_auth(token), "X-Act-As-Sub": SUB}):
        r = client.post(f"/api/users/{OTHER}/follow", headers=headers)
        assert r.status_code == 403
        r = client.delete(f"/api/users/{OTHER}/follow", headers=headers)
        assert r.status_code == 403

    assert g.following_of(SUB) == []
    assert g.followers_of(OTHER) == []


def test_follow_queries_are_parameterized_single_hop(monkeypatch) -> None:
    """followers/following reads go through one scoped Cypher query each with
    the uid bound as a parameter — never interpolated, never node-by-node."""
    import app.graph.client as client_mod

    assert "$uid" in client_mod._Q_FOLLOWERS_OF
    assert "$uid" in client_mod._Q_FOLLOWING_OF
    for q in (client_mod._Q_FOLLOWERS_OF, client_mod._Q_FOLLOWING_OF):
        assert "[*0.." not in q  # single hop — no variable-length walk
        assert "SELECT" not in q.upper()

    captured: dict = {}

    class _FakeSdk:
        def query_twins(self, query, query_parameters=None, **kwargs):
            captured.setdefault("calls", []).append((query, query_parameters))
            return iter([{"followers": ["a"], "following": ["b"]}])

    monkeypatch.setattr(client_mod, "KISEKI_GRAPH_URL", "http://graph.test")
    monkeypatch.setattr(client_mod, "KISEKI_GRAPH_TOKEN", "t")
    c = client_mod.GraphReadClient()
    c._client = _FakeSdk()  # type: ignore[attr-defined]
    monkeypatch.setattr(client_mod.GraphReadClient, "is_enabled", lambda self: True)

    assert c.followers_of("auth0|someone") == ["a"]
    assert c.following_of("auth0|someone") == ["b"]
    assert len(captured["calls"]) == 2
    for _, params in captured["calls"]:
        assert params == {"uid": "auth0|someone"}
