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
from app.graph.convert import crew_edge_name
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
    """SDK stand-in recording every write call.

    ``rows`` is what ``query_twins`` answers with (the read methods parse the
    first row), so a query-backed read can be tested without a graph.
    """

    def __init__(self, rows: list | None = None) -> None:
        self.calls: list[tuple] = []
        self.rows: list = rows or []

    def query_twins(self, query, query_parameters=None):
        self.calls.append(("query", query, query_parameters))
        return self.rows

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


# ------------------------------------------- shared placeholders (#322)
# A placeholder is a real twin, so one person added to several trips before
# signing in is ONE Person with one hasCrew edge per trip — not one orphan
# twin per trip. These cover the two reads/writes that model requires.

TRIP_A = "aaaaaaaa-1111-4111-8111-111111111111"
TRIP_B = "bbbbbbbb-2222-4222-8222-222222222222"
TRIP_C = "cccccccc-3333-4333-8333-333333333333"
CLAIM_USER = "google-oauth2|42"
CLAIM_PERSON = "11111111-2222-4333-8444-555555555555"


def _crew_edge(trip: str, role: str = "owner", index: int = 0) -> dict:
    return {"tripId": trip, "role": role, "index": index, "note": None, "displayName": None}


def test_crew_edges_for_person_parses_every_trip(sdk_client) -> None:
    """The read behind the cascade: flat rows, one per trip, junk dropped."""
    sdk_client._client.rows = [{"edges": [  # type: ignore[attr-defined]
        [TRIP_A, "owner", 2, "Skis", "Nick", "dtmi:kiseki:travel:Person;1"],
        [TRIP_B, "viewer", 0, None, None, "dtmi:kiseki:travel:Person;1"],
        ["", "viewer", 0, None, None, ""],      # no trip id -> dropped
        "nonsense",                              # not a row -> dropped
    ]}]
    edges = sdk_client.crew_edges_for_person(CLAIM_PERSON)
    assert [e["tripId"] for e in edges] == [TRIP_A, TRIP_B]
    assert edges[0] == {
        "tripId": TRIP_A, "role": "owner", "index": 2, "note": "Skis",
        "displayName": "Nick", "personModel": "dtmi:kiseki:travel:Person;1",
    }
    assert edges[1]["note"] is None and edges[1]["displayName"] is None


def test_crew_edges_for_person_drops_an_opaque_id_label(sdk_client) -> None:
    """#213 at the source: an edge whose displayName IS the person's own id
    carries no name, so the cascade cannot promote an auth sub to a crew name."""
    sdk_client._client.rows = [{"edges": [  # type: ignore[attr-defined]
        [TRIP_A, "owner", 0, None, CLAIM_PERSON, "dtmi:kiseki:travel:Person;1"],
    ]}]
    assert sdk_client.crew_edges_for_person(CLAIM_PERSON)[0]["displayName"] is None


def test_crew_edges_for_person_empty_without_a_graph(sdk_client, monkeypatch) -> None:
    """A malformed id short-circuits BEFORE the query — never a graph call."""
    assert sdk_client.crew_edges_for_person("not-a-uuid") == []
    assert sdk_client.crew_edges_for_person("") == []
    assert sdk_client._client.calls == []  # type: ignore[attr-defined]


def test_crew_edges_for_person_survives_a_graph_error(sdk_client, monkeypatch) -> None:
    """A failing read is an empty list, not an exception: the caller then
    refuses the claim (503) instead of half-performing it."""
    def _boom(*_a, **_k):
        raise RuntimeError("graph down")

    monkeypatch.setattr(sdk_client._client, "query_twins", _boom)  # type: ignore[attr-defined]
    assert sdk_client.crew_edges_for_person(CLAIM_PERSON) == []


def test_placeholders_for_owner_parses_rows(sdk_client) -> None:
    """The picker's read: one row per (person, trip) edge, so the same
    placeholder on three trips comes back three times — grouped by the caller."""
    sdk_client._client.rows = [{"placeholders": [  # type: ignore[attr-defined]
        [CLAIM_PERSON, "Nick", "dtmi:kiseki:travel:Person;1", TRIP_A, "Iceland 2026",
         "viewer", 1, "Nicholas"],
        "junk",
    ]}]
    assert sdk_client.placeholders_for_owner("google-oauth2|322-picker") == [{
        "personId": CLAIM_PERSON, "name": "Nick",
        "personModel": "dtmi:kiseki:travel:Person;1", "tripId": TRIP_A,
        "tripTitle": "Iceland 2026", "role": "viewer", "index": 1,
        "displayName": "Nicholas",
    }]


def test_claim_cascade_moves_every_trip_then_retires_the_placeholder(sdk_client, monkeypatch) -> None:
    """#322: claiming a shared placeholder transfers EVERY trip's edge — each
    keeping its own role/index — and deletes the placeholder LAST, because the
    graph refuses deleting a vertex that still has edges."""
    monkeypatch.setattr(sdk_client, "role_for_user_on_trip", lambda trip, user: None)

    result = sdk_client.claim_crew_person_cascade(
        CLAIM_USER, CLAIM_PERSON,
        [_crew_edge(t, "viewer", i) for i, t in enumerate([TRIP_A, TRIP_B, TRIP_C])],
    )

    assert result == {"transferred": 3, "alreadyCrew": 0}
    calls = sdk_client._client.calls  # type: ignore[attr-defined]
    assert [c[0] for c in calls] == [
        "upsert_rel", "delete_rel", "upsert_rel", "delete_rel", "upsert_rel",
        "delete_rel", "delete_twin",
    ]
    assert calls[-1][1:] == (CLAIM_PERSON,)  # placeholder last, exactly once
    for i, trip in enumerate([TRIP_A, TRIP_B, TRIP_C]):
        _, src, rel_id, rel = calls[i * 2]
        assert src == trip and rel_id == f"{trip}__hasCrew__{CLAIM_USER}"
        assert rel["role"] == "viewer" and rel["index"] == i
        assert calls[i * 2 + 1][1:] == (trip, f"{trip}__hasCrew__{CLAIM_PERSON}")


def test_claim_cascade_never_overwrites_a_role_they_already_have(sdk_client, monkeypatch) -> None:
    """A trip where they ALREADY hold a role keeps that edge (the claim neither
    widens nor downgrades it) and only loses the placeholder's duplicate row —
    one human must not render twice on a crew list."""
    roles = {TRIP_A: None, TRIP_B: "owner"}
    monkeypatch.setattr(sdk_client, "role_for_user_on_trip", lambda trip, user: roles.get(trip))

    result = sdk_client.claim_crew_person_cascade(
        CLAIM_USER, CLAIM_PERSON, [_crew_edge(TRIP_A), _crew_edge(TRIP_B)]
    )

    assert result == {"transferred": 1, "alreadyCrew": 1}
    calls = sdk_client._client.calls  # type: ignore[attr-defined]
    assert [c[0] for c in calls] == ["upsert_rel", "delete_rel", "delete_rel", "delete_twin"]
    assert calls[0][1] == TRIP_A  # the role-less trip was the only write
    assert calls[1][1:] == (TRIP_A, f"{TRIP_A}__hasCrew__{CLAIM_PERSON}")
    assert calls[2][1:] == (TRIP_B, f"{TRIP_B}__hasCrew__{CLAIM_PERSON}")


def test_claim_cascade_coerces_a_corrupt_edge(sdk_client, monkeypatch) -> None:
    """Defensive on the way in: a row whose role/index did not survive storage
    still yields the LEAST privilege (viewer, index 0) instead of a dropped
    trip — silently losing a crew row is worse than a demoted one."""
    monkeypatch.setattr(sdk_client, "role_for_user_on_trip", lambda trip, user: None)

    assert sdk_client.claim_crew_person_cascade(
        CLAIM_USER, CLAIM_PERSON,
        [{"tripId": TRIP_A, "role": "superadmin", "index": "3"}],
    ) == {"transferred": 1, "alreadyCrew": 0}
    _, _, _, rel = sdk_client._client.calls[0]  # type: ignore[attr-defined]
    assert rel["role"] == "viewer" and rel["index"] == 0


def test_claim_cascade_rejects_bad_input(sdk_client) -> None:
    """Same input contract as the single-trip form: an empty edge list or a
    malformed id is refused outright (no writes), never a silent no-op claim."""
    assert sdk_client.claim_crew_person_cascade(CLAIM_USER, CLAIM_PERSON, []) is None
    assert sdk_client.claim_crew_person_cascade("bad'sub", CLAIM_PERSON,
                                                [_crew_edge(TRIP_A)]) is None
    assert sdk_client.claim_crew_person_cascade(CLAIM_USER, "not-a-uuid",
                                                [_crew_edge(TRIP_A)]) is None
    assert sdk_client._client.calls == []  # type: ignore[attr-defined]


# ------------------------------------------------------------- claim service


class _StubClient:
    """Implements the graph-client contract; fetch_graph mutates on claim."""

    def __init__(self, graph: dict, claim_dtid: str) -> None:
        self.graph = graph
        self.claim_dtid = claim_dtid
        self.created_user: str | None = None
        # One entry per transferred edge: (trip, user, person, role, index,
        # note, displayName). #322 made the claim a CASCADE, so a claim can
        # move several edges — a list, not the single tuple it used to be.
        self.transfers: list[tuple] = []
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
            if (r["$relationshipName"] == "hasCrew" and r["$targetId"] == user
                    and r["$sourceId"] == trip):
                return r.get("role")
        return None

    def crew_edges_for_person(self, person_dtid: str) -> list[dict]:
        """Every hasCrew edge at this person — the cascade's input (#322).

        ``displayName`` goes through ``crew_edge_name`` exactly as the live
        client's read does, so the cascade is never handed an opaque id to
        carry over as a crew name (#213).
        """
        return [
            {
                "tripId": r["$sourceId"],
                "role": r.get("role", "viewer"),
                "index": r.get("index", 0),
                "note": r.get("note"),
                "displayName": crew_edge_name(r, person_dtid),
                "personModel": next(
                    (t.get("$metadata", {}).get("$model", "")
                     for t in self.graph["twins"] if t["$dtId"] == r["$targetId"]),
                    "",
                ),
            }
            for r in self.graph["relationships"]
            if r["$relationshipName"] == "hasCrew" and r["$targetId"] == person_dtid
        ]

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

    def claim_crew_person_cascade(self, user, person, edges) -> dict | None:
        """Mirror the client's cascade (#322): every edge moves, then the
        placeholder twin is retired. A trip where the user ALREADY has a role
        keeps that edge and only loses the placeholder's duplicate row."""
        if not edges:
            return None
        transferred = 0
        already_crew = 0
        for edge in edges:
            trip = edge["tripId"]
            if self.role_for_user_on_trip(trip, user) is None:
                new_edge: dict = {
                    "$sourceId": trip, "$relationshipName": "hasCrew",
                    "$targetId": user, "role": edge.get("role") or "viewer",
                    "index": edge.get("index") if isinstance(edge.get("index"), int) else 0,
                }
                if isinstance(edge.get("note"), str):
                    new_edge["note"] = edge["note"]
                if isinstance(edge.get("displayName"), str):
                    new_edge["displayName"] = edge["displayName"]
                self.graph["relationships"].append(new_edge)
                self.transfers.append((
                    trip, user, person, new_edge["role"], new_edge["index"],
                    edge.get("note"), edge.get("displayName"),
                ))
                transferred += 1
            else:
                already_crew += 1
            self.graph["relationships"] = [
                r for r in self.graph["relationships"]
                if not (r["$targetId"] == person and r["$relationshipName"] == "hasCrew"
                        and r["$sourceId"] == trip)
            ]
        self.graph["twins"] = [t for t in self.graph["twins"] if t["$dtId"] != person]
        self.graph["twins"].append(
            {
                "$dtId": user,
                "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
                "name": "Niko Raes",
                "email": "niko@example.com",
                "displayName": "Niko Raes",
            }
        )
        return {"transferred": transferred, "alreadyCrew": already_crew}


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
    assert len(stub.transfers) == 1  # the fixture placeholders are single-trip
    trip_dtid, user, p, role, index, note, display_name = stub.transfers[0]
    assert trip_dtid == trip and user == "google-oauth2|42" and p == person
    assert role == "owner"
    assert note is None  # anon fixture crew carry no notes
    assert display_name is None  # ... and no edge displayName (pre-#196 edges)
    # rebuilt: the user is on the crew (placeholder gone) — names redacted in anon graph
    assert any(c.id == "google-oauth2|42" for c in trip_model.crew)
    assert len(trip_model.crew) == 3


def test_claim_never_carries_an_opaque_id_over_as_the_crew_name(stub: _StubClient) -> None:
    """#213: an edge whose label IS the person's own id carries no name — the
    claim carries none over instead of promoting the opaque id to a name."""
    person = _person_id(stub.graph, "Niko Raes")
    edge = next(
        r for r in stub.graph["relationships"]
        if r["$targetId"] == person and r["$relationshipName"] == "hasCrew"
    )
    edge["displayName"] = person

    trip_model = claims_module.claim_identity(CLAIM_TOKEN, person, "google-oauth2|42", PROFILE)

    assert stub.transfers
    assert stub.transfers[0][-1] is None  # no displayName rode over
    assert all(c.name != person for c in trip_model.crew)


def test_claim_cascades_to_every_trip_crewing_the_placeholder(stub: _StubClient) -> None:
    """#322: one placeholder, two trips, ONE join link. Claiming through either
    transfers every edge — each trip keeping its OWN role — and retires the
    placeholder once, so no trip is left pointing at a deleted twin."""
    person = _person_id(stub.graph, "Niko Raes")
    trip = stub.graph["$dtId"]
    other = "dddddddd-4444-4444-8444-444444444444"
    stub.graph["twins"].append({
        "$dtId": other,
        "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"},
        "title": "Iceland 2026",
    })
    stub.graph["relationships"].append({
        "$sourceId": other, "$relationshipName": "hasCrew", "$targetId": person,
        "role": "viewer", "index": 1,
    })

    claims_module.claim_identity(CLAIM_TOKEN, person, "google-oauth2|42", PROFILE)

    assert stub.created_user == "google-oauth2|42"
    assert {t[0]: t[3] for t in stub.transfers} == {trip: "owner", other: "viewer"}
    assert all(t["$dtId"] != person for t in stub.graph["twins"])
    assert not [r for r in stub.graph["relationships"] if r["$targetId"] == person]


def test_claim_refuses_a_placeholder_from_another_trip(stub: _StubClient) -> None:
    """The invite authorizes claiming a person ON THIS TRIP; the cascade then
    follows the person out to their other trips — never the reverse, or a link
    for one trip would claim a stranger who is only crew somewhere else."""
    person = _person_id(stub.graph, "Niko Raes")
    other = "dddddddd-4444-4444-8444-444444444444"
    stub.graph["twins"].append({
        "$dtId": other,
        "$metadata": {"$model": "dtmi:kiseki:travel:Trip;1"},
        "title": "Iceland 2026",
    })
    # the placeholder is crew on the SIBLING only — no edge from this trip
    stub.graph["relationships"] = [
        r for r in stub.graph["relationships"]
        if not (r["$targetId"] == person and r["$relationshipName"] == "hasCrew")
    ]
    stub.graph["relationships"].append({
        "$sourceId": other, "$relationshipName": "hasCrew", "$targetId": person,
        "role": "viewer", "index": 1,
    })

    with pytest.raises(claims_module.ClaimError) as ei:
        claims_module.claim_identity(CLAIM_TOKEN, person, "google-oauth2|42", PROFILE)
    assert ei.value.status == 409
    assert stub.transfers == []  # nothing transferred anywhere


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
    assert stub.transfers == []


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


def test_claim_rejects_m2m_token(client: TestClient, rsa_keypair) -> None:
    """An M2M client-credentials token has no user sub — it cannot claim a
    crew identity (identity provisioning is user-token-only)."""
    token = _sign(rsa_keypair, _claims(gty="client-credentials", azp="m2m-client"))
    r = client.post(
        "/api/claims",
        json={"claimToken": CLAIM_TOKEN, "personId": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403
    assert "Service principals" in r.json()["detail"]


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


def test_follow_rejects_m2m_token(client: TestClient, rsa_keypair) -> None:
    """Following provisions a hasCrew edge for the caller — an M2M token
    cannot follow on behalf of a user (user-token-only)."""
    token = _sign(rsa_keypair, _claims(gty="client-credentials", azp="m2m-client"))
    r = client.post(
        "/api/claims/follow",
        json={"claimToken": CLAIM_TOKEN},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403
    assert "Service principals" in r.json()["detail"]


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
