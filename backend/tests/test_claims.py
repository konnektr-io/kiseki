"""Crew identity claiming tests (issue #6 — placeholder → real user).

Covers the graph write ops (User twin creation + hasCrew edge transfer +
placeholder retirement), the claim service logic (edge finding, conflict and
error paths, call order), and the two claim endpoints.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import claims as claims_module
from app.auth import Auth0JWTValidator
from app.graph import client as graph_client_mod
from app.main import app

from conftest import CLIENT_ID, TENANT, _claims, _sign

SEED_DIR = Path(__file__).resolve().parent.parent / "data" / "seed"
MOCK_DIR = Path(__file__).resolve().parent.parent / "data" / "mocks"
TRIPS_DIR = Path(__file__).resolve().parent.parent / "data" / "trips"

CLAIM_TOKEN = "2ba8db3168b3cde5b0babb891a497c50"  # canada-2027 (regenerated per run)
PROFILE = {"email": "niko@example.com", "name": "Niko Raes"}


def _load_graph(slug: str) -> dict:
    p = SEED_DIR / f"{slug}.graph.json"
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads((MOCK_DIR / f"{slug}.graph.anon.json").read_text(encoding="utf-8"))


def _trip_json(slug: str) -> dict:
    p = TRIPS_DIR / slug / "trip.json"
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    # anon-derived: convert graph back to Trip then dict
    return _load_graph(slug)  # callers needing id should use _trip_id via graph $dtId


def _trip_id(slug: str) -> str:
    d = _trip_json(slug)
    # _trip_json returns a graph dict in CI (has $dtId) or a Trip dict locally (has id)
    return d.get("id") or d.get("$dtId") or d.get("$dtId", "")


def _person_id(graph: dict, name: str) -> str:
    for t in graph["twins"]:
        if t.get("name") == name:
            return t["$dtId"]
    # anon mocks redact names to Person 1/2/3 — fall back to first Person twin
    for t in graph["twins"]:
        if t.get("$metadata", {}).get("$model") == "dtmi:kiseki:travel:Person;1":
            return t["$dtId"]
    raise AssertionError(f"no person named {name}")


def _to_dict(obj) -> dict:
    for m in ("to_dict", "model_dump", "dict"):
        fn = getattr(obj, m, None)
        if callable(fn):
            return fn()
    return dict(obj)


# ------------------------------------------------------------- graph write ops


class _FakeSdk:
    """SDK stand-in recording every write call."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def upsert_digital_twin(self, dtid, twin):
        self.calls.append(("upsert_twin", dtid, _to_dict(twin)))
        return twin

    def upsert_relationship(self, src, rel_id, rel):
        self.calls.append(("upsert_rel", src, rel_id, _to_dict(rel)))
        return rel

    def delete_relationship(self, src, rel_id):
        self.calls.append(("delete_rel", src, rel_id))

    def delete_digital_twin(self, dtid):
        self.calls.append(("delete_twin", dtid))


@pytest.fixture
def sdk_client(monkeypatch: pytest.MonkeyPatch) -> graph_client_mod.GraphReadClient:
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_URL", "http://graph.test")
    monkeypatch.setattr(graph_client_mod, "KISEKI_GRAPH_TOKEN", "t")
    c = graph_client_mod.GraphReadClient()
    c._client = _FakeSdk()  # type: ignore[attr-defined]
    return c


def test_create_user_twin(sdk_client) -> None:
    assert sdk_client.create_user_twin("google-oauth2|42", PROFILE) is True
    (kind, dtid, twin) = sdk_client._client.calls[0]  # type: ignore[attr-defined]
    assert kind == "upsert_twin"
    assert dtid == "google-oauth2|42"
    assert twin["$metadata"]["$model"] == "dtmi:kiseki:travel:User;1"
    assert twin["name"] == "Niko Raes"
    assert twin["email"] == "niko@example.com"
    assert twin["authProvider"] == "google"


def test_create_user_twin_requires_email(sdk_client) -> None:
    assert sdk_client.create_user_twin("auth0|42", {"name": "No Email"}) is False
    assert sdk_client._client.calls == []  # type: ignore[attr-defined]


def test_claim_crew_person_sequence(sdk_client) -> None:
    trip, user, person = (
        _trip_id("canada-2027"),
        "google-oauth2|42",
        "11111111-2222-4333-8444-555555555555",
    )
    assert sdk_client.claim_crew_person(trip, user, person, "owner", 2) is True
    calls = sdk_client._client.calls  # type: ignore[attr-defined]
    assert [c[0] for c in calls] == ["upsert_rel", "delete_rel", "delete_twin"]
    _, src, rel_id, rel = calls[0]
    assert src == trip
    assert rel_id == f"{trip}__hasCrew__{user}"
    assert rel["$targetId"] == user
    assert rel["role"] == "owner"
    assert rel["index"] == 2
    assert calls[1][1:] == (trip, f"{trip}__hasCrew__{person}")
    assert calls[2][1:] == (person,)


def test_claim_crew_person_rejects_bad_input(sdk_client) -> None:
    trip = _trip_id("canada-2027")
    assert sdk_client.claim_crew_person("not-a-uuid", "u", "p", "owner", 0) is False
    assert sdk_client.claim_crew_person(trip, "u", "p", "superadmin", 0) is False
    assert sdk_client.claim_crew_person(trip, "u", "p", "viewer", "0") is False
    assert sdk_client.claim_crew_person(trip, "u", "p", "viewer", 0, 123) is False  # note must be str
    assert sdk_client._client.calls == []  # type: ignore[attr-defined]


def test_claim_crew_person_carries_note(sdk_client) -> None:
    """Claim transfers the trip-relative note onto the new User edge (#6)."""
    trip, user, person = (
        _trip_id("canada-2027"),
        "google-oauth2|42",
        "11111111-2222-4333-8444-555555555555",
    )
    assert sdk_client.claim_crew_person(trip, user, person, "owner", 2, "Skis — Elan Playmaker 111") is True
    _, _, _, rel = sdk_client._client.calls[0]  # type: ignore[attr-defined]
    assert rel["note"] == "Skis — Elan Playmaker 111"


def test_claim_crew_person_omits_missing_note(sdk_client) -> None:
    """No note on the placeholder edge → no note key on the User edge."""
    trip, user, person = (
        _trip_id("canada-2027"),
        "google-oauth2|42",
        "11111111-2222-4333-8444-555555555555",
    )
    assert sdk_client.claim_crew_person(trip, user, person, "owner", 2) is True
    _, _, _, rel = sdk_client._client.calls[0]  # type: ignore[attr-defined]
    assert "note" not in rel


# ------------------------------------------------------------- claim service


class _StubClient:
    """Implements the graph-client contract; fetch_graph mutates on claim."""

    def __init__(self, graph: dict, claim_dtid: str) -> None:
        self.graph = graph
        self.claim_dtid = claim_dtid
        self.created_user: str | None = None
        self.transfer: tuple | None = None
        self.followed: tuple | None = None

    def is_enabled(self) -> bool:
        return True

    def find_trip_dtid_by_claim_token(self, token: str):
        return self.claim_dtid if token == CLAIM_TOKEN else None

    def fetch_graph(self, _dtid: str) -> dict:
        return self.graph

    def create_user_twin(self, user_dtid: str, profile: dict) -> bool:
        self.created_user = user_dtid
        return True

    def role_for_user_on_trip(self, trip, user):
        for r in self.graph["relationships"]:
            if r["$relationshipName"] == "hasCrew" and r["$targetId"] == user:
                return r.get("role")
        return None

    def follow_trip(self, trip, user, profile) -> bool:
        self.followed = (trip, user)
        self.graph["twins"].append(
            {
                "$dtId": user,
                "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
                "name": "Niko Raes",
                "email": "niko@example.com",
                "displayName": "Niko Raes",
            }
        )
        used = [
            r.get("index") for r in self.graph["relationships"]
            if r["$relationshipName"] == "hasCrew" and isinstance(r.get("index"), int)
        ]
        self.graph["relationships"].append(
            {"$sourceId": trip, "$relationshipName": "hasCrew",
             "$targetId": user, "role": "follower",
             "index": max(used) + 1 if used else 0}
        )
        return True

    def claim_crew_person(self, trip, user, person, role, index, note=None) -> bool:
        self.transfer = (trip, user, person, role, index, note)
        self.graph["twins"] = [
            t for t in self.graph["twins"] if t["$dtId"] != person
        ]
        self.graph["twins"].append(
            {
                "$dtId": user,
                "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
                "name": "Niko Raes",
                "email": "niko@example.com",
                "displayName": "Niko Raes",
            }
        )
        self.graph["relationships"] = [
            r for r in self.graph["relationships"]
            if not (r["$targetId"] == person and r["$relationshipName"] == "hasCrew")
        ]
        new_edge: dict = (
            {"$sourceId": trip, "$relationshipName": "hasCrew",
             "$targetId": user, "role": role, "index": index}
        )
        if note is not None:
            new_edge["note"] = note
        self.graph["relationships"].append(new_edge)
        return True


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch) -> _StubClient:
    graph = _load_graph("canada-2027")
    s = _StubClient(graph, graph["$dtId"])
    monkeypatch.setattr(claims_module, "get_graph_client", lambda: s)
    return s


def test_claim_identity_success(stub: _StubClient) -> None:
    person = _person_id(stub.graph, "Niko Raes")
    trip = stub.graph["$dtId"]
    trip_model = claims_module.claim_identity(CLAIM_TOKEN, person, "google-oauth2|42", PROFILE)

    assert stub.created_user == "google-oauth2|42"
    trip_dtid, user, p, role, index, note = stub.transfer  # type: ignore[misc]
    assert trip_dtid == trip and user == "google-oauth2|42" and p == person
    assert role == "owner"
    assert note is None  # anon fixture crew carry no notes
    # rebuilt: the user is on the crew (placeholder gone) — names redacted in anon graph
    assert any(c.id == "google-oauth2|42" for c in trip_model.crew)
    assert len(trip_model.crew) == 3


def test_claim_identity_unknown_claim_token(stub: _StubClient) -> None:
    with pytest.raises(claims_module.ClaimError) as ei:
        claims_module.claim_identity("deadbeef", "x", "u", PROFILE)
    assert ei.value.status == 404


def test_claim_identity_person_not_found(stub: _StubClient) -> None:
    with pytest.raises(claims_module.ClaimError) as ei:
        claims_module.claim_identity(CLAIM_TOKEN, "00000000-0000-4000-8000-000000000000", "u", PROFILE)
    assert ei.value.status == 404


def test_claim_identity_person_already_claimed(stub: _StubClient) -> None:
    person = _person_id(stub.graph, "Niko Raes")
    stub.graph["relationships"] = [
        r for r in stub.graph["relationships"]
        if not (r["$targetId"] == person and r["$relationshipName"] == "hasCrew")
    ]
    with pytest.raises(claims_module.ClaimError) as ei:
        claims_module.claim_identity(CLAIM_TOKEN, person, "google-oauth2|42", PROFILE)
    assert ei.value.status == 409
    assert stub.transfer is None


def test_claim_identity_already_crew(stub: _StubClient) -> None:
    person = _person_id(stub.graph, "Nick Geelen")
    stub.graph["relationships"].append(
        {"$sourceId": stub.graph["$dtId"], "$relationshipName": "hasCrew",
         "$targetId": "google-oauth2|42", "role": "viewer", "index": 9}
    )
    with pytest.raises(claims_module.ClaimError) as ei:
        claims_module.claim_identity(CLAIM_TOKEN, person, "google-oauth2|42", PROFILE)
    assert ei.value.status == 409


def test_claim_identity_graph_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claims_module, "get_graph_client", lambda: None)
    with pytest.raises(claims_module.ClaimError) as ei:
        claims_module.claim_identity(CLAIM_TOKEN, "p", "u", PROFILE)
    assert ei.value.status == 503


# ------------------------------------------------------------- endpoints


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


def _real_trip():
    from app.models import Trip
    p = TRIPS_DIR / "canada-2027" / "trip.json"
    if p.is_file():
        return Trip.model_validate_json(p.read_text(encoding="utf-8"))
    from app.graph.convert import graph_to_trip
    return graph_to_trip(_load_graph("canada-2027"))


def test_by_claim_serves_trip(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.main import trip_by_claim_token as _bound  # noqa: F401  (main holds the ref)
    real = _real_trip()
    # main.py imports the function by name — patch the BOUND reference there.
    monkeypatch.setattr("app.main.trip_by_claim_token", lambda t: real)
    r = client.get(f"/api/trips/by-claim/{CLAIM_TOKEN}")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "canada-2027"
    # anon mocks redact names to Person 1 — accept either
    assert any(c["name"] in ("Niko Raes", "Person 1", "Person 2", "Person 3") for c in body["crew"])
    assert "claimToken" not in body  # the claim secret never ships in documents


def test_by_claim_unknown_link(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.main.trip_by_claim_token", lambda t: None)
    r = client.get("/api/trips/by-claim/beefbeefbeefbeefbeefbeefbeefbeef")
    assert r.status_code == 404


def test_claim_requires_token(client: TestClient) -> None:
    r = client.post("/api/claims", json={"claimToken": CLAIM_TOKEN, "personId": "x"})
    assert r.status_code == 401


def test_claim_ok(client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch) -> None:
    real = _real_trip()
    monkeypatch.setattr(
        "app.main.claim_identity",
        lambda token, person, sub, profile: real,
    )
    token = _sign(rsa_keypair, _claims())
    r = client.post(
        "/api/claims",
        json={"claimToken": CLAIM_TOKEN, "personId": "whatever"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert r.json()["slug"] == "canada-2027"


def test_claim_conflict_maps_to_409(client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a, **_k):
        raise claims_module.ClaimError(409, "already claimed")

    monkeypatch.setattr("app.main.claim_identity", boom)
    token = _sign(rsa_keypair, _claims())
    r = client.post(
        "/api/claims",
        json={"claimToken": CLAIM_TOKEN, "personId": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 409


# ----------------------------------------------------------- follow (#65)
#
# A non-crew user follows a trip with the same claimToken the join link
# carries: invite-only on a private trip, optional on a public one. These are
# the two rules the issue is actually about — that following grants the LOWEST
# read role, and that doing it twice is not an error.


def test_follow_via_claim_creates_follower_edge(stub: _StubClient) -> None:
    trip = stub.graph["$dtId"]
    trip_model = claims_module.follow_via_claim(CLAIM_TOKEN, "google-oauth2|77", PROFILE)

    assert stub.followed == (trip, "google-oauth2|77")
    me = [c for c in trip_model.crew if c.id == "google-oauth2|77"]
    assert len(me) == 1
    assert me[0].role == "follower"  # never more than follower via a follow


def test_follow_via_claim_is_idempotent_for_existing_crew(stub: _StubClient) -> None:
    """Already on the crew → return the trip, don't add a second edge and
    don't quietly demote an owner to follower."""
    person = _person_id(stub.graph, "Niko Raes")
    claims_module.claim_identity(CLAIM_TOKEN, person, "google-oauth2|42", PROFILE)
    before = len(stub.graph["relationships"])

    trip_model = claims_module.follow_via_claim(CLAIM_TOKEN, "google-oauth2|42", PROFILE)

    assert stub.followed is None  # no write attempted
    assert len(stub.graph["relationships"]) == before
    me = [c for c in trip_model.crew if c.id == "google-oauth2|42"]
    assert me and me[0].role == "owner"  # role preserved, not overwritten


def test_follow_via_claim_unknown_link(stub: _StubClient) -> None:
    with pytest.raises(claims_module.ClaimError) as exc:
        claims_module.follow_via_claim("deadbeef" * 4, "google-oauth2|77", PROFILE)
    assert exc.value.status == 404
    assert stub.followed is None


def test_follow_trip_index_is_max_plus_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """The crew index must not be derived from a COUNT: a claim deletes the
    placeholder's edge, so a count collides with an index still in use."""
    import konnektr_graph

    from app.graph import client as client_mod

    trip = "11111111-1111-4111-8111-111111111111"
    monkeypatch.setattr(konnektr_graph.BasicRelationship, "from_dict", staticmethod(lambda d: d))
    monkeypatch.setattr(client_mod.GraphReadClient, "is_enabled", lambda self: True)
    monkeypatch.setattr(client_mod.GraphReadClient, "create_user_twin", lambda self, u, p: True)
    monkeypatch.setattr(client_mod.GraphReadClient, "role_for_user_on_trip", lambda self, t, u: None)
    # Crew holding indexes 0 and 2 — whatever held 1 was claimed away.
    monkeypatch.setattr(
        client_mod.GraphReadClient,
        "fetch_graph",
        lambda self, d: {
            "relationships": [
                {"$sourceId": trip, "$relationshipName": "hasCrew", "$targetId": "a", "index": 0},
                {"$sourceId": trip, "$relationshipName": "hasCrew", "$targetId": "b", "index": 2},
            ]
        },
    )
    recorded: dict = {}

    class _SDK:
        def upsert_relationship(self, src, rel_id, rel):
            recorded["rel"] = rel

    c = client_mod.GraphReadClient()
    c._client = _SDK()

    assert c.follow_trip(trip, "google-oauth2|9", PROFILE) is True
    assert recorded["rel"]["index"] == 3  # max+1, not the count (2)
    assert recorded["rel"]["role"] == "follower"


def test_crew_write_invalidates_only_its_own_keys() -> None:
    """A follow must retire the cached reads it changed — the pre-write graph,
    the memoized 'no role' miss and the user's trip list — WITHOUT dropping
    every other trip's cached document."""
    from app.graph import client as client_mod

    trip, other, user = "trip-a", "trip-b", "google-oauth2|9"
    client_mod._clear_graph_cache()
    forever = 9e9
    client_mod._GRAPH_CACHE.update(
        {
            ("fetch_graph", (trip,), ()): (forever, "stale trip"),
            ("role_for_user_on_trip", (trip, user), ()): (forever, None),
            ("list_trips_for_user", (user,), ()): (forever, []),
            ("fetch_graph", (other,), ()): (forever, "other trip"),
            ("find_trip_dtid_by_claim_token", ("tok",), ()): (forever, trip),
        }
    )

    client_mod._invalidate_graph_cache(trip_dtid=trip, user_dtid=user)

    assert ("fetch_graph", (trip,), ()) not in client_mod._GRAPH_CACHE
    assert ("role_for_user_on_trip", (trip, user), ()) not in client_mod._GRAPH_CACHE
    assert ("list_trips_for_user", (user,), ()) not in client_mod._GRAPH_CACHE
    # Untouched: a different trip, and a lookup a crew write cannot change.
    assert ("fetch_graph", (other,), ()) in client_mod._GRAPH_CACHE
    assert ("find_trip_dtid_by_claim_token", ("tok",), ()) in client_mod._GRAPH_CACHE


def test_follow_requires_token(client: TestClient) -> None:
    r = client.post("/api/claims/follow", json={"claimToken": CLAIM_TOKEN})
    assert r.status_code == 401


def test_follow_ok(client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch) -> None:
    real = _real_trip()
    monkeypatch.setattr("app.main.follow_via_claim", lambda token, sub, profile: real)
    token = _sign(rsa_keypair, _claims())
    r = client.post(
        "/api/claims/follow",
        json={"claimToken": CLAIM_TOKEN},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert r.json()["slug"] == "canada-2027"
    assert "claimToken" not in r.json()  # the invite secret never comes back


def test_follow_unknown_link_maps_to_404(
    client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a, **_k):
        raise claims_module.ClaimError(404, "Unknown join link")

    monkeypatch.setattr("app.main.follow_via_claim", boom)
    token = _sign(rsa_keypair, _claims())
    r = client.post(
        "/api/claims/follow",
        json={"claimToken": CLAIM_TOKEN},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 404
