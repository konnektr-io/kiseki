"""Chat relay + file upload tests (issue #9 / M3).

Covers the M3 acceptance contract:
- identity is bearer-first: end-user token → its own sub (mode 1); sanctioned
  M2M token + X-Act-As-Sub header → that sub (mode 2); M2M with no act-as and
  no pin → 401;
- /api/chat uses the Responses API: only the new user message is forwarded
  with a per-actor (per-trip) `conversation` name + identity `instructions`,
   and the upstream Responses-API SSE stream is translated to Vercel-ai
   UI-message-stream v1 chunks (``data: {…}`` SSE events …
   ``data: [DONE]``);
- /api/chat gates the named trip (follower+ for the ACTING user);
- /api/files stores content-addressed bytes into the trip's media namespace
  and returns the /media URL (editor+ only);
- claims/follow still refuse M2M tokens (regression, #142).
"""

from __future__ import annotations

import hashlib
import io
import json

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app import acl as acl_module
from app import chat as chat_module
from app import main as main_module
from app import media as media_module
from app.auth import Auth0JWTValidator
from app.main import app

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


def _fake_trip(monkeypatch: pytest.MonkeyPatch, visibility: str = "public"):
    class _Trip:
        def __init__(self):
            self.id = TRIP
            self.visibility = visibility
            self.claimToken = "secret"

    monkeypatch.setattr(
        chat_module,
        "get_trip_by_id",
        lambda trip_id: (_Trip() if trip_id == TRIP else None),
    )


def _responses_sse(lines_spec: list[tuple[str, str]]) -> str:
    """Build a Responses-API SSE body: (event, json-payload) pairs → lines."""
    return "\n".join(
        f"event: {event}\ndata: {payload}"
        for event, payload in lines_spec
    )


def _fake_upstream(monkeypatch: pytest.MonkeyPatch, body_lines: str):
    """Point the relay at a canned upstream Responses-API SSE body."""
    async def _fake(body: dict, *, session_key=None):
        for line in body_lines.splitlines():
            yield line

    monkeypatch.setattr(main_module, "fetch_upstream_lines", _fake)


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
    _fake_upstream(
        monkeypatch,
        _responses_sse([
            ("response.created", json.dumps({"type": "response.created"})),
            ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "Hel"})),
            ("response.output_text.delta", json.dumps({"type": "response.output_text.delta", "delta": "lo"})),
            ("response.output_text.done", json.dumps({"type": "response.output_text.done", "text": "Hello"})),
            ("response.completed", json.dumps({"type": "response.completed"})),
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


def test_chat_forwards_only_new_input_with_scoped_conversation(
    client, rsa_keypair, monkeypatch
) -> None:
    """Responses API: only the LAST user message + per-actor conversation +
    identity instructions reach the upstream (history lives server-side)."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    captured: dict = {}

    async def _fake(body: dict, *, session_key=None):
        captured["body"] = body
        captured["session_key"] = session_key
        yield "event: response.completed\ndata: {\"type\":\"response.completed\"}"

    monkeypatch.setattr(main_module, "fetch_upstream_lines", _fake)
    token = _user_token(rsa_keypair, sub=OTHER_SUB)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": TRIP,
            "messages": [
                {"role": "user", "content": "earlier turn"},
                {"role": "assistant", "content": "earlier reply"},
                {"role": "user", "content": "now this"},
            ],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = captured["body"]
    # only the new message goes upstream
    assert len(body["input"]) == 1
    assert body["input"][0]["content"] == "now this"
    # conversation scoped per actor + trip (never a bare client id)
    assert body["conversation"] == f"{OTHER_SUB}::trip:{TRIP}"
    # identity rides as instructions, not a stored history message
    assert OTHER_SUB in body["instructions"]
    # full history is NOT sent — only the new message (server-side chaining)
    assert body["input"] == [{"role": "user", "content": "now this"}]
    assert "conversation_history" not in body
    assert body["stream"] is True
    # X-Hermes-Session-Key carries the ACTING sub → per-user session recall
    assert captured["session_key"] == OTHER_SUB


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
    """threadId (not the sub) names the conversation: multiple threads per
    trip, and an unanchored thread (planning a not-yet-created trip) keeps
    its identity when a trip is anchored later. Per-USER scoping comes from
    the session key / Honcho peer, not the conversation name (Niko)."""
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
    # no sub in the name — thread-scoped only
    assert unanchored == f"thread:{thread_a}"
    # but DIFFERENT users with the same threadId do NOT share the legacy
    # fallback (that path stays sub-scoped)
    assert (
        conversation_id_for(USER_SUB, TRIP)
        != conversation_id_for(OTHER_SUB, TRIP)
    )


def test_chat_unanchored_thread_forwards_planning_context(
    client, rsa_keypair, monkeypatch
) -> None:
    """No tripId → no ACL gate; the agent is told no trip is anchored and may
    plan a new one (never writes until anchored)."""
    captured: dict = {}

    async def _fake(body: dict, *, session_key=None):
        captured["body"] = body
        yield "event: response.completed\ndata: {\"type\":\"response.completed\"}"

    monkeypatch.setattr(main_module, "fetch_upstream_lines", _fake)
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
    body = captured["body"]
    assert body["conversation"] == f"thread:plan-chile-001"
    assert "No trip is anchored" in body["instructions"]
    # no trip ACL consulted: the route never calls require_actor_trip_access
    # when no tripId is present (get_trip_role_for_user stays un-mocked here,
    # and the upstream fake was reached — proving no gate ran first)


def test_chat_m2m_act_as_header_reaches_agent(
    client, rsa_keypair, monkeypatch
) -> None:
    _role(monkeypatch, "editor")
    _fake_trip(monkeypatch, visibility="private")
    captured: dict = {}

    async def _fake(body: dict, *, session_key=None):
        captured["body"] = body
        yield "event: response.completed\ndata: {\"type\":\"response.completed\"}"

    monkeypatch.setattr(main_module, "fetch_upstream_lines", _fake)
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
    # M2M + act-as header → conversation + instructions follow the header sub
    assert captured["body"]["conversation"].startswith(f"{OTHER_SUB}::")
    assert OTHER_SUB in captured["body"]["instructions"]


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
    assert chunks == [
        {"type": "text-start", "id": "t1"},
        {"type": "text-delta", "id": "t1", "delta": "partial"},
        {"type": "error", "errorText": "boom"},
    ]


def test_wire_translation_skips_tool_events() -> None:
    body = _responses_sse([
        ("response.output_item.added", json.dumps({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "name": "edit_block"},
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
    monkeypatch.setattr(media_module, "config", _FakeConfig(tmp_path))
    media_module.clear_media_store()
    try:
        for bad in ("..%2Fsecret.jpg", "a/b.jpg", "..", ".hidden"):
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
