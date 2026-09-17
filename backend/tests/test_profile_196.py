"""Profile reads + the #195 gates (issue #196, phase B).

Covers the phase-B surfaces against the in-memory ``FakeGraph`` with the
REAL auth/ACL/store/service code (same harness as ``test_identity_196.py``):

1. ``User.publicName`` — model default False; ``PUT /api/me`` self-only,
   strict one-knob body, M2M refusal (403, act-as included), 404 with no twin.
2. ``GET /api/users/{sub}`` — 404 for unknown subs; counts; email/publicName
   self-only; the discoverable-only trip list (discoverable listed;
   non-discoverable private listed only when the viewer already has a role;
   stranger-private and non-discoverable public never listed).
3. ``GET /api/users/{sub}/followers|following`` — same 404; true-total count;
   entries carry sub/name (+ avatar when known, isSelf for the viewer).
4. Initials gate — an outsider on a discoverable trip sees initials (never a
   blank); an opted-in member keeps their real name; the viewer's own entry
   is never redacted; crew/follower+ viewers and non-discoverable trips
   render exactly as before.
5. Sanitization gate — ``<script>`` / ``onerror`` / ``javascript:`` do not
   survive the write API; a benign ``<div class style>`` does, end-to-end.
"""

from __future__ import annotations

import hashlib
import io
import uuid

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app import media as media_module
from app import store as store_mod
from app.auth import Auth0JWTValidator
from app.graph.convert import graph_to_trip
from app.main import _crew_initials, app
from app.models import Trip
from app.ratelimit import reset as reset_rate_limits
from app.sanitize import sanitize_custom_html

from conftest import CLIENT_ID, TENANT, _claims, _sign
from fake_graph import FakeGraph
from scripts.trip_to_graph import trip_to_graph  # noqa: F401 (parity with phase-A file)

SUB = "google-oauth2|1234567890"
OTHER = "auth0|user-b-0000000001"
STRANGER = "auth0|stranger-0000000007"
FAN = "auth0|fan-0000000008"
AGENT_CLIENT = "cyKpzLkq8J5LMFPfWYOioG8VzYsMgm8U"
PROFILE = {"email": "niko@example.com", "name": "Niko Raes"}

EVIL_HTML = (
    '<div class="wrap" style="color:red">Hello</div>'
    '<script>alert("xss")</script>'
    '<img src="https://example.com/x.png" onerror="alert(1)">'
    '<a href="javascript:alert(1)">click</a>'
    '<iframe src="https://example.com"></iframe>'
)


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


# ------------------------------------------------------- 1. publicName + PUT /api/me

def test_public_name_defaults_false() -> None:
    """The model default is False — nobody opts into name display by accident."""
    from app.models import User

    u = User.model_validate({
        "id": "auth0|x", "name": "X",
        "email": "x@example.com", "displayName": "X",
    })
    assert u.publicName is False


def test_put_me_flips_own_flag_and_nothing_else(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair, sub=OTHER)

    r = client.put("/api/me", headers=_auth(token), json={"publicName": True})
    assert r.status_code == 200
    body = r.json()
    assert body["sub"] == OTHER
    assert body["ensured"] is True
    assert body["publicName"] is True
    assert body["email"] == "User Bee@example.com"
    assert g.twin(OTHER).get("publicName") is True
    # Self-only: nobody else's twin gained the flag.
    assert "publicName" not in (g.twin(SUB) or {})

    r = client.put("/api/me", headers=_auth(token), json={"publicName": False})
    assert r.status_code == 200
    assert r.json()["publicName"] is False
    assert g.twin(OTHER).get("publicName") is False


def test_put_me_is_one_knob(client, rsa_keypair, graph) -> None:
    """Any field besides ``publicName``/``displayName`` is a 422 — this can
    never grow into a general twin editor by accident (#317 added the second
    knob; the photo stays on its own upload route)."""
    graph(role="owner")
    token = _token_of(rsa_keypair)
    r = client.put("/api/me", headers=_auth(token),
                   json={"publicName": True, "email": "evil@example.com"})
    assert r.status_code == 422


def test_put_me_404_without_twin(client, rsa_keypair, graph) -> None:
    """No twin yet → 404 (the client calls ``ensure`` first), never an
    implicit provision."""
    graph(role="owner")
    ghost = _token_of(rsa_keypair, sub="auth0|ghost-0000000009")
    r = client.put("/api/me", headers=_auth(ghost), json={"publicName": True})
    assert r.status_code == 404


def test_put_me_refuses_m2m_token(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``PUT /api/me`` writes graph identity, so it obeys the claim/follow
    rule: a sanctioned-agent M2M token is refused (403) — bare or carrying an
    act-as sub — and no flag lands on anyone."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
    token = _token_of(rsa_keypair, gty="client-credentials", azp=AGENT_CLIENT,
                      sub=f"{AGENT_CLIENT}@clients")

    for headers in (_auth(token), {**_auth(token), "X-Act-As-Sub": OTHER}):
        r = client.put("/api/me", headers=headers, json={"publicName": True})
        assert r.status_code == 403
    assert "publicName" not in (g.twin(OTHER) or {})


# ------------------------------------------------------- 2. profile document

def _listing_setup(g: FakeGraph) -> dict:
    """OTHER's trips: discoverable-private, shared-private, stranger-private,
    public-but-not-discoverable. FAN follows OTHER; STRANGER shares one trip."""
    _ensure_user(g, OTHER, "Other User")
    _ensure_user(g, STRANGER, "Stranger Danger")
    _ensure_user(g, FAN, "Fan Fan")
    assert g.follow_user(FAN, OTHER)
    return {
        "discoverable": _add_trip(g, "Listed Trip", visibility="private",
                                  discoverable=True, crew={OTHER: "viewer"}),
        "shared": _add_trip(g, "Shared Trip", visibility="private",
                            crew={OTHER: "viewer", STRANGER: "follower"}),
        "stranger_private": _add_trip(g, "Hidden Trip", visibility="private",
                                      crew={OTHER: "viewer"}),
        "public_plain": _add_trip(g, "Public Trip", visibility="public",
                                  crew={OTHER: "viewer"}),
    }


def test_profile_404_for_unknown_sub(client, rsa_keypair, graph) -> None:
    graph(role="owner")
    token = _token_of(rsa_keypair)
    unknown = "auth0|no-such-user-0000"
    assert client.get(f"/api/users/{unknown}", headers=_auth(token)).status_code == 404
    assert client.get(f"/api/users/{unknown}/followers", headers=_auth(token)).status_code == 404
    assert client.get(f"/api/users/{unknown}/following", headers=_auth(token)).status_code == 404


def test_profile_counts_and_self_only_fields(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    ids = _listing_setup(g)

    # A stranger's view: counts are exact, email/publicName keys are ABSENT.
    stranger_tok = _token_of(rsa_keypair, sub=STRANGER)
    r = client.get(f"/api/users/{OTHER}", headers=_auth(stranger_tok))
    assert r.status_code == 200
    body = r.json()
    assert body["sub"] == OTHER
    assert body["name"] == "Other User"
    assert "avatar" not in body  # no avatar field exists on the twin — omit, don't invent
    assert "email" not in body
    assert "publicName" not in body
    assert body["counts"] == {"followers": 1, "following": 0, "trips": 2}
    assert body["viewer"] == {"isSelf": False, "following": False}

    # The discoverable trip lists with NO myRole; the shared private trip
    # lists WITH the viewer's own role. Nothing else is listed: not the
    # stranger-private trip, not the non-discoverable public trip (today's
    # `public` keeps its exact meaning — readable by link, listed nowhere).
    by_id = {t["dtId"]: t for t in body["trips"]}
    assert set(by_id) == {ids["discoverable"], ids["shared"]}
    listed = by_id[ids["discoverable"]]
    assert listed["discoverable"] is True
    assert "myRole" not in listed
    assert listed["title"] == "Listed Trip"
    shared = by_id[ids["shared"]]
    assert shared["discoverable"] is False
    assert shared["myRole"] == "follower"

    # Self view: email + publicName present, every own trip listed with a role.
    other_tok = _token_of(rsa_keypair, sub=OTHER)
    r = client.get(f"/api/users/{OTHER}", headers=_auth(other_tok))
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == "Other User@example.com"
    assert body["publicName"] is False
    assert body["viewer"] == {"isSelf": True, "following": False}
    assert body["counts"]["trips"] == 4
    assert {t["dtId"] for t in body["trips"]} == set(ids.values())
    assert all(t["myRole"] == "viewer" for t in body["trips"])


def test_profile_viewer_following_flag(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _listing_setup(g)
    fan_tok = _token_of(rsa_keypair, sub=FAN)
    r = client.get(f"/api/users/{OTHER}", headers=_auth(fan_tok))
    assert r.status_code == 200
    assert r.json()["viewer"] == {"isSelf": False, "following": True}


# ------------------------------------------------------- 3. followers / following

def test_followers_and_following_lists(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _ensure_user(g, OTHER, "Other User")
    _ensure_user(g, STRANGER, "Stranger Danger")
    assert g.follow_user(STRANGER, OTHER)
    token = _token_of(rsa_keypair, sub=STRANGER)

    r = client.get(f"/api/users/{OTHER}/followers", headers=_auth(token))
    assert r.status_code == 200
    assert r.json()["count"] == 1
    (person,) = r.json()["people"]
    assert person["sub"] == STRANGER
    assert person["name"] == "Stranger Danger"
    assert person["isSelf"] is True  # the viewer sees themselves marked
    assert "email" not in person  # no email, ever

    r = client.get(f"/api/users/{OTHER}/following", headers=_auth(token))
    assert r.status_code == 200
    assert r.json() == {"count": 0, "people": []}

    r = client.get(f"/api/users/{STRANGER}/following", headers=_auth(token))
    assert r.json()["count"] == 1
    assert r.json()["people"][0]["sub"] == OTHER
    assert "isSelf" not in r.json()["people"][0]


# ------------------------------------------------------- 4. initials gate

def test_initials_algorithm() -> None:
    assert _crew_initials("Niko Raes") == "NR"
    assert _crew_initials("Madonna") == "M"
    assert _crew_initials("") == "?"
    assert _crew_initials("   ") == "?"
    assert _crew_initials("Jean-Claude Van Damme") == "JD"


def _redaction_setup(client, rsa_keypair, g: FakeGraph) -> Trip:
    """Root trip: public + discoverable, two named placeholders (one with a
    note + contact) and an opted-in User crew member."""
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)
    for payload in (
        {"name": "Niko Raes", "role": "viewer",
         "note": "skis hard", "contact": "niko@example.com"},
        {"name": "Madonna", "role": "viewer"},
    ):
        r = client.post(f"/api/trips/{trip.id}/crew", headers=_auth(owner_tok),
                        json=payload)
        assert r.status_code == 201
    g.add_user_role(g.root, OTHER, "viewer", name="Olivia Other")
    other_tok = _token_of(rsa_keypair, sub=OTHER)
    r = client.put("/api/me", headers=_auth(other_tok), json={"publicName": True})
    assert r.status_code == 200
    r = client.put(f"/api/trips/{trip.id}", headers=_auth(owner_tok),
                   json={"visibility": "public", "discoverable": True})
    assert r.status_code == 200
    return trip


def test_outsider_sees_initials_opted_in_keeps_name(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _redaction_setup(client, rsa_keypair, g)
    trip = _trip_of(g)

    r = client.get(f"/api/trips/{trip.id}")  # anonymous outsider
    assert r.status_code == 200
    crew = {c["name"]: c for c in r.json()["crew"]}

    niko = crew["NR"]
    assert niko["initials"] == "NR"
    assert niko["redactedName"] is True
    assert "note" not in niko  # trip-relative note dropped for redacted members
    assert "contact" not in niko  # contact (may carry an email) dropped too
    assert crew["M"]["redactedName"] is True
    # Fixture placeholders ("Person 1") redact the same way — never blank.
    assert crew["P1"]["name"] == "P1"
    assert all(c["name"] for c in r.json()["crew"])
    # The opted-in member keeps their real name, unchanged.
    olivia = crew["Olivia Other"]
    assert "redactedName" not in olivia
    assert "initials" not in olivia


def test_crew_viewer_sees_everything_and_own_entry(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    _redaction_setup(client, rsa_keypair, g)
    trip = _trip_of(g)

    r = client.get(f"/api/trips/{trip.id}", headers=_auth(_token_of(rsa_keypair)))
    assert r.status_code == 200
    body = r.json()
    assert body["myRole"] == "owner"
    names = [c["name"] for c in body["crew"]]
    assert "Niko Raes" in names  # full names for crew/follower+ viewers
    assert "NR" not in names
    assert not any("redactedName" in c for c in body["crew"])
    me = next(c for c in body["crew"] if c["id"] == SUB)
    assert me["name"] == "Test Owner"  # the viewer's own entry keeps its name


def test_outsider_on_non_discoverable_trip_unchanged(client, rsa_keypair, graph) -> None:
    """A trip that is not `discoverable` renders exactly as before — the gate
    does not touch existing public-by-link behaviour."""
    g = graph(role="owner")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)
    r = client.post(f"/api/trips/{trip.id}/crew", headers=_auth(owner_tok),
                    json={"name": "Niko Raes", "role": "viewer"})
    assert r.status_code == 201
    # Root fixture is already public; discoverable stays False.
    assert _trip_of(g).discoverable is False

    r = client.get(f"/api/trips/{trip.id}")  # anonymous outsider
    assert r.status_code == 200
    names = [c["name"] for c in r.json()["crew"]]
    assert "Niko Raes" in names
    assert not any("redactedName" in c for c in r.json()["crew"])


# ------------------------------------------------------- 5. sanitization gate

def test_custom_html_sanitized_on_create_and_update(client, rsa_keypair, graph) -> None:
    g = graph(role="owner")
    trip = _trip_of(g)
    owner_tok = _token_of(rsa_keypair)
    day_id = trip.days[0].id

    r = client.post(f"/api/trips/{trip.id}/blocks", headers=_auth(owner_tok), json={
        "kind": "custom",
        "container": {"type": "day", "id": day_id},
        "title": "Custom",
        "html": EVIL_HTML,
    })
    assert r.status_code == 201
    block_id = next(
        b["id"] for d in r.json()["days"] for b in d["blocks"] if b.get("title") == "Custom"
    )

    def _stored() -> str:
        doc = client.get(f"/api/trips/{trip.id}", headers=_auth(owner_tok)).json()
        return next(
            b["html"] for d in doc["days"] for b in d["blocks"] if b["id"] == block_id
        )

    stored = _stored()
    assert "<script" not in stored and "onerror" not in stored
    assert "javascript:" not in stored and "iframe" not in stored
    assert '<div class="wrap" style="color:red">Hello</div>' in stored

    r = client.put(f"/api/trips/{trip.id}/blocks/{block_id}", headers=_auth(owner_tok),
                   json={"html": EVIL_HTML + "<p onclick=\"evil()\">x</p>"})
    assert r.status_code == 200
    stored = _stored()
    assert "onclick" not in stored
    assert '<div class="wrap" style="color:red">Hello</div>' in stored


def test_sanitizer_policy() -> None:
    """The server policy mirrors what the client permits: layout survives,
    active content does not."""
    assert sanitize_custom_html(None) is None
    clean = sanitize_custom_html(
        '<div class="x" style="color:red">t</div>'
        '<video src="https://e.com/v.mp4" controls></video>'
        '<img src="data:image/png;base64,AAA" alt="i">'
    )
    assert 'class="x"' in clean and 'style="color:red"' in clean
    assert "<video" in clean and "controls" in clean
    assert "data:image/png;base64,AAA" in clean
    # …while non-image data: URLs and event handlers are dropped.
    assert "data:text/html" not in sanitize_custom_html('<a href="data:text/html,x">x</a>')
    dirty = sanitize_custom_html(EVIL_HTML)
    assert dirty == sanitize_custom_html(dirty)  # sanitizing twice is a no-op


# ------------------------------------------------------- query-shape guards (live parity)

def test_trips_for_user_query_carries_discoverable() -> None:
    """The profile list rule reads `discoverable` from the same summary query
    — no second round-trip per trip. Both row widths decode."""
    import app.graph.client as client_mod

    assert "discoverable" in client_mod._Q_TRIPS_FOR_USER
    assert "$uid" in client_mod._Q_TRIPS_FOR_USER
    ten = ["id", "private", "T", "S", "planned", "2027-01-01", "2027-01-02",
           "slug", None, "viewer"]
    assert client_mod.GraphReadClient._trip_summary_from_list(ten)["discoverable"] is False
    eleven = ten + [True]
    assert client_mod.GraphReadClient._trip_summary_from_list(eleven)["discoverable"] is True


# ------------------------------------------- 6. review fixes (#196 phase B review)


def test_join_link_and_claim_response_are_crew_views(client, rsa_keypair, graph,
                                                    monkeypatch) -> None:
    """The claim token IS the invite and claiming makes the caller crew, so both
    responses are crew views: real names come back, exactly as before #196.

    The initials rule governs an OUTSIDER browsing a LISTED trip. The join page
    must show the crew (that is how the invitee picks 'This is me'), so the
    invite read is not a listed surface; and by the time the claim response is
    built the caller holds a hasCrew edge on that trip — redacting their
    crewmates there would silently regress #198's join flow.
    """
    g = graph(role="owner")
    _redaction_setup(client, rsa_keypair, g)  # public + discoverable + named crew
    trip = _trip_of(g)
    assert trip.discoverable is True  # the gate WOULD fire on a plain public read

    r = client.get(f"/api/trips/by-claim/{trip.claimToken}")
    assert r.status_code == 200
    assert "Niko Raes" in [c["name"] for c in r.json()["crew"]]
    assert not any("redactedName" in c for c in r.json()["crew"])

    monkeypatch.setattr("app.main.claim_identity", lambda token, person, sub, profile: trip)
    r = client.post(
        "/api/claims",
        headers=_auth(_token_of(rsa_keypair, sub=STRANGER)),
        json={"claimToken": trip.claimToken, "personId": "whatever"},
    )
    assert r.status_code == 200
    assert "Niko Raes" in [c["name"] for c in r.json()["crew"]]
    assert not any("redactedName" in c for c in r.json()["crew"])


def test_set_user_public_name_write_shape_and_failure(monkeypatch) -> None:
    """``PUT /api/me``'s graph write: the upsert body carries ONLY
    ``$dtId`` + ``$metadata.$model`` plus the props — a read's ``$etag`` /
    ``$lastUpdateTime`` must never ride back into a write (stale concurrency
    token, cf. ``trip_to_graph.twin``) — and a WRITE failure raises
    ``GraphWriteError`` (route → 503) instead of collapsing into None, which
    would report "no such user, call ensure first" for an identity that exists.
    """
    import app.graph.client as gc

    class _SDK:
        def __init__(self) -> None:
            self.calls: list[dict] = []
            self.fail = False

        def upsert_digital_twin(self, dtid: str, twin) -> None:
            if self.fail:
                raise RuntimeError("graph 500")
            self.calls.append(twin.to_dict())

    sdk = _SDK()
    client_obj = object.__new__(gc.GraphReadClient)
    client_obj._client = sdk
    monkeypatch.setattr(client_obj, "is_enabled", lambda: True)
    monkeypatch.setattr(client_obj, "get_user_profile", lambda sub: {
        "$dtId": sub,
        "$etag": 'W/"stale"',
        "$metadata": {
            "$model": gc.USER_MODEL,
            "$lastUpdateTime": "2020-01-01T00:00:00Z",
        },
        "name": "Niko Raes",
        "email": "niko@example.com",
        "displayName": "Niko Raes",
        "authProvider": "google",
    })

    out = client_obj.set_user_public_name(SUB, True)
    assert out is not None
    assert out["publicName"] is True
    assert out["email"] == "niko@example.com"  # existing props preserved
    assert not any(k.startswith("$") for k in out)  # flat props, no ADT keys

    (sent,) = sdk.calls
    assert sent["$dtId"] == SUB
    assert sent["$metadata"] == {"$model": gc.USER_MODEL}
    assert "$etag" not in sent
    assert "$lastUpdateTime" not in sent["$metadata"]
    assert sent["publicName"] is True

    sdk.fail = True
    with pytest.raises(gc.GraphWriteError) as excinfo:
        client_obj.set_user_public_name(SUB, False)
    assert excinfo.value.status == 503


# ------------------------------------------------------- 6. editable profile (#317)


def test_put_me_sets_display_name(client, rsa_keypair, graph) -> None:
    """``PUT /api/me {"displayName"}`` renames the profile (Kiseki-only) and
    the twin's ``name`` mirror with it — the profile reads the new name."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair, sub=OTHER)

    r = client.put("/api/me", headers=_auth(token), json={"displayName": "  Bea  "})
    assert r.status_code == 200
    body = r.json()
    assert body["displayName"] == "Bea"
    assert body["name"] == "Bea"
    assert g.twin(OTHER).get("displayName") == "Bea"
    assert g.twin(OTHER).get("name") == "Bea"

    doc = client.get(f"/api/users/{OTHER}", headers=_auth(token)).json()
    assert doc["name"] == "Bea"


def test_put_me_rejects_bad_display_name(client, rsa_keypair, graph) -> None:
    """Empty / blank / over-long names and an empty body are 422 — nothing
    is written either way."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair, sub=OTHER)

    for payload in ({"displayName": ""}, {"displayName": "   "},
                    {"displayName": "x" * 81}, {}):
        r = client.put("/api/me", headers=_auth(token), json=payload)
        assert r.status_code == 422, payload
    assert g.twin(OTHER).get("displayName") == "User Bee"


def test_put_me_display_name_survives_re_ensure(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Kiseki-edited name is never clobbered: a later ``ensure`` (whose
    Auth0 profile still carries the OLD name) keeps the user's edit, while
    the email stays fresh from the provider."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair, sub=OTHER)
    assert client.put("/api/me", headers=_auth(token),
                      json={"displayName": "Bea"}).status_code == 200

    monkeypatch.setattr(
        auth_module, "fetch_userinfo",
        lambda tok: {"email": "new@example.com", "name": "User Bee",
                     "picture": "https://example.com/pic.jpg"},
    )
    r = client.post("/api/me/ensure", headers=_auth(token))
    assert r.status_code == 200
    assert g.twin(OTHER).get("displayName") == "Bea"
    assert g.twin(OTHER).get("email") == "new@example.com"

    doc = client.get(f"/api/users/{OTHER}", headers=_auth(token)).json()
    assert doc["name"] == "Bea"


def test_ensure_syncs_google_picture_on_first_login(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """First login with an IdP photo stores it: the profile carries the
    ``https://`` avatar (the exact photo the top-right menu already showed
    from the Auth0 session)."""
    g = graph(role="owner")
    token = _token_of(rsa_keypair, sub=OTHER)
    monkeypatch.setattr(
        auth_module, "fetch_userinfo",
        lambda tok: {"email": "bee@example.com", "name": "User Bee",
                     "picture": "https://example.com/bee.jpg"},
    )
    assert client.post("/api/me/ensure", headers=_auth(token)).status_code == 200
    assert g.twin(OTHER).get("avatar") == "https://example.com/bee.jpg"

    doc = client.get(f"/api/users/{OTHER}", headers=_auth(token)).json()
    assert doc["avatar"] == "https://example.com/bee.jpg"


def test_ensure_never_clobbers_uploaded_avatar(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An uploaded avatar survives later logins: re-ensure with an Auth0
    ``picture`` present keeps the user's photo and only fills what's missing."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    assert g.update_user_profile(OTHER, avatar="c383ce57abcd1234c383ce57abcd1234.jpg")
    token = _token_of(rsa_keypair, sub=OTHER)
    monkeypatch.setattr(
        auth_module, "fetch_userinfo",
        lambda tok: {"email": "bee@example.com", "name": "Someone Else",
                     "picture": "https://example.com/other.jpg"},
    )
    assert client.post("/api/me/ensure", headers=_auth(token)).status_code == 200
    assert g.twin(OTHER).get("avatar") == "c383ce57abcd1234c383ce57abcd1234.jpg"

    doc = client.get(f"/api/users/{OTHER}", headers=_auth(token)).json()
    assert doc["avatar"] == "/api/avatars/c383ce57abcd1234c383ce57abcd1234.jpg"


class _AvatarConfig:
    """Config stand-in pointing the media store at a tmp dir (test_chat.py's
    ``_FakeConfig`` pattern — local to this module, no cross-test import)."""

    def __init__(self, root):
        self.KISEKI_S3_ENDPOINT = ""
        self.KISEKI_S3_BUCKET = ""
        self.KISEKI_S3_ACCESS_KEY = ""
        self.KISEKI_S3_SECRET_KEY = ""
        self.KISEKI_S3_REGION = ""
        self.ASSETS_DIR = root


def _avatar_store(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(media_module, "config", _AvatarConfig(tmp_path))
    media_module.clear_media_store()
    return tmp_path


def _upload_avatar(client, token, raw: bytes, filename: str):
    return client.post(
        "/api/me/avatar",
        files={"file": (filename, io.BytesIO(raw), "image/jpeg")},
        headers=_auth(token),
    )


def test_avatar_upload_round_trip(client, rsa_keypair, graph, monkeypatch, tmp_path) -> None:
    """Upload → content-addressed serve URL on the profile → bytes back.
    The twin stores the BARE filename; only readers resolve the URL."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair, sub=OTHER)
    _avatar_store(monkeypatch, tmp_path)
    try:
        raw = b"\x89PNG\r\n\x1a\navatar-bytes"
        r = _upload_avatar(client, token, raw, "me.jpg")
        assert r.status_code == 200
        body = r.json()
        assert body["sub"] == OTHER
        expected = hashlib.sha256(raw).hexdigest()[:32]
        assert body["avatar"] == f"/api/avatars/{expected}.jpg"

        twin = g.twin(OTHER)
        assert twin.get("avatar") == f"{expected}.jpg"  # bare, never a path

        doc = client.get(f"/api/users/{OTHER}", headers=_auth(token)).json()
        assert doc["avatar"] == f"/api/avatars/{expected}.jpg"

        serve = client.get(body["avatar"], headers=_auth(token))
        assert serve.status_code == 200
        assert serve.content == raw
        assert serve.headers["content-type"] == "image/jpeg"

        # #320: no token at all — the <img src> path. An avatar renders in an
        # <img>, which cannot send an Authorization header; the content-addressed
        # name is the capability (same posture as /media and /inbox).
        anon = client.get(body["avatar"])
        assert anon.status_code == 200
        assert anon.content == raw
        assert anon.headers["content-type"] == "image/jpeg"
    finally:
        media_module.clear_media_store()


def test_avatar_upload_rejects_non_photos(client, rsa_keypair, graph, monkeypatch, tmp_path) -> None:
    """Documents and SVG are 422 with a message naming the file — and the
    twin keeps whatever avatar it had (no half-write)."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    token = _token_of(rsa_keypair, sub=OTHER)
    _avatar_store(monkeypatch, tmp_path)
    try:
        r = _upload_avatar(client, token, b"hi", "notes.txt")
        assert r.status_code == 422
        r = client.post(
            "/api/me/avatar",
            files={"file": ("evil.svg", io.BytesIO(b"<svg/>"), "image/svg+xml")},
            headers=_auth(token),
        )
        assert r.status_code == 422
        assert "avatar" not in (g.twin(OTHER) or {})
    finally:
        media_module.clear_media_store()


def test_avatar_upload_needs_twin_and_user_token(
    client, rsa_keypair, graph, monkeypatch, tmp_path,
) -> None:
    """No twin → 404 (call ``ensure`` first); a sanctioned-agent M2M token is
    refused 403 — avatar writes provision identity like every ``/api/me*``."""
    graph(role="owner")
    _avatar_store(monkeypatch, tmp_path)
    try:
        ghost = _token_of(rsa_keypair, sub="auth0|ghost-0000000009")
        r = _upload_avatar(client, ghost, b"\x89PNG\r\n\x1a\nx", "me.jpg")
        assert r.status_code == 404

        monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", AGENT_CLIENT)
        m2m = _token_of(rsa_keypair, gty="client-credentials", azp=AGENT_CLIENT,
                        sub=f"{AGENT_CLIENT}@clients")
        r = _upload_avatar(client, m2m, b"\x89PNG\r\n\x1a\nx", "me.jpg")
        assert r.status_code == 403
    finally:
        media_module.clear_media_store()


def test_avatar_delete_falls_back_to_provider_picture(
    client, rsa_keypair, graph, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Remove → the IdP photo when the provider has one, else the monogram
    (no key at all — never a dangling upload reference)."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "User Bee")
    assert g.update_user_profile(OTHER, avatar="c383ce57abcd1234c383ce57abcd1234.jpg")
    token = _token_of(rsa_keypair, sub=OTHER)

    monkeypatch.setattr(
        auth_module, "fetch_userinfo",
        lambda tok: {"email": "bee@example.com", "name": "User Bee",
                     "picture": "https://example.com/bee.jpg"},
    )
    r = client.delete("/api/me/avatar", headers=_auth(token))
    assert r.status_code == 200
    assert r.json()["avatar"] == "https://example.com/bee.jpg"

    monkeypatch.setattr(auth_module, "fetch_userinfo", lambda tok: {})
    r = client.delete("/api/me/avatar", headers=_auth(token))
    assert r.status_code == 200
    assert r.json()["avatar"] is None
    doc = client.get(f"/api/users/{OTHER}", headers=_auth(token)).json()
    assert "avatar" not in doc


def test_avatar_serve_404s(client, rsa_keypair, graph) -> None:
    """Unknown files, non-photo extensions and traversal are 404 without
    ever touching storage."""
    graph(role="owner")
    token = _token_of(rsa_keypair)
    assert client.get("/api/avatars/doesnotexist0123456789abcdef.jpg",
                      headers=_auth(token)).status_code == 404
    assert client.get("/api/avatars/notes.txt",
                      headers=_auth(token)).status_code == 404
    assert client.get("/api/avatars/..%2Fsecret.jpg",
                      headers=_auth(token)).status_code == 404


def test_followers_list_resolves_uploaded_avatar(client, rsa_keypair, graph) -> None:
    """Drill-in entries carry the resolved serve URL for uploaded avatars —
    the same ``_resolve_avatar`` contract as the profile document."""
    g = graph(role="owner")
    _ensure_user(g, OTHER, "Other User")
    _ensure_user(g, FAN, "Fan User")
    assert g.update_user_profile(FAN, avatar="f383ce57abcd1234f383ce57abcd1234.jpg")
    fan_token = _token_of(rsa_keypair, sub=FAN)
    assert client.post(f"/api/users/{OTHER}/follow",
                       headers=_auth(fan_token)).status_code == 200

    other_token = _token_of(rsa_keypair, sub=OTHER)
    doc = client.get(f"/api/users/{OTHER}/followers",
                     headers=_auth(other_token)).json()
    assert doc["count"] == 1
    (entry,) = doc["people"]
    assert entry["sub"] == FAN
    assert entry["avatar"] == "/api/avatars/f383ce57abcd1234f383ce57abcd1234.jpg"
