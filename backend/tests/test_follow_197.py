"""Follow model (issue #197): follow a public trip with no invite, and the
separate follow link — read + follow, never a claim.

The three behaviours this file pins down:

1. ``visibility: public`` IS the invitation. A public trip is followed by id
   with no link at all; a private trip still answers 403 (never a silent
   grant), so "no link needed" can't leak a private trip.
2. ``followToken`` is a SECOND credential beside ``claimToken``. It is minted
   and revoked independently, rotating it kills only the previous follow
   link (the token cache is retired by value), and it can never claim a crew
   identity — structurally, because the claim path reads ``claimToken`` only.
3. Crew-only fields are a registry (``CREW_ONLY_FIELDS``), applied to
   followers as well as anonymous callers. The walk below is the point: a new
   crew-only field left out of the registry is a leak this file cannot see,
   which is why the assertions iterate the registry instead of naming
   ``tricount``.
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
from app.graph import client as client_mod
from app.main import CREW_ONLY_FIELDS, _drop_path, app
from app.ratelimit import reset as reset_rate_limits

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph

SUB = "google-oauth2|1234567890"
STRANGER = "auth0|stranger-0000000009"
AGENT_CLIENT = "cyKpzLkq8J5LMFPfWYOioG8VzYsMgm8U"
PROFILE = {"email": "niko@example.com", "name": "Niko Raes"}
FOLLOW_TOKEN = "f0110w" * 5 + "abcd"
CLAIM_TOKEN = "REDACTED"  # what the anon fixture's Trip twin carries
SEQ_ACT_AS = "google-oauth2|9999999999"


def _token_of(rsa_keypair, **overrides: object) -> str:
    return _sign(rsa_keypair, _claims(**overrides))


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


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
    """Stage a FakeGraph as BOTH the store's and the claims' client."""
    made: list[FakeGraph] = []

    def _make(role: str = "owner", fixture: str = "canada-2027.graph.anon.json",
              sub: str = SUB, visibility: str = "public") -> FakeGraph:
        g = FakeGraph(fixture)
        g.add_user_role(g.root, sub, role)
        g.set_twin_prop(g.root, "visibility", visibility)
        monkeypatch.setattr(store_mod, "_graph_client", lambda: g)
        monkeypatch.setattr(claims_module, "get_graph_client", lambda: g)
        made.append(g)
        return g

    yield _make
    for _ in made:
        store_mod._reset_store_cache()


def _trip_of(g: FakeGraph):
    return graph_to_trip(g.fetch_graph(g.root))


def _stranger(g: FakeGraph, sub: str = STRANGER) -> None:
    """Make ``sub`` a real, signed-in user who is NOT crew on the trip."""
    g.rels = [r for r in g.rels if r.get("$targetId") != sub]
    g.twins = [t for t in g.twins if t.get("$dtId") != sub]
    assert g.create_user_twin(sub, {"email": "fan@example.com", "name": "Fan"})


# ------------------------------------------- 1. follow a public trip, no link

def test_public_trip_is_followed_by_id_with_no_invite(client, rsa_keypair, graph) -> None:
    """A logged-in stranger follows a public trip with no token at all."""
    g = graph(role="owner", visibility="public")
    trip = _trip_of(g)
    _stranger(g)
    token = _token_of(rsa_keypair, sub=STRANGER)

    assert g.role_for_user_on_trip(g.root, STRANGER) is None
    r = client.post(f"/api/trips/{trip.id}/follow", headers=_auth(token))
    assert r.status_code == 200, r.text
    assert r.json()["myRole"] == "follower"
    assert g.role_for_user_on_trip(g.root, STRANGER) == "follower"

    # Idempotent: a second follow adds no second edge and does not demote.
    before = len(g.rels)
    r = client.post(f"/api/trips/{trip.id}/follow", headers=_auth(token))
    assert r.status_code == 200
    assert len(g.rels) == before


def test_private_trip_refuses_follow_without_a_link(client, rsa_keypair, graph) -> None:
    """No link + private = 403 telling the caller to get an invite. Never a
    silent grant, and never an edge."""
    g = graph(role="owner", visibility="private")
    trip = _trip_of(g)
    _stranger(g)
    token = _token_of(rsa_keypair, sub=STRANGER)

    r = client.post(f"/api/trips/{trip.id}/follow", headers=_auth(token))
    assert r.status_code == 403
    assert "invite" in r.json()["detail"].lower()
    assert g.role_for_user_on_trip(g.root, STRANGER) is None


def test_follow_by_id_needs_a_real_end_user_token(client, rsa_keypair, graph) -> None:
    """Following provisions a graph edge for the caller, so it obeys the
    claim/follow rule: anonymous 401, M2M 403 (act-as included)."""
    g = graph(role="owner", visibility="public")
    trip = _trip_of(g)
    _stranger(g)

    assert client.post(f"/api/trips/{trip.id}/follow").status_code == 401

    plain_m2m = _token_of(rsa_keypair, gty="client-credentials", azp="m2m-client")
    assert client.post(f"/api/trips/{trip.id}/follow", headers=_auth(plain_m2m)).status_code == 403

    agent = _token_of(rsa_keypair, gty="client-credentials", azp=AGENT_CLIENT,
                      sub=f"{AGENT_CLIENT}@clients")
    monkey = pytest.MonkeyPatch()
    monkey.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    try:
        for headers in (_auth(agent), {**_auth(agent), "X-Act-As-Sub": SEQ_ACT_AS}):
            assert client.post(f"/api/trips/{trip.id}/follow", headers=headers).status_code == 403
    finally:
        monkey.undo()
    assert g.role_for_user_on_trip(g.root, STRANGER) is None


def test_follow_by_id_unknown_trip_is_404(client, rsa_keypair, graph) -> None:
    graph(role="owner", visibility="public")
    token = _token_of(rsa_keypair)
    r = client.post("/api/trips/00000000-0000-0000-0000-000000000000/follow",
                    headers=_auth(token))
    assert r.status_code == 404


# ------------------------------------------------------- 2. the follow link

def test_follow_link_is_owner_only_and_rotatable(client, rsa_keypair, graph) -> None:
    """Minted by the owner, readable by the owner, 403 for everyone else —
    and minting twice rotates (the returned link changes)."""
    g = graph(role="owner", visibility="private")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)

    # Never minted yet → nothing to hand out.
    r = client.get(f"/api/trips/{trip.id}/follow-link", headers=_auth(owner_tok))
    assert r.status_code == 404

    r = client.post(f"/api/trips/{trip.id}/follow-link", headers=_auth(owner_tok))
    assert r.status_code == 201, r.text
    first = r.json()["followUrl"]
    assert r.json()["linkKind"] == "follow"
    assert first.startswith("/join/")
    assert g.twin(g.root)["followToken"] == first.rsplit("/", 1)[1]
    # ... and the claim token is untouched by a follow-link mint.
    assert g.twin(g.root)["claimToken"] == CLAIM_TOKEN

    r = client.get(f"/api/trips/{trip.id}/follow-link", headers=_auth(owner_tok))
    assert r.status_code == 200
    assert r.json()["followUrl"] == first

    editor = "auth0|editor-0000000002"
    g.add_user_role(g.root, editor, "editor")
    editor_tok = _token_of(rsa_keypair, sub=editor)
    assert client.get(f"/api/trips/{trip.id}/follow-link", headers=_auth(editor_tok)).status_code == 403
    assert client.post(f"/api/trips/{trip.id}/follow-link", headers=_auth(editor_tok)).status_code == 403
    assert client.delete(f"/api/trips/{trip.id}/join-link", headers=_auth(editor_tok)).status_code == 403
    # Anonymous never even reaches the link.
    assert client.post(f"/api/trips/{trip.id}/follow-link").status_code == 401

    r = client.post(f"/api/trips/{trip.id}/follow-link", headers=_auth(owner_tok))
    assert r.status_code == 201
    assert r.json()["followUrl"] != first  # rotating revokes the old link
    assert g.twin(g.root)["followToken"] != first.rsplit("/", 1)[1]


def test_follow_link_follows_but_never_claims(client, rsa_keypair, graph) -> None:
    """The follow link grants read+follow on a PRIVATE trip — and the same
    secret is useless as a claim credential (404), because claiming resolves
    ``claimToken`` only."""
    g = graph(role="owner", visibility="private")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)
    link = client.post(f"/api/trips/{trip.id}/follow-link",
                       headers=_auth(owner_tok)).json()["followUrl"]
    follow_token = link.rsplit("/", 1)[1]

    _stranger(g)
    stranger_tok = _token_of(rsa_keypair, sub=STRANGER)

    # The follow link resolves to the trip (linkKind tells the SPA not to offer claiming).
    r = client.get(f"/api/trips/by-follow/{follow_token}")
    assert r.status_code == 200, r.text
    assert r.json()["linkKind"] == "follow"
    assert r.json()["slug"] == _trip_of(g).slug

    # A stranger can follow through it...
    r = client.post("/api/claims/follow", headers=_auth(stranger_tok),
                    json={"followToken": follow_token})
    assert r.status_code == 200, r.text
    assert g.role_for_user_on_trip(g.root, STRANGER) == "follower"

    # ... and the SAME secret cannot claim: claiming reads claimToken only.
    with pytest.raises(claims_module.ClaimError) as exc:
        claims_module.claim_identity(follow_token, follow_token, STRANGER, PROFILE)
    assert exc.value.status == 404


def test_follow_token_lookup_is_separate_and_parameterized(monkeypatch) -> None:
    """Two distinct lookups, each binding its secret as a parameter."""
    assert "$followToken" in client_mod._Q_FIND_TRIP_BY_FOLLOW
    assert "$claimToken" in client_mod._Q_FIND_TRIP_BY_CLAIM
    assert "$followToken" not in client_mod._Q_FIND_TRIP_BY_CLAIM

    captured: dict = {}

    class _FakeSdk:
        def query_twins(self, query, query_parameters=None, **kwargs):
            captured["q"] = query
            captured["params"] = query_parameters
            hit = {"trip": {"$dtId": "t",
                            "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"}}}
            return iter([hit] if query == client_mod._Q_FIND_TRIP_BY_FOLLOW else [])

    monkeypatch.setattr(client_mod, "KISEKI_GRAPH_URL", "http://graph.test")
    monkeypatch.setattr(client_mod, "KISEKI_GRAPH_TOKEN", "t")
    c = client_mod.GraphReadClient()
    c._client = _FakeSdk()  # type: ignore[attr-defined]
    monkeypatch.setattr(client_mod.GraphReadClient, "is_enabled", lambda self: True)

    assert c.find_trip_dtid_by_follow_token("tok") == "t"
    assert captured["params"] == {"followToken": "tok"}
    # A secret that isn't shaped like a token is never even queried.
    captured.clear()
    assert c.find_trip_dtid_by_follow_token("not a token!") is None
    assert captured == {}


def test_token_cache_retires_by_value_not_wholesale() -> None:
    """Rotating one follow link retires that link's lookup — and leaves other
    tokens' lookups (and other reads) alone."""
    client_mod._clear_graph_cache()
    forever = 9e9
    client_mod._GRAPH_CACHE.update({
        ("find_trip_dtid_by_follow_token", ("old-tok",), ()): (forever, "trip-a"),
        ("find_trip_dtid_by_follow_token", ("keep-tok",), ()): (forever, "trip-b"),
        ("find_trip_dtid_by_claim_token", ("claim-tok",), ()): (forever, "trip-c"),
        ("fetch_graph", ("trip-a",), ()): (forever, "doc"),
    })

    client_mod._invalidate_graph_cache(trip_dtid="trip-a", token="old-tok")

    assert ("find_trip_dtid_by_follow_token", ("old-tok",), ()) not in client_mod._GRAPH_CACHE
    assert ("find_trip_dtid_by_follow_token", ("keep-tok",), ()) in client_mod._GRAPH_CACHE
    assert ("find_trip_dtid_by_claim_token", ("claim-tok",), ()) in client_mod._GRAPH_CACHE
    assert ("fetch_graph", ("trip-a",), ()) not in client_mod._GRAPH_CACHE
    client_mod._clear_graph_cache()


def test_disable_crew_invite_keeps_the_follow_link(client, rsa_keypair, graph) -> None:
    """Revoking the crew invite kills claiming (and the join link) without
    touching followers or the follow link — the two links are separately
    revocable, which is the whole point of #197."""
    g = graph(role="owner", visibility="public")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)
    client.post(f"/api/trips/{trip.id}/follow-link", headers=_auth(owner_tok))
    follow_token = g.twin(g.root)["followToken"]

    r = client.delete(f"/api/trips/{trip.id}/join-link", headers=_auth(owner_tok))
    assert r.status_code == 204
    assert g.twin(g.root).get("claimToken") is None  # invite disabled
    assert g.twin(g.root)["followToken"] == follow_token  # follow link alive
    assert g.role_for_user_on_trip(g.root, SUB) == "owner"  # crew untouched

    # The follow link still resolves and still follows.
    assert client.get(f"/api/trips/by-follow/{follow_token}").status_code == 200
    _stranger(g)
    r = client.post("/api/claims/follow", headers=_auth(_token_of(rsa_keypair, sub=STRANGER)),
                    json={"followToken": follow_token})
    assert r.status_code == 200
    # The dead join link is dead.
    r = client.post("/api/claims/follow", headers=_auth(_token_of(rsa_keypair, sub=STRANGER)),
                    json={"claimToken": CLAIM_TOKEN})
    assert r.status_code == 404


# --------------------------------------------- 3. secrets and crew-only fields

def test_follow_body_needs_exactly_one_credential(client, rsa_keypair, graph) -> None:
    """The join link and the follow link are never interchangeable: the caller
    must say which one it holds, and two is as wrong as none."""
    graph(role="owner")
    token = _token_of(rsa_keypair)
    for body in ({}, {"claimToken": CLAIM_TOKEN, "followToken": FOLLOW_TOKEN}):
        r = client.post("/api/claims/follow", headers=_auth(token), json=body)
        assert r.status_code == 400, r.text


def test_trip_documents_never_carry_a_link_secret(client, rsa_keypair, graph) -> None:
    """Both secrets are write-only: they leave only through their own
    owner-gated endpoints, never inside a trip document."""
    g = graph(role="owner", visibility="public")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)
    client.post(f"/api/trips/{trip.id}/follow-link", headers=_auth(owner_tok))

    body = client.get(f"/api/trips/{trip.id}", headers=_auth(owner_tok)).json()
    assert "claimToken" not in body and "followToken" not in body

    link = g.twin(g.root)["followToken"]
    stranger_body = client.get(f"/api/trips/by-follow/{link}").json()
    assert "claimToken" not in stranger_body and "followToken" not in stranger_body


def test_every_registered_crew_only_field_is_hidden_from_a_follower(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The registry walk: for EVERY path in CREW_ONLY_FIELDS, the crew sees it
    and both a follower and an anonymous caller do not. Registering a new
    crew-only field is therefore enough to cover it; forgetting to register
    one is what this test cannot see — hence the check below that the fixture
    actually exercises at least one registered path."""
    assert CREW_ONLY_FIELDS, "the registry must not be empty"

    g = graph(role="owner", visibility="public")
    trip = _trip_of(g)
    # Give the trip a real crew-only payload: without one the walk below would
    # be vacuous (nothing to leak), which is exactly the trap a registry
    # exists to avoid.
    g.set_twin_prop(g.root, "practical",
                    {"tricount": {"registryKey": "abc123",
                                  "url": "https://tricount.example/x"},
                     "todos": [{"label": "Pay the balance for the lodge",
                                "done": False}]})
    owner_tok = _token_of(rsa_keypair)
    client.post(f"/api/trips/{trip.id}/follow-link", headers=_auth(owner_tok))
    link = g.twin(g.root)["followToken"]
    _stranger(g)
    follower_tok = _token_of(rsa_keypair, sub=STRANGER)
    assert client.post("/api/claims/follow", headers=_auth(follower_tok),
                       json={"followToken": link}).status_code == 200

    crew_doc = client.get(f"/api/trips/{trip.id}", headers=_auth(owner_tok)).json()
    anon_doc = client.get(f"/api/trips/by-follow/{link}").json()
    follower_doc = client.get(f"/api/trips/{trip.id}", headers=_auth(follower_tok)).json()

    exercised = 0
    for path in CREW_ONLY_FIELDS:
        # The probe is BUILT from the path. A hardcoded one (`{"practical":
        # {"tricount": …}}`) stops exercising the registry the moment a second
        # path is registered: the drop matches a key the probe never had, the
        # count assertion below still passes, and the walk silently proves
        # nothing. Adding ("practical", "todos") turned this test red for exactly
        # that reason — the fixture was the bug, not the code.
        probe: dict = {}
        cursor = probe
        for step in path[:-1]:
            cursor = cursor.setdefault(step, {})
        cursor[path[-1]] = {"url": "https://tricount.example/x"}
        _drop_path(probe, path)
        leaf: object = probe
        for step in path:
            leaf = leaf.get(step) if isinstance(leaf, dict) else None
        assert leaf is None, f"_drop_path did not drop {'.'.join(path)}"
        exercised += 1

        # Both directions, per path: the crew MUST still carry it (or the walk is
        # vacuous) and neither outsider may.
        for doc_name, doc, must_have in (
            ("crew", crew_doc, True),
            ("anon", anon_doc, False),
            ("follower", follower_doc, False),
        ):
            found: object = doc
            for step in path:
                found = found.get(step) if isinstance(found, dict) else None
            if must_have:
                assert found is not None, (
                    f"the crew response lost {'.'.join(path)} — the fixture does not "
                    "carry it, so the absent-checks above prove nothing"
                )
            else:
                assert found is None, f"{doc_name} response leaked {'.'.join(path)}"
    assert exercised == len(CREW_ONLY_FIELDS), "the drop helper must handle every registered path"
