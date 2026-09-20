"""Chat relay + file upload tests (issue #9 / M3, resumable turns #217).

Covers the M3 acceptance contract:
- identity is bearer-first: end-user token → its own sub (mode 1); sanctioned
  M2M token + X-Act-As-Sub header → that sub (mode 2); M2M with no act-as and
  no pin → 401;
- /api/chat uses the Runs API: only the new user message is forwarded with a
  per-actor (per-trip/thread) `session_id` + identity `instructions`, and the
  upstream runs event feed is translated to Vercel-ai UI-message-stream v1
  chunks (``data: {…}`` SSE events … ``data: [DONE]``);
- a turn belongs to the RELAY, not the connection (#217): it runs with no
  client attached, a re-request with the same ``turnKey`` attaches (it never
  re-submits the run), and ``cursor`` resumes exactly at the frame the caller
  already rendered;
- /api/chat/turn reports a turn's state and /api/chat/stop interrupts it;
- /api/chat gates the named trip (follower+ for the ACTING user);
- /api/files stores content-addressed bytes into the trip's media namespace
  and returns the /media URL (editor+ only);
- claims/follow still refuse M2M tokens (regression, #142).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import time

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import acl as acl_module
from app import chat as chat_module
from app import main as main_module
from app import media as media_module
from app.auth import Auth0JWTValidator
from app.main import app
from app.models import Block as BlockModel
from app.models import Day as DayModel
from app.models import Trip as TripModel
from app.models import TripSection as SectionModel
from app.models import Visibility

from conftest import CLIENT_ID, KID, TENANT, _claims, _sign

# The sanctioned agent M2M client id (mirrors acl.KISEKI_AGENT_CLIENT_ID).
M2M_CLIENT = "agent-m2m-client-xyz"
USER_SUB = "google-oauth2|1234567890"
OTHER_SUB = "google-oauth2|other-user-1"
TRIP = "bf29a027-1111-2222-3333-444455556666"


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", M2M_CLIENT)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "")  # per-test override
    return TestClient(app)


def _user_token(rsa_keypair, *, sub: str = USER_SUB, m2m: bool = False) -> str:
    claims = _claims(sub=sub)
    if m2m:
        claims.update(
            azp=M2M_CLIENT,
            gty="client-credentials",
            aud=CLIENT_ID,
        )
    return _sign(rsa_keypair, claims)


def _role(monkeypatch: pytest.MonkeyPatch, value: str | None):
    monkeypatch.setattr(
        chat_module, "get_trip_role_for_user", lambda *a, **k: value
    )


def _trip_model(
    visibility: Visibility = "public",
    *,
    title: str = "Chili + Peru — zomer 2027",
    days: list | None = None,
    sections: list | None = None,
):
    """A REAL ``Trip`` (not a stub) — the chat envelope now reads its identity
    (#330): title/id/stage/dates/day count + the focused day/section/block."""
    return TripModel(
        id=TRIP,
        slug="chile-peru-2027",
        title=title,
        stage="planned",
        startDate="2027-07-17",
        endDate="2027-08-02",
        visibility=visibility,
        claimToken="secret",
        days=days
        if days is not None
        else [
            DayModel(id="day-1", date="2027-07-17", title="Vlieg BRU → Santiago"),
            DayModel(
                id="day-2",
                date="2027-07-18",
                title="Aankomst Santiago",
                blocks=[
                    BlockModel(
                        id="block-9",
                        kind="meal",
                        title="Mercado Central",
                        description="Ceviche lunch.",
                    )
                ],
            ),
        ],
        sections=sections
        if sections is not None
        else [
            SectionModel(id="sec-1", title="Valle Nevado & de Andes", days=[0, 1]),
        ],
    )


def _fake_trip(
    monkeypatch: pytest.MonkeyPatch,
    visibility: Visibility = "public",
    *,
    title: str = "Chili + Peru — zomer 2027",
    days: list | None = None,
    sections: list | None = None,
):
    trip = _trip_model(visibility, title=title, days=days, sections=sections)
    monkeypatch.setattr(
        chat_module,
        "get_trip_by_id",
        lambda trip_id: (trip if trip_id == TRIP else None),
    )
    return trip


def _responses_sse(lines_spec: list[tuple[str, str]]) -> str:
    """Build a Responses-API SSE body: (event, json-payload) pairs → lines."""
    return "\n".join(
        f"event: {event}\ndata: {payload}"
        for event, payload in lines_spec
    )


def _runs_sse(events: list[dict]) -> str:
    """Build a Runs-API event feed: the event name travels in the payload."""
    return "\n\n".join(f"data: {json.dumps(event)}" for event in events)


RIDEALONG_RUN = "run_0123456789abcdef0123456789abcdef"


def _fake_run(
    monkeypatch: pytest.MonkeyPatch,
    lines: str,
    *,
    run_id: str = RIDEALONG_RUN,
    status: str = "completed",
    replayed: bool = False,
    gone: bool = False,
    delay: float = 0.0,
):
    """Stand in for the four Runs-API IO seams (admission + feed + status + stop).

    ``admissions`` counts upstream submissions, which is how a test proves the
    #217 promise that re-attaching (or retrying) a turn does NOT start the
    work twice. ``delay`` stalls the feed after its first event, so a test can
    observe an idle-but-live attachment (keepalives).
    """
    state: dict = {"admissions": 0, "bodies": [], "session_keys": [], "stops": 0}

    async def _start(body: dict, *, session_key=None, idempotency_key=None):
        state["admissions"] += 1
        state["bodies"].append(body)
        state["session_keys"].append(session_key)
        state["idempotency_key"] = idempotency_key
        return {"run_id": run_id, "status": "running", "replayed": replayed}

    async def _events(feed_run_id: str, *, session_key=None):
        if gone:
            raise chat_module.RunGone(feed_run_id)
        for index, line in enumerate(lines.splitlines()):
            if delay and index == 1:
                await asyncio.sleep(delay)
            yield line

    async def _status(run_id_: str, *, session_key=None):
        if gone:
            raise chat_module.RunGone(run_id_)
        return {"run_id": run_id_, "status": status, "output": "final text"}

    async def _stop(run_id_: str, *, session_key=None):
        state["stops"] += 1
        return {"run_id": run_id_, "status": "cancelled"}

    monkeypatch.setattr(chat_module, "start_chat_run", _start)
    monkeypatch.setattr(chat_module, "stream_run_events", _events)
    monkeypatch.setattr(chat_module, "fetch_run_status", _status)
    monkeypatch.setattr(chat_module, "stop_chat_run", _stop)
    # /api/chat/stop holds its own reference to the stop helper
    monkeypatch.setattr(main_module, "stop_chat_run", _stop, raising=False)
    return state


def _payloads(text: str) -> list[dict]:
    """Decode a relayed v1 body: every ``data:`` frame except ``[DONE]``."""
    frames = [frame for frame in text.split("\n\n") if frame.strip()]
    assert frames[-1] == "data: [DONE]", text
    payloads = []
    for frame in frames[:-1]:
        if frame.startswith(":"):
            continue  # SSE comment (keepalive) — not a message frame
        assert frame.startswith("data: "), frame
        payloads.append(json.loads(frame[len("data: "):]))
    return payloads


# ------------------------------------------------------------------ identity


def test_user_token_resolves_own_sub(client, rsa_keypair) -> None:
    """Mode 1: a real end-user token IS the actor — no act-as header needed."""
    from app.acl import resolve_request_actor_sub

    token = _user_token(rsa_keypair, sub=USER_SUB)
    user = auth_module._validator.validate(token)
    assert resolve_request_actor_sub(user) == USER_SUB


def test_m2m_with_act_as_header_uses_header_sub(
    client, rsa_keypair, monkeypatch
) -> None:
    """Mode 2: sanctioned M2M token + X-Act-As-Sub header → header sub."""
    from app.acl import resolve_request_actor_sub

    token = _user_token(rsa_keypair, m2m=True)
    user = auth_module._validator.validate(token)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "google-oauth2|pin-user")
    # header wins over the static pin (per-request identity, #9)
    assert (
        resolve_request_actor_sub(user, x_act_as_sub=OTHER_SUB)
        == OTHER_SUB
    )


def test_m2m_no_act_as_falls_back_to_pin(client, rsa_keypair, monkeypatch) -> None:
    from app.acl import resolve_request_actor_sub

    token = _user_token(rsa_keypair, m2m=True)
    user = auth_module._validator.validate(token)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "google-oauth2|pin-user")
    assert resolve_request_actor_sub(user) == "google-oauth2|pin-user"


def test_m2m_no_act_as_no_pin_raises(client, rsa_keypair) -> None:
    """A bare M2M token with no act-as anywhere has no user identity → 401."""
    from fastapi import HTTPException

    from app.acl import resolve_request_actor_sub

    token = _user_token(rsa_keypair, m2m=True)
    user = auth_module._validator.validate(token)
    with pytest.raises(HTTPException) as exc:
        resolve_request_actor_sub(user)
    assert exc.value.status_code == 401


# ------------------------------------------------------------------ /api/chat


def test_chat_streams_text_deltas(client, rsa_keypair, monkeypatch) -> None:
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    _fake_run(
        monkeypatch,
        _runs_sse([
            {"event": "run.started", "status": "running"},
            {"event": "message.delta", "delta": "Hel"},
            {"event": "message.delta", "delta": "lo"},
            # terminal carries the full output — the relay must NOT re-emit it
            {"event": "run.completed", "status": "completed", "output": "Hello"},
        ]),
    )
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "messages": [{"role": "user", "content": "Summarize day 1"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    # Wire SHAPE, not just containment (the v0.24.0 regression: a fresh
    # one-shot translator per upstream line spammed spurious terminal chunks
    # BEFORE the text — the SPA transport stops at the terminal chunk, so
    # nothing rendered). The SPA requires: text first, exactly one finish,
    # SSE framing throughout.
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.headers["x-vercel-ai-ui-message-stream"] == "v1"
    text = resp.text
    assert text.rstrip("\n").endswith("data: [DONE]")
    raw_events = [e for e in text.split("\n\n") if e.strip()]
    assert raw_events[-1] == "data: [DONE]"
    for event in raw_events[:-1]:
        assert event.startswith("data: "), f"not an SSE data event: {event!r}"
    payloads = [json.loads(e[len("data: "):]) for e in raw_events[:-1]]
    assert payloads, "no SSE events in the body"
    # first event opens the text part — nothing terminal before the text
    assert payloads[0]["type"] == "text-start", payloads[0]
    turn_id = payloads[0]["id"]
    deltas = [
        p["delta"] for p in payloads if p["type"] == "text-delta"
    ]
    assert deltas == ["Hel", "lo"], payloads
    assert all(
        p["id"] == turn_id
        for p in payloads
        if p["type"] in ("text-start", "text-delta", "text-end")
    )
    assert payloads[-2] == {"type": "text-end", "id": turn_id}
    finishes = [p for p in payloads if p["type"] == "finish"]
    assert len(finishes) == 1, payloads
    assert finishes[0].get("finishReason") == "stop"
    assert payloads[-1]["type"] == "finish"


def test_chat_forwards_only_new_input_with_scoped_session(
    client, rsa_keypair, monkeypatch
) -> None:
    """Runs API: only the LAST user message + per-actor session + identity
    instructions reach the upstream (history chains agent-side)."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    token = _user_token(rsa_keypair, sub=OTHER_SUB)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "turnKey": "turn-only-new-input",
            "messages": [
                {"role": "user", "content": "earlier turn"},
                {"role": "assistant", "content": "earlier reply"},
                {"role": "user", "content": "now this"},
            ],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = state["bodies"][0]
    # only the new message goes upstream
    assert body["input"] == [{"role": "user", "content": "now this"}]
    # session scoped per actor + trip (the Runs API's chaining handle; the
    # Responses API called the same thing ``conversation``)
    assert body["session_id"] == f"{OTHER_SUB}::trip:{TRIP}"
    # identity rides as instructions, not a stored history message
    assert OTHER_SUB in body["instructions"]
    # full history is NOT sent — only the new message (agent-side chaining)
    assert "conversation_history" not in body
    assert "stream" not in body
    # X-Hermes-Session-Key carries the ACTING sub → per-user session recall
    assert state["session_keys"][0] == OTHER_SUB
    # the turn key doubles as the upstream Idempotency-Key (#217), derived
    # server-side from the acting user — a client can never address another
    # user's turn
    assert state["idempotency_key"] == chat_module.turn_key_for(
        OTHER_SUB, trip_id=TRIP, thread_id=None, turn_key="turn-only-new-input"
    )


def test_chat_conversation_isolation_between_users(client, rsa_keypair, monkeypatch) -> None:
    """Two users on the same trip get DIFFERENT conversation names."""
    from app.chat import conversation_id_for

    assert (
        conversation_id_for(USER_SUB, TRIP)
        != conversation_id_for(OTHER_SUB, TRIP)
    )
    # same user + same trip is stable across turns (chaining)
    assert (
        conversation_id_for(USER_SUB, TRIP)
        == conversation_id_for(USER_SUB, TRIP)
    )


def test_thread_id_is_unit_of_conversation(client, rsa_keypair, monkeypatch) -> None:
    """threadId names the conversation within ONE actor — never across actors.

    The Runs API gives the body's session_id precedence over the
    X-Hermes-Session-Key header and never rebinds a declared session, so a
    bare thread:<id> would chain any caller onto whoever created it first
    (hit 2026-09-18: a fresh user inherited Niko's whole session through a
    shared localStorage thread id). The session name is therefore
    actor-scoped: same thread id under two subs is two sessions.
    """
    from app.chat import conversation_id_for

    thread_a, thread_b = "t-a-0001", "t-b-0002"
    # two threads on the SAME trip are distinct conversations
    assert (
        conversation_id_for(USER_SUB, TRIP, thread_a)
        != conversation_id_for(USER_SUB, TRIP, thread_b)
    )
    # a thread started unanchored …
    unanchored = conversation_id_for(USER_SUB, None, thread_a)
    # … keeps the SAME conversation id once a trip is attached (history chains)
    assert unanchored == conversation_id_for(USER_SUB, TRIP, thread_a)
    # the actor IS in the name — same thread id, different users, no sharing
    assert unanchored == f"{USER_SUB}::thread:{thread_a}"
    assert (
        conversation_id_for(USER_SUB, TRIP, thread_a)
        != conversation_id_for(OTHER_SUB, TRIP, thread_a)
    )
    assert conversation_id_for(OTHER_SUB, TRIP, thread_a) == (
        f"{OTHER_SUB}::thread:{thread_a}"
    )
    # but DIFFERENT users with no threadId do NOT share the legacy
    # fallback (that path stays sub-scoped)
    assert (
        conversation_id_for(USER_SUB, TRIP)
        != conversation_id_for(OTHER_SUB, TRIP)
    )


def test_chat_instructions_pin_the_acting_user_for_every_call(
    client, rsa_keypair, monkeypatch
) -> None:
    """The envelope must tell the agent to ACT AS the thread's user.

    The wrapper's credential can act as anyone, so a call with no explicit
    act-as inherits the profile's static pin — which is how a brand-new user
    ended up being shown Niko's trips (2026-09-18).
    """
    _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    state_bodies: list[dict] = []

    async def _start(body, *, session_key=None, idempotency_key=None):
        state_bodies.append(body)
        return {"run_id": RIDEALONG_RUN, "status": "running", "replayed": False}

    monkeypatch.setattr(chat_module, "start_chat_run", _start)
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "what do you know about me"}]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    text = state_bodies[0]["instructions"]
    assert USER_SUB in text
    assert "--act-as" in text
    assert "KISEKI_ACT_AS_SUB" in text
    assert "never work as any other user" in text.lower()
    assert "only ones you may touch or mention" in text.lower()
    state_bodies.clear()
    resp = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hi"}]},
        headers={
            "Authorization": f"Bearer {_user_token(rsa_keypair, sub=OTHER_SUB)}"
        },
    )
    assert resp.status_code == 200
    other = state_bodies[0]["instructions"]
    assert OTHER_SUB in other
    assert USER_SUB not in other


def test_chat_unanchored_thread_forwards_planning_context(
    client, rsa_keypair, monkeypatch
) -> None:
    """No tripId → no ACL gate; the agent is told no trip is anchored and may
    plan a new one (never writes until anchored)."""
    state = _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "threadId": "plan-chile-001",
            "messages": [{"role": "user", "content": "help me plan a Chile trip"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = state["bodies"][0]
    assert body["session_id"] == f"{USER_SUB}::thread:plan-chile-001"
    assert "No trip is anchored" in body["instructions"]
    # no trip ACL consulted: the route never calls require_actor_trip_access
    # when no tripId is present (get_trip_role_for_user stays un-mocked here,
    # and the upstream fake was reached — proving no gate ran first)


# ---------------------------------------------------------------- trip anchor
# #330: the relay KNOWS the trip (it gates on it) and used to never say so —
# the anchor collapsed to a boolean scope sentence, the session name carries
# the trip only on the legacy no-thread path, and the run body has no other
# field. A first message in a trip drawer therefore had nothing to infer from:
# the live case asked in Dutch for restaurants and got "which trip?" back.


def _anchored_post(client, rsa_keypair, monkeypatch, *, focus=None, trip_id=TRIP, thread="anchor-thread-1"):
    """POST a trip-anchored turn and return (response, upstream bodies)."""
    state = _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    payload = {
        "tripId": trip_id,
        "threadId": thread,
        "messages": [{"role": "user", "content": "Kan je ook wat restaurants voorstellen?"}],
    }
    if focus is not None:
        payload["focus"] = focus
    resp = client.post(
        "/api/chat",
        json=payload,
        headers={"Authorization": f"Bearer {_user_token(rsa_keypair)}"},
    )
    return resp, state["bodies"]


def test_chat_instructions_name_the_anchored_trip(
    client, rsa_keypair, monkeypatch
) -> None:
    """The agent is TOLD which trip the thread is anchored to (#330)."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    resp, bodies = _anchored_post(client, rsa_keypair, monkeypatch)
    assert resp.status_code == 200
    text = bodies[0]["instructions"]
    assert TRIP in text
    assert "Chili + Peru — zomer 2027" in text
    # the facts the agent otherwise burns its first calls rediscovering
    assert "stage planned" in text
    assert "2027-07-17 to 2027-08-02" in text
    assert "2 days" in text
    # …and the rule that the answer is never "which trip?"
    assert "never ask the user which trip" in text
    # the payload itself stays message-only (no transcript, no anchor blob)
    assert bodies[0]["input"] == [
        {"role": "user", "content": "Kan je ook wat restaurants voorstellen?"}
    ]


def test_chat_focus_names_the_day_section_and_block(
    client, rsa_keypair, monkeypatch
) -> None:
    """The "ask the agent about this" bridge rides the REQUEST, not the draft.

    #296 shipped the entity context as pre-filled text in the composer, which
    only reaches the agent if the user leaves it intact; #330 makes it an
    anchor, so a rewritten (or empty) message still says what it is about.
    """
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    cases = [
        (
            {"entity": "day", "id": "day-2"},
            ['day 2 of 2 — "Aankomst Santiago"', "2027-07-18", "day id day-2"],
        ),
        (
            {"entity": "section", "id": "sec-1"},
            ['the section "Valle Nevado & de Andes" covering days 1-2', "section id sec-1"],
        ),
        (
            {"entity": "block", "id": "block-9"},
            ['the meal block "Mercado Central" on day 2', "block id block-9"],
        ),
    ]
    for index, (focus, expected) in enumerate(cases):
        resp, bodies = _anchored_post(
            client, rsa_keypair, monkeypatch, focus=focus, thread=f"focus-{index}"
        )
        assert resp.status_code == 200, resp.text
        text = bodies[0]["instructions"]
        for fragment in expected:
            assert fragment in text, (focus, fragment)
        # the trip is still named — the focus adds to the anchor, never
        # replaces it
        assert TRIP in text


def test_chat_focus_with_a_stale_id_is_neutral_not_an_error(
    client, rsa_keypair, monkeypatch
) -> None:
    """A day deleted since the tab loaded must not 422 or fail the turn."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "threadId": "stale-focus-1",
            "focus": {"entity": "day", "id": "deleted-day"},
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={"Authorization": f"Bearer {_user_token(rsa_keypair)}"},
    )
    assert resp.status_code == 200
    text = state["bodies"][0]["instructions"]
    assert "no longer in this trip (id deleted-day)" in text
    assert TRIP in text  # the trip anchor survives a stale focus


def test_chat_rejects_a_malformed_focus(client, rsa_keypair, monkeypatch) -> None:
    """The wire model is strict: entity + id, or nothing at all."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair)
    for focus in ({"entity": "day"}, {"id": "day-1"}, {"entity": "trip", "id": "x"}):
        resp = client.post(
            "/api/chat",
            json={
                "tripId": TRIP,
                "threadId": "bad-focus-1",
                "focus": focus,
                "messages": [{"role": "user", "content": "hi"}],
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422, (focus, resp.text)


def test_focus_is_not_part_of_the_turn_identity(client, rsa_keypair, monkeypatch) -> None:
    """A turn submitted WITH a focus is still addressable without one (#217).

    The SPA's reconnect probe (`getTurnStatus`) sends threadId + turnKey +
    tripId, never the focus — if the focus were part of the turn key, every
    reconnect after an "ask the agent about this" turn would report the turn
    as unknown and re-send the instruction.
    """
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "threadId": "focus-turn-1",
            "turnKey": "turn-focus-1",
            "focus": {"entity": "day", "id": "day-1"},
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert len(state["bodies"]) == 1
    probe = client.get(
        "/api/chat/turn?threadId=focus-turn-1&turnKey=turn-focus-1&tripId=" + TRIP,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert probe.status_code == 200
    assert probe.json()["known"] is True


def test_identity_instructions_name_the_trip_without_the_document() -> None:
    """Callers that skip the gate (unit paths) still get the trip id."""
    text = chat_module.identity_instructions(USER_SUB, TRIP, "t-1", trip=None)
    assert f"has trip id {TRIP}" in text
    assert "never ask the user which trip" in text
    # no document → no quoted title invented for it
    assert '"' not in text.split("has trip id")[1].split("—")[0]


def test_focus_line_fallbacks_and_labels() -> None:
    """Untitled days fall back to their date; a one-day section reads 'day N'."""
    trip = _trip_model(
        days=[
            DayModel(id="d-a", date="2027-07-01"),
            DayModel(id="d-b", date="2027-07-02", title="Skidag"),
        ],
        sections=[SectionModel(id="s-a", title="Aankomst", days=[0, 0])],
    )
    day = chat_module.focus_line(trip, chat_module.ChatFocus(entity="day", id="d-a"))
    assert day == 'day 1 of 2 — "2027-07-01", 2027-07-01 (day id d-a)'
    section = chat_module.focus_line(
        trip, chat_module.ChatFocus(entity="section", id="s-a")
    )
    assert section == 'the section "Aankomst" covering day 1 (section id s-a)'
    assert chat_module.focus_line(trip, None) is None


def test_chat_m2m_act_as_header_reaches_agent(
    client, rsa_keypair, monkeypatch
) -> None:
    _role(monkeypatch, "editor")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    token = _user_token(rsa_keypair, m2m=True)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={
            "Authorization": f"Bearer {token}",
            "X-Act-As-Sub": OTHER_SUB,
        },
    )
    assert resp.status_code == 200
    # M2M + act-as header → session + instructions follow the header sub
    assert state["bodies"][0]["session_id"].startswith(f"{OTHER_SUB}::")
    assert OTHER_SUB in state["bodies"][0]["instructions"]


def test_chat_m2m_without_act_as_is_401(client, rsa_keypair, monkeypatch) -> None:
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair, m2m=True)
    resp = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hi"}]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401


def test_chat_same_thread_id_isolation_between_users(
    client, rsa_keypair, monkeypatch
) -> None:
    """Same threadId, two users → two upstream sessions (2026-09-18).

    The SPA persists thread ids per browser (localStorage, no user
    scoping), so two logins on one machine present the SAME threadId. The
    relay must submit actor-scoped session ids or the second user chains
    onto the first user's Hermes session — history, memory peer and actor.
    """
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(
        monkeypatch,
        _runs_sse([{"event": "run.completed", "status": "completed", "output": ""}]),
    )
    shared_thread = "bcd02c91-3099-471f-8711-e16a03d75a20"
    for sub in (USER_SUB, OTHER_SUB):
        resp = client.post(
            "/api/chat",
            json={
                "threadId": shared_thread,
                "messages": [{"role": "user", "content": "what do you know about me"}],
            },
            headers={"Authorization": f"Bearer {_user_token(rsa_keypair, sub=sub)}"},
        )
        assert resp.status_code == 200
    assert state["admissions"] == 2
    sessions = [body["session_id"] for body in state["bodies"]]
    assert sessions[0] != sessions[1]
    assert sessions[0] == f"{USER_SUB}::thread:{shared_thread}"
    assert sessions[1] == f"{OTHER_SUB}::thread:{shared_thread}"
    assert state["session_keys"] == [USER_SUB, OTHER_SUB]


def test_chat_no_user_message_is_400(client, rsa_keypair, monkeypatch) -> None:
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "messages": [{"role": "assistant", "content": "only assistant"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400


def test_chat_requires_role_on_private_trip(
    client, rsa_keypair, monkeypatch
) -> None:
    """Chat referencing a private trip is gated like any read (follower+)."""
    _role(monkeypatch, None)  # no crew edge
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_chat_unknown_trip_404(client, rsa_keypair, monkeypatch) -> None:
    _fake_trip(monkeypatch)
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": "00000000-0000-0000-0000-000000000000",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


# ------------------------------------------------------------------ wire fmt


def test_wire_translation_of_responses_stream() -> None:
    body = _responses_sse([
        ("response.created", json.dumps({"type": "response.created"})),
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "Hel"})),
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "lo"})),
        ("response.output_text.done", json.dumps({"type": "response.output_text.done", "text": "Hello"})),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ])
    chunks = list(chat_module.iter_wire_frames(body.splitlines(), part_id="t1"))
    assert chunks == [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "Hel"},
        {"type": "text-delta", "id": "t1", "delta": "lo"},
        {"type": "text-end", "id": "t1"},
        {"type": "finish", "finishReason": "stop"},
    ]


def test_wire_translation_of_failed_stream() -> None:
    body = _responses_sse([
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "partial"})),
        ("response.failed", json.dumps({"type": "response.failed", "error": "boom"})),
    ])
    chunks = list(chat_module.iter_wire_frames(body.splitlines(), part_id="t1"))
    # The open text part is closed before the error chunk (issue #179: an
    # unterminated `text-start` would leave a dangling streaming part).
    assert chunks == [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "partial"},
        {"type": "text-end", "id": "t1"},
        {"type": "error", "errorText": "boom"},
    ]


def test_wire_translation_skips_tool_events() -> None:
    """Non-function_call output items still emit nothing (lifecycle only)."""
    body = _responses_sse([
        ("response.output_item.added", json.dumps({
            "type": "response.output_item.added",
            "item": {"type": "message", "id": "msg_1"},
        })),
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "answer"})),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ])
    chunks = list(chat_module.iter_wire_frames(body.splitlines(), part_id="t1"))
    assert chunks == [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "answer"},
        {"type": "text-end", "id": "t1"},
        {"type": "finish", "finishReason": "stop"},
    ]


def test_wire_translation_function_call_opens_and_closes_activity_row() -> None:
    """A function_call item emits ONE activity part on added (open, spinning)
    and the completing part on done (same id, done=true) — issue #157.

    The wire is `data-*` custom parts, NOT tool-lifecycle chunks: nothing is
    executed client-side, so tool semantics only fought the SDK state
    machine (undeclared-tool parts never rendered, and the turn showed a
    doubled thinking row instead of the activity). The part id is stable
    across open/close so the SDK updates the SAME part in place.
    """
    lines = _responses_sse([
        ("response.output_item.added", json.dumps({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "name": "web_search",
            },
        })),
        ("response.output_item.done", json.dumps({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "name": "web_search",
            },
        })),
        ("response.output_item.added", json.dumps({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "id": "fc_2",
                "name": "totally_unknown_tool",
            },
        })),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ]).splitlines()
    chunks = list(chat_module.iter_wire_frames(lines, part_id="t1"))
    assert chunks == [
        # open: friendly label from the map, done=false (spins)
        {
            "type": "data-kiseki-activity",
            "id": "t1-tool-1",
            "data": {"label": "Searching the web…", "done": False},
        },
        # close: SAME part id, done flips — the row completes in place
        {
            "type": "data-kiseki-activity",
            "id": "t1-tool-1",
            "data": {"label": "Searching the web…", "done": True},
        },
        # unknown tool → generic label, raw name never leaks
        {
            "type": "data-kiseki-activity",
            "id": "t1-tool-2",
            "data": {"label": "Working…", "done": False},
        },
        {"type": "finish", "finishReason": "stop"},
    ]


def test_wire_translation_keepalives_ignored() -> None:
    body = ": keepalive\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}"
    chunks = list(chat_module.iter_wire_frames(body.splitlines(), part_id="t1"))
    assert {"type": "text-delta", "id": "t1", "delta": "x"} in chunks


def test_wire_translation_stream_without_terminal() -> None:
    body = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}'
    chunks = list(chat_module.iter_wire_frames(body.splitlines(), part_id="t1"))
    assert chunks == [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "hi"},
        {"type": "text-end", "id": "t1"},
        # Cut connection (issue #152): no response.completed, so the finish
        # is marked interrupted (via messageMetadata — the SDK persists it
        # onto the assistant message) — the UI offers Reconnect, never a
        # fake completion.
        {
            "type": "finish",
            "finishReason": "stop",
            "messageMetadata": {"interrupted": True},
        },
    ]


def test_wire_translation_completed_stream_is_not_interrupted() -> None:
    """A clean terminal event yields a plain finish (no interrupted flag)."""
    body = _responses_sse([
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "hi"})),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ])
    chunks = list(chat_module.iter_wire_frames(body.splitlines(), part_id="t1"))
    assert chunks[-1] == {"type": "finish", "finishReason": "stop"}


def _finish_count(chunks: list[dict]) -> int:
    return sum(1 for c in chunks if c.get("type") == "finish")


def test_wire_translator_incremental_no_spurious_done_frames() -> None:
    """Feed lines ONE AT A TIME (how the live route consumes the upstream):
    exactly one terminal finish at the end, never mid-stream, never first.

    Regression for the v0.24.0 no-streaming bug: the route called
    ``iter_wire_frames([line])`` — a FRESH one-shot per upstream line — so
    every ``event:``/lifecycle line fell through to the stream-end fallback
    and emitted a spurious terminal chunk. The SPA transport stops at the
    terminal chunk, so a multi-step agent turn (which is full of lifecycle
    lines) rendered nothing at all.
    """
    lines = _responses_sse([
        ("response.created", json.dumps({"type": "response.created"})),
        ("response.output_item.added", json.dumps({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "name": "edit_block"},
        })),
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "Hel"})),
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "lo"})),
        ("response.output_text.done", json.dumps({"type": "response.output_text.done", "text": "Hello"})),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ]).splitlines()

    expected = [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "Hel"},
        {"type": "text-delta", "id": "t1", "delta": "lo"},
        {"type": "text-end", "id": "t1"},
        {"type": "finish", "finishReason": "stop"},
    ]
    # The one-shot wrapper over the whole body still works…
    assert list(chat_module.iter_wire_frames(lines, part_id="t1")) == expected
    # …and the incremental path (feed per line, as the route does) must
    # produce the SAME wire: no terminal before the first text-start, none
    # between.
    t = chat_module.WireTranslator(part_id="t1")
    chunks: list[dict] = []
    for line in lines:
        chunks.extend(t.feed(line))
    chunks.extend(t.finish())
    assert chunks == expected
    assert _finish_count(chunks) == 1


def test_wire_translator_stream_cut_mid_turn_still_terminates() -> None:
    """A dropped connection (no completed event) must still terminate once."""
    lines = _responses_sse([
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "par"})),
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "tial"})),
    ]).splitlines()
    t = chat_module.WireTranslator(part_id="t1")
    chunks: list[dict] = []
    for line in lines:
        chunks.extend(t.feed(line))
    chunks.extend(t.finish())  # upstream closed without response.completed
    assert chunks == [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "par"},
        {"type": "text-delta", "id": "t1", "delta": "tial"},
        {"type": "text-end", "id": "t1"},
        {
            "type": "finish",
            "finishReason": "stop",
            "messageMetadata": {"interrupted": True},
        },
    ]
    assert _finish_count(chunks) == 1


# ------------------------------------------------ credential silence (#158)


def test_wire_translator_rotates_text_part_on_tool_calls() -> None:
    """Issue #179: narration (pre-tool text) and the final answer must land
    in SEPARATE text parts, with the activity parts between them.

    The SDK stores one `text` part per `text-start` id in arrival order —
    one part for the whole turn merged narration + answer into a single
    bubble the end user read as build log ("let me load the skill…", raw
    JSON, HTTP 422). Rotating the part id on each function_call open makes
    the ORDER itself carry the segmentation: text parts before the last
    activity part are narration, the text after it is the answer — and
    `messageFinalText` (frontend/src/lib/chat.ts) renders only the latter.
    """
    lines = _responses_sse([
        # narration, then a tool call
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "Let me check the trip data."})),
        ("response.output_item.added", json.dumps({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc_1", "name": "terminal"},
        })),
        ("response.output_item.done", json.dumps({
            "type": "response.output_item.done",
            "item": {"type": "function_call", "id": "fc_1", "name": "terminal"},
        })),
        # narration round two, then another tool
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "Now the write API."})),
        ("response.output_item.added", json.dumps({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc_2", "name": "edit_trip"},
        })),
        ("response.output_item.done", json.dumps({
            "type": "response.output_item.done",
            "item": {"type": "function_call", "id": "fc_2", "name": "edit_trip"},
        })),
        # the answer
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "Done — trip updated."})),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ]).splitlines()
    chunks = list(chat_module.iter_wire_frames(lines, part_id="t1"))
    assert chunks == [
        # narration segment 1 (closes when the first tool opens)
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "Let me check the trip data."},
        {"type": "text-end", "id": "t1"},
        {"type": "data-kiseki-activity", "id": "t1-tool-1", "data": {"label": "Running a command…", "done": False}},
        {"type": "data-kiseki-activity", "id": "t1-tool-1", "data": {"label": "Running a command…", "done": True}},
        # narration segment 2 (fresh part AFTER the first activity pair)
        {"type": "text-start", "id": "t1-seg1"},
        {"type": "text-delta", "id": "t1-seg1", "delta": "Now the write API."},
        {"type": "text-end", "id": "t1-seg1"},
        {"type": "data-kiseki-activity", "id": "t1-tool-2", "data": {"label": "Working…", "done": False}},
        {"type": "data-kiseki-activity", "id": "t1-tool-2", "data": {"label": "Working…", "done": True}},
        # the answer: the LAST text part, after the LAST activity part
        {"type": "text-start", "id": "t1-seg2"},
        {"type": "text-delta", "id": "t1-seg2", "delta": "Done — trip updated."},
        {"type": "text-end", "id": "t1-seg2"},
        {"type": "finish", "finishReason": "stop"},
    ]
    # the same wire, fed line-by-line (the live route path)
    t = chat_module.WireTranslator(part_id="t1")
    incremental: list[dict] = []
    for line in lines:
        incremental.extend(t.feed(line))
    incremental.extend(t.finish())
    assert incremental == chunks
    assert _finish_count(incremental) == 1


def test_wire_translator_narration_only_turn_terminates_cleanly() -> None:
    """A turn whose stream dies before any tool call keeps the plain
    one-part shape (text-start … text-end on the turn id) — no dangling
    segment ids, one interrupted finish."""
    lines = _responses_sse([
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "par"})),
        ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "tial"})),
    ]).splitlines()
    t = chat_module.WireTranslator(part_id="t1")
    chunks: list[dict] = []
    for line in lines:
        chunks.extend(t.feed(line))
    chunks.extend(t.finish())  # upstream closed without response.completed
    assert chunks == [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "par"},
        {"type": "text-delta", "id": "t1", "delta": "tial"},
        {"type": "text-end", "id": "t1"},
        {
            "type": "finish",
            "finishReason": "stop",
            "messageMetadata": {"interrupted": True},
        },
    ]
    assert _finish_count(chunks) == 1


def test_identity_instructions_carry_credential_silence_rule() -> None:
    """The identity envelope keeps the act-as sub for write calls but
    explicitly forbids narrating credential mechanics (issue #158)."""
    text = chat_module.identity_instructions(OTHER_SUB, TRIP)
    assert OTHER_SUB in text  # the actor-sub line stays (act-as writes need it)
    assert "tokens, M2M, minting, act-as, credentials" in text
    assert "act on their behalf" in text
    # the same rule on the unanchored (no-trip) envelope
    assert (
        "tokens, M2M, minting, act-as, credentials"
        in chat_module.identity_instructions(OTHER_SUB, None)
    )


def test_identity_instructions_forbid_all_plumbing_narration() -> None:
    """Issues #179/#181: the silence rule extends past credentials to every
    internal the chat must not surface — tools, skills, scripts, paths,
    endpoints, HTTP codes, JSON, field names — on BOTH envelope shapes.

    It is a VOCABULARY rule, not a gag on progress. #181 also told the agent
    that step commentary was redundant; live use showed the opposite need (a
    turn that streamed only tool calls left the traveler with no idea what
    happened). The envelope must still ask for traveler-language narration and
    a closing line naming what changed.
    """
    for text in (
        chat_module.identity_instructions(OTHER_SUB, TRIP),
        chat_module.identity_instructions(OTHER_SUB, None),
    ):
        assert "never narrate tools, " in text
        assert "skills, scripts, file paths, endpoints" in text
        assert "HTTP status" in text
        assert "JSON, schemas, or field names" in text
        assert "keep talking to the traveler" in text
        assert "end every turn" in text
        # #158's credential rule must still hold verbatim
        assert "tokens, M2M, minting, act-as, credentials" in text


def test_identity_instructions_unanchored_ask_for_trip_link_on_create() -> None:
    """The unanchored envelope must tell the agent to end a creation turn with
    the new trip's `/t/<id>` link: the landing detects fresh trips from those
    links, and a turn that ends without one leaves the trip invisible until a
    hard refresh."""
    text = chat_module.identity_instructions(OTHER_SUB, None)
    assert "/t/<trip-id>" in text
    # anchored threads already know their trip — the instruction belongs to
    # the unanchored (planning) shape only
    assert "/t/<trip-id>" not in chat_module.identity_instructions(OTHER_SUB, TRIP)


def test_scrub_jwt_redacts_complete_tokens() -> None:
    jwt = (
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0."
        "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    )
    assert chat_module.scrub_jwt(f"here {jwt} now") == "here [redacted] now"
    # normal prose is untouched
    assert chat_module.scrub_jwt("no credentials here") == "no credentials here"
    # a bare "eyJ" word (no JWT shape) is not redacted
    assert chat_module.scrub_jwt("the eyJ note") == "the eyJ note"


def test_wire_translator_redacts_token_split_across_deltas() -> None:
    """A token SPLIT across deltas must never stream in fragments: the
    dangling partial JWT is held back, joined with the next delta, then
    redacted as one (issue #158)."""
    lines = _responses_sse([
        ("response.output_text.delta", json.dumps({
            "type": "response.output_text.delta", "delta": "using eyJhbGciOi",
        })),
        ("response.output_text.delta", json.dumps({
            "type": "response.output_text.delta",
            "delta": "JIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-value-01",
        })),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ])
    chunks = list(chat_module.iter_wire_frames(lines.splitlines(), part_id="t1"))
    deltas = [c["delta"] for c in chunks if c["type"] == "text-delta"]
    joined = "".join(deltas)
    assert "eyJ" not in joined
    assert "[redacted]" in joined
    assert joined.startswith("using ")  # surrounding prose streams intact


def test_wire_translator_holds_back_dangling_header_then_streams_prose() -> None:
    """A delta ending in a dangling eyJ-run holds ONLY that tail back; the
    next delta resolves it as natural text — nothing ever streams before
    the join, so no fragment of a would-be token can leak."""
    lines = _responses_sse([
        ("response.output_text.delta", json.dumps({
            "type": "response.output_text.delta", "delta": "I saw eyJ",
        })),
        ("response.output_text.delta", json.dumps({
            "type": "response.output_text.delta", "delta": " in the logs",
        })),
        ("response.completed", json.dumps({"type": "response.completed"})),
    ])
    chunks = list(chat_module.iter_wire_frames(lines.splitlines(), part_id="t1"))
    deltas = [c["delta"] for c in chunks if c["type"] == "text-delta"]
    assert deltas[0] == "I saw "  # the eyJ tail was held back, not streamed
    assert "".join(deltas) == "I saw eyJ in the logs"


def test_wire_translator_cut_stream_redacts_held_token_fragment() -> None:
    """Cut stream with a held-back fragment: the fragment is redacted, not
    flushed — the stream may have been cut mid-token (issue #158)."""
    lines = _responses_sse([
        ("response.output_text.delta", json.dumps({
            "type": "response.output_text.delta", "delta": "token: eyJhbGciOi",
        })),
    ])
    t = chat_module.WireTranslator(part_id="t1")
    chunks: list[dict] = []
    for line in lines.splitlines():
        chunks.extend(t.feed(line))
    chunks.extend(t.finish())
    deltas = [c["delta"] for c in chunks if c["type"] == "text-delta"]
    assert deltas == ["token: ", "[redacted]"]
    assert chunks[-1]["messageMetadata"] == {"interrupted": True}


def test_chat_stream_never_carries_eyJ(client, rsa_keypair, monkeypatch) -> None:
    """End-to-end: no ``eyJ…`` token material can stream through the relay
    to the UI (issue #158 acceptance — fake JWT in a text delta)."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    fake_jwt = (
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0cmlwLWFnaWVudCJ9.AAAA-bbbb_cccc_dddd"
    )
    _fake_run(
        monkeypatch,
        _runs_sse([
            {"event": "message.delta", "delta": f"working {fake_jwt} on it"},
            {"event": "run.completed", "status": "completed", "output": "done"},
        ]),
    )
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert "eyJ" not in resp.text
    assert "[redacted]" in resp.text


# ------------------------------------------ resumable turns (#217)
# The complaint these cover: "the connection almost never survives to the end;
# reconnecting shows an error with Try again and risks doing the trip twice."
# The fix: a turn is a RELAY-side object (registry + frame buffer), so a repeat
# request with the same turnKey attaches instead of re-submitting — the agent's
# work continues whether or not a browser is watching, and output resumes
# exactly at the frame the UI already rendered.

TURN_FEED = [
    {"event": "message.delta", "delta": "Hel"},
    {"event": "message.delta", "delta": "lo"},
    {"event": "run.completed", "status": "completed", "output": "Hello"},
]


def _chat(client, token, *, turn_key=None, cursor=None, thread_id=None):
    payload: dict = {"tripId": TRIP, "messages": [{"role": "user", "content": "hi"}]}
    if turn_key is not None:
        payload["turnKey"] = turn_key
    if cursor is not None:
        payload["cursor"] = cursor
    if thread_id is not None:
        payload["threadId"] = thread_id
    return client.post(
        "/api/chat", json=payload, headers={"Authorization": f"Bearer {token}"}
    )


def test_chat_reattach_after_drop_replays_only_the_gap(
    client, rsa_keypair, monkeypatch
) -> None:
    """#217 core: resuming replays the unseen frames and NEVER re-runs the turn."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    first = _chat(client, token, turn_key="turn-drop-1")
    assert first.status_code == 200
    whole = _payloads(first.text)
    assert [c["type"] for c in whole] == [
        "text-start", "text-delta", "text-delta", "text-end", "finish",
    ]
    assert state["admissions"] == 1

    # the browser died after rendering 2 frames → it reconnects at cursor 2
    again = _chat(client, token, turn_key="turn-drop-1", cursor=2)
    assert again.status_code == 200
    gap = _payloads(again.text)
    assert [c["type"] for c in gap] == ["text-delta", "text-end", "finish"]
    assert gap[0]["delta"] == "lo"
    # the same text part id: the UI continues ONE assistant message, it does
    # not open a second one
    assert whole[0]["id"] == whole[1]["id"]
    # no second upstream submission — re-attaching is free, not a re-send
    assert state["admissions"] == 1


def test_chat_late_attach_to_a_settled_turn_replays_it(
    client, rsa_keypair, monkeypatch
) -> None:
    """Opening a thread whose turn already finished still gets the frames."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    assert _chat(client, token, turn_key="turn-settled-1").status_code == 200
    late = _chat(client, token, turn_key="turn-settled-1")
    assert late.status_code == 200
    # identical replay, still no re-submission
    assert _payloads(late.text) == _payloads(
        _chat(client, token, turn_key="turn-settled-1").text
    )
    assert state["admissions"] == 1


def test_chat_turn_status_route_reports_how_much_output_exists(
    client, rsa_keypair, monkeypatch
) -> None:
    """The route the SPA polls after a drop (and on thread open): never starts work."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    assert _chat(client, token, turn_key="turn-status-1").status_code == 200
    resp = client.get(
        f"/api/chat/turn?turnKey=turn-status-1&tripId={TRIP}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["known"] is True
    assert body["done"] is True
    assert body["status"] == "settled"
    assert body["cursor"] == 5  # frames the UI can render, and resume past
    assert body["runId"] == RIDEALONG_RUN
    # polling is read-only: it never admitted another run
    assert state["admissions"] == 1


def test_chat_turn_status_unknown_turn_is_not_an_error(
    client, rsa_keypair, monkeypatch
) -> None:
    """A turn the relay doesn't have (relay restarted, or stale key) → known: false."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair)
    resp = client.get(
        f"/api/chat/turn?turnKey=never-existed&tripId={TRIP}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"known": False}


def test_chat_turn_status_finds_a_threads_turn_without_the_key(
    client, rsa_keypair, monkeypatch
) -> None:
    """A client OPENING a thread names it by threadId alone (#217).

    That is the second way into the route, and the one the SPA has: a thread
    that comes back to a turn it was mid-way through must be able to ask "is my
    turn still there?" without holding the key, and the answer has to carry the
    key so it can attach.
    """
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    assert (
        _chat(
            client,
            token,
            turn_key="turn-thread-1",
            thread_id="thread-open",
        ).status_code
        == 200
    )
    resp = client.get(
        f"/api/chat/turn?threadId=thread-open&tripId={TRIP}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["known"] is True
    assert body["turnKey"] == "turn-thread-1"  # adoptable by a client that lost it
    assert body["cursor"] == 5
    assert body["done"] is True
    assert state["admissions"] == 1  # asking never starts work


def test_chat_turn_status_reports_the_key_it_minted_for_an_old_wire_turn(
    client, rsa_keypair, monkeypatch
) -> None:
    """An older SPA bundle sends no turnKey; the relay's own key comes back.

    Nothing about the probe depends on the client having minted the key: the
    turn is registered against its conversation, and the reply hands back what
    the relay called it.
    """
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    assert _chat(client, token, thread_id="thread-legacy").status_code == 200
    resp = client.get(
        f"/api/chat/turn?threadId=thread-legacy&tripId={TRIP}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["known"] is True
    assert body["turnKey"]


def test_chat_turn_status_finds_a_turn_submitted_before_the_trip_existed(
    client, rsa_keypair, monkeypatch
) -> None:
    """The landing chat's turn stays findable once its thread shows a trip.

    A turn submitted from the landing page has no anchor, and the anchor is
    part of the turn key — so the probe has to look in the unanchored scope
    too, or resuming a "create me a trip" turn that the agent turned into a
    trip would never find it.
    """
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    resp = client.post(
        "/api/chat",
        json={
            "threadId": "thread-landing",
            "turnKey": "turn-landing-1",
            "messages": [{"role": "user", "content": "plan me a trip"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200

    probe = client.get(
        f"/api/chat/turn?threadId=thread-landing&tripId={TRIP}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert probe.status_code == 200
    assert probe.json()["known"] is True
    assert probe.json()["turnKey"] == "turn-landing-1"


def test_chat_turn_status_needs_a_turn_or_a_thread(
    client, rsa_keypair, monkeypatch
) -> None:
    """Asking nothing is a bad request, not a confident "no turn"."""
    _role(monkeypatch, "owner")
    token = _user_token(rsa_keypair)

    resp = client.get(
        "/api/chat/turn", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 400


def test_chat_thread_lookup_is_scoped_to_the_acting_user(
    client, rsa_keypair, monkeypatch
) -> None:
    """Opening a thread must never reveal another user's turn."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    mine = _user_token(rsa_keypair)
    theirs = _user_token(rsa_keypair, sub=OTHER_SUB)

    assert (
        _chat(client, mine, turn_key="turn-mine", thread_id="thread-shared").status_code
        == 200
    )
    resp = client.get(
        f"/api/chat/turn?threadId=thread-shared&tripId={TRIP}",
        headers={"Authorization": f"Bearer {theirs}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"known": False}


def test_chat_thread_probe_answers_for_the_latest_turn(
    client, rsa_keypair, monkeypatch
) -> None:
    """Two turns in one thread: the probe reports the newer one."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    assert (
        _chat(client, token, turn_key="turn-first", thread_id="thread-two").status_code
        == 200
    )
    assert (
        _chat(client, token, turn_key="turn-second", thread_id="thread-two").status_code
        == 200
    )
    resp = client.get(
        f"/api/chat/turn?threadId=thread-two&tripId={TRIP}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.json()["turnKey"] == "turn-second"


def test_chat_sweep_forgets_a_threads_expired_turn(
    client, rsa_keypair, monkeypatch
) -> None:
    """The index must not keep pointing at a turn the TTL dropped."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair)
    scope = chat_module.thread_scope(USER_SUB, trip_id=TRIP, thread_id="thread-aged")
    assert scope is not None
    key = chat_module.turn_key_for(
        USER_SUB, trip_id=TRIP, thread_id="thread-aged", turn_key="turn-aged"
    )
    chat_module._TURNS[key] = chat_module.Turn(
        key=key,
        run_id=RIDEALONG_RUN,
        turn_key="turn-aged",
        status="settled",
        done=True,
        created_at=time.monotonic() - chat_module.TURN_TTL_SECONDS - 1,
    )
    chat_module._THREAD_TURNS[scope] = key
    try:
        resp = client.get(
            f"/api/chat/turn?threadId=thread-aged&tripId={TRIP}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.json() == {"known": False}
        assert scope not in chat_module._THREAD_TURNS
    finally:
        chat_module._TURNS.pop(key, None)
        chat_module._THREAD_TURNS.pop(scope, None)


def test_chat_stop_interrupts_the_upstream_run(
    client, rsa_keypair, monkeypatch
) -> None:
    """Stop is now the ONLY way to end a turn early (closing the tab no longer does)."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    key = chat_module.turn_key_for(
        USER_SUB, trip_id=TRIP, thread_id=None, turn_key="turn-stop-1"
    )
    # what a live mid-turn registry entry looks like
    chat_module._TURNS[key] = chat_module.Turn(
        key=key, run_id=RIDEALONG_RUN, session_key=USER_SUB, status="running"
    )
    try:
        resp = client.post(
            "/api/chat/stop",
            json={"turnKey": "turn-stop-1", "tripId": TRIP},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["stopped"] is True
        assert resp.json()["runId"] == RIDEALONG_RUN
        assert state["stops"] == 1
    finally:
        chat_module._TURNS.pop(key, None)


def test_chat_stop_unknown_turn_is_404(client, rsa_keypair, monkeypatch) -> None:
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat/stop",
        json={"turnKey": "never-existed", "tripId": TRIP},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


def test_chat_turn_key_is_scoped_to_the_acting_user(
    client, rsa_keypair, monkeypatch
) -> None:
    """A client-supplied turnKey can never address someone else's turn."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))

    # user A starts turnKey "shared-name" on the trip
    assert _chat(client, _user_token(rsa_keypair), turn_key="shared-name").status_code == 200
    # user B sends the SAME turnKey: it is a different turn (its own run)
    assert (
        _chat(
            client, _user_token(rsa_keypair, sub=OTHER_SUB), turn_key="shared-name"
        ).status_code
        == 200
    )
    assert state["admissions"] == 2
    assert state["session_keys"][0] == USER_SUB
    assert state["session_keys"][1] == OTHER_SUB

    # …and B cannot read A's turn through the status route either
    b_key = chat_module.turn_key_for(
        OTHER_SUB, trip_id=TRIP, thread_id=None, turn_key="shared-name"
    )
    a_key = chat_module.turn_key_for(
        USER_SUB, trip_id=TRIP, thread_id=None, turn_key="shared-name"
    )
    assert a_key != b_key

    # a turn is also scoped per thread: same key, other thread = other turn
    assert (
        _chat(client, _user_token(rsa_keypair), turn_key="shared-name", thread_id="t-x")
        .status_code
        == 200
    )
    assert state["admissions"] == 3


def test_chat_legacy_request_without_turn_key_is_still_relay_owned(
    client, rsa_keypair, monkeypatch
) -> None:
    """An older SPA bundle (no turnKey) keeps working — the relay mints the key."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))
    token = _user_token(rsa_keypair)

    resp = _chat(client, token)
    assert resp.status_code == 200
    assert [c["type"] for c in _payloads(resp.text)][-1] == "finish"
    assert state["admissions"] == 1
    # two legacy turns never collide (each gets a fresh minted key)
    assert _chat(client, token).status_code == 200
    assert state["admissions"] == 2


def test_chat_idle_attach_keeps_the_connection_alive(
    client, rsa_keypair, monkeypatch
) -> None:
    """A quiet agent (long tool call) must not look like a dead connection:
    idle attachments emit SSE comment keepalives."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    monkeypatch.setattr(chat_module, "ATTACH_KEEPALIVE_SECONDS", 0.05)
    # first event flows, then the feed stalls (the model is thinking)
    _fake_run(monkeypatch, _runs_sse(TURN_FEED), delay=0.3)
    token = _user_token(rsa_keypair)

    resp = _chat(client, token, turn_key="turn-idle-1")
    assert resp.status_code == 200
    assert ": keepalive" in resp.text
    assert resp.text.rstrip().endswith("data: [DONE]")
    # keepalives are comments: they never become a message frame
    assert [c["type"] for c in _payloads(resp.text)][-1] == "finish"


def test_turn_completes_with_no_client_attached(monkeypatch) -> None:
    """The production invariant behind #217: the work belongs to the relay's
    pump, so a turn finishes even when nobody is watching (tab closed)."""
    state = _fake_run(monkeypatch, _runs_sse(TURN_FEED))

    async def _drive() -> chat_module.Turn:
        key = chat_module.turn_key_for(
            USER_SUB, trip_id=None, thread_id="solo", turn_key="turn-solo-1"
        )
        chat_module._TURNS.pop(key, None)
        turn = await chat_module.start_turn(
            key, body={"session_id": "thread:solo"}, session_key=USER_SUB
        )
        for _ in range(300):  # no waiter is ever registered
            if turn.done:
                break
            await asyncio.sleep(0.01)
        chat_module._TURNS.pop(key, None)
        return turn

    turn = asyncio.run(_drive())
    assert turn.done is True, "the turn never settled with no client attached"
    assert [c["type"] for c in turn.frames] == [
        "text-start", "text-delta", "text-delta", "text-end", "finish",
    ]
    assert "".join(
        c.get("delta", "") for c in turn.frames if c["type"] == "text-delta"
    ) == "Hello"
    assert state["admissions"] == 1


def test_turn_feed_lost_after_admission_settles_as_an_error(monkeypatch) -> None:
    """If the upstream run vanishes mid-turn, the buffer must not just stop:
    the caller gets an explicit error chunk (#217)."""
    _fake_run(monkeypatch, "", gone=True)

    async def _drive() -> chat_module.Turn:
        key = chat_module.turn_key_for(
            USER_SUB, trip_id=None, thread_id="gone", turn_key="turn-gone-1"
        )
        chat_module._TURNS.pop(key, None)
        turn = await chat_module.start_turn(
            key, body={"session_id": "thread:gone"}, session_key=USER_SUB
        )
        for _ in range(300):
            if turn.done:
                break
            await asyncio.sleep(0.01)
        chat_module._TURNS.pop(key, None)
        return turn

    turn = asyncio.run(_drive())
    assert turn.done is True
    assert turn.frames[-1]["type"] == "error"
    assert turn.frames[-1]["errorText"]


# ------------------------------------------------------------------ dialect
# The Runs API carries the event name INSIDE the payload (``{"event": …}``)
# and streams ``message.delta``; the Responses API used a separate ``event:``
# line. The relay's translator accepts both on one wire during the migration —
# these lock the runs dialect (schema verified against api_server_runs.py).


def test_wire_translation_of_runs_text_stream() -> None:
    """``message.delta`` → delta/snapshot/tool/traceframe as before."""
    translator = chat_module.WireTranslator()
    chunks = []
    for line in _runs_sse(TURN_FEED).splitlines():
        chunks.extend(translator.feed(line))
    assert [c["type"] for c in chunks] == [
        "text-start", "text-delta", "text-delta", "text-end", "finish",
    ]
    assert "".join(c.get("delta", "") for c in chunks) == "Hello"
    assert translator._done is True


def test_wire_translation_of_runs_tool_activity() -> None:
    """``tool.started``/``tool.completed`` become the UI's activity rows.

    The runs feed names the tool but carries no call id, so rows are paired
    FIFO by name and the raw tool name never travels to the client.
    """
    translator = chat_module.WireTranslator()
    chunks = []
    for line in _runs_sse([
        {"event": "tool.started", "tool": "trip_get", "preview": "trip 42"},
        {"event": "message.delta", "delta": "thinking…"},
        {"event": "tool.completed", "tool": "trip_get"},
        {"event": "run.completed", "status": "completed", "output": "thinking…"},
    ]).splitlines():
        chunks.extend(translator.feed(line))
    rows = [c for c in chunks if c["type"] == "data-kiseki-activity"]
    assert [row["data"]["done"] for row in rows] == [False, True]
    assert rows[0]["id"] == rows[1]["id"]  # same row, opened then closed
    assert "trip_get" not in json.dumps(chunks)  # raw tool name stays server-side
    assert chunks[-1]["type"] == "finish"
    # the row closed before the turn ended, and the text part resumed after it
    assert rows[1] is not chunks[-1]
    assert [c["type"] for c in chunks if c["type"] == "text-start"] == ["text-start"]


def test_wire_translation_of_runs_failure() -> None:
    """``run.failed`` → a terminal error chunk, not a silent truncation."""
    translator = chat_module.WireTranslator()
    chunks = []
    for line in _runs_sse([
        {"event": "message.delta", "delta": "half an ans"},
        {"event": "run.failed", "status": "failed", "error": "provider exploded"},
    ]).splitlines():
        chunks.extend(translator.feed(line))
    assert chunks[-1]["type"] == "error"
    assert "provider exploded" in chunks[-1]["errorText"]
    assert translator._done is True


def test_wire_translation_of_runs_interrupt_keeps_reconnect_marker() -> None:
    """A turn cut off upstream (``run.interrupted``) still tells the UI it can
    reconnect — which is now a cheap attach, not a re-send."""
    translator = chat_module.WireTranslator()
    chunks = []
    for line in _runs_sse([
        {"event": "message.delta", "delta": "partial"},
        {"event": "run.interrupted", "status": "interrupted"},
    ]).splitlines():
        chunks.extend(translator.feed(line))
    assert chunks[-1]["type"] == "finish"
    assert chunks[-1]["messageMetadata"] == {"interrupted": True}


# ------------------------------------------------------------------ /api/files


def test_files_uploads_to_media_namespace(
    client, rsa_keypair, monkeypatch, tmp_path
) -> None:
    _role(monkeypatch, "editor")
    _fake_trip(monkeypatch, visibility="private")
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    try:
        token = _user_token(rsa_keypair)
        raw = b"\x89PNG\r\n\x1a\nfake-image-bytes"
        resp = client.post(
            "/api/files",
            data={"trip_id": TRIP},
            files={"file": ("photo.jpg", io.BytesIO(raw), "image/jpeg")},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        url = resp.json()["url"]
        # content-addressed: /media/<trip>/<sha256[:32]>.jpg
        assert url.startswith(f"/media/{TRIP}/")
        assert url.endswith(".jpg")
        expected = hashlib.sha256(raw).hexdigest()[:32]
        assert url.endswith(f"/{expected}.jpg")
        # bytes actually stored (LocalMediaStore)
        stored = (tmp_path / url.replace("/media/", "")).read_bytes()
        assert stored == raw
    finally:
        media_module.clear_media_store()


def test_files_requires_editor(client, rsa_keypair, monkeypatch) -> None:
    _role(monkeypatch, "follower")  # below editor
    _fake_trip(monkeypatch, visibility="private")
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/files",
        data={"trip_id": TRIP},
        files={"file": ("a.txt", io.BytesIO(b"hi"), "text/plain")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


# ------------------------------------------------------------- inbox + promote


def test_files_uploads_to_inbox_without_trip(
    client, rsa_keypair, monkeypatch, tmp_path
) -> None:
    """Landing-chat upload: no trip_id → content-addressed inbox URL (no editor gate)."""
    _role(monkeypatch, "follower")  # inbox staging has no trip role to clear
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    try:
        token = _user_token(rsa_keypair)
        raw = b"\x89PNG\r\n\x1a\ninbox-image-bytes"
        resp = client.post(
            "/api/files",
            files={"file": ("photo.jpg", io.BytesIO(raw), "image/jpeg")},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        url = resp.json()["url"]
        expected = hashlib.sha256(raw).hexdigest()[:32]
        assert url == f"/inbox/{expected}.jpg"
        # bytes actually stored under the inbox namespace (LocalMediaStore)
        stored = (tmp_path / "inbox" / f"{expected}.jpg").read_bytes()
        assert stored == raw
        # …and fetchable back over the public /inbox route
        serve = client.get(url)
        assert serve.status_code == 200
        assert serve.content == raw
        assert serve.headers["content-type"] == "image/jpeg"
    finally:
        media_module.clear_media_store()


def test_files_inbox_rejects_traversal(client, rsa_keypair, monkeypatch, tmp_path) -> None:
    """Traversal-shaped inbox names never read the store.

    Only names that actually REACH the route can express traversal, so the
    cases here are the encoded separator and the raw separator: a bare ``..``
    path segment is normalized to ``/`` by any conformant HTTP client (httpx)
    or proxy before routing, so it can never address the inbox route at all —
    asserting 404 on it only tested whether a local SPA build existed to make
    ``/`` answer 200 (it failed in the shared checkout, which has
    ``frontend/dist/``, and passed in a fresh worktree and CI).
    """
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    try:
        for bad in ("..%2Fsecret.jpg", "a/b.jpg", "..%2F..%2Fetc%2Fpasswd", ".hidden"):
            resp = client.get(f"/inbox/{bad}")
            assert resp.status_code == 404, bad
    finally:
        media_module.clear_media_store()


def test_promote_moves_inbox_file_into_trip(
    client, rsa_keypair, monkeypatch, tmp_path
) -> None:
    """Editor+ can promote an inbox file into a trip's media namespace (move)."""
    _role(monkeypatch, "editor")
    _fake_trip(monkeypatch, visibility="private")
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    try:
        token = _user_token(rsa_keypair)
        raw = b"promotable-bytes"
        up = client.post(
            "/api/files",
            files={"file": ("doc.pdf", io.BytesIO(raw), "application/pdf")},
            headers={"Authorization": f"Bearer {token}"},
        )
        inbox_name = up.json()["url"].rsplit("/", 1)[1]
        assert inbox_name.endswith(".pdf")
        prom = client.post(
            "/api/files/promote",
            json={"trip_id": TRIP, "file_name": inbox_name},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert prom.status_code == 200
        assert prom.json()["url"] == f"/media/{TRIP}/{inbox_name}"
        # moved: present under the trip's media key, gone from the inbox
        assert client.get(f"/media/{TRIP}/{inbox_name}").status_code == 200
        assert client.get(f"/inbox/{inbox_name}").status_code == 404
    finally:
        media_module.clear_media_store()


def test_promote_requires_editor(client, rsa_keypair, monkeypatch, tmp_path) -> None:
    _role(monkeypatch, "follower")  # below editor
    _fake_trip(monkeypatch, visibility="private")
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    try:
        token = _user_token(rsa_keypair)
        resp = client.post(
            "/api/files/promote",
            json={"trip_id": TRIP, "file_name": "abcd.jpg"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403
    finally:
        media_module.clear_media_store()


def test_promote_missing_inbox_file_404s(
    client, rsa_keypair, monkeypatch, tmp_path
) -> None:
    _role(monkeypatch, "editor")
    _fake_trip(monkeypatch, visibility="private")
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    try:
        token = _user_token(rsa_keypair)
        resp = client.post(
            "/api/files/promote",
            json={"trip_id": TRIP, "file_name": "cafebabe.jpg"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 404
    finally:
        media_module.clear_media_store()


# ------------------------------------------------------------------ regression


def test_claims_still_refuse_m2m(client, rsa_keypair) -> None:
    """Claims provision graph identity — M2M stays 403 (mode 1 only, #142)."""
    token = _user_token(rsa_keypair, m2m=True)
    resp = client.post(
        "/api/claims",
        json={"claimToken": "tkn", "personId": "p1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


class _FakeConfig:
    """Config stand-in pointing the media store at a tmp dir."""

    def __init__(self, root):
        self.KISEKI_S3_ENDPOINT = ""
        self.KISEKI_S3_BUCKET = ""
        self.KISEKI_S3_ACCESS_KEY = ""
        self.KISEKI_S3_SECRET_KEY = ""
        self.KISEKI_S3_REGION = ""
        self.ASSETS_DIR = root
