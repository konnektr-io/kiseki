"""Chat session list + transcript resume (issue #309).

The picker's two relay routes, and the pure mapping behind them:

- ``GET /api/chat/sessions`` returns ONLY the acting user's threads. Ownership
  is read from the session id's actor prefix (`{sub}::thread:{id}`), because
  upstream's list is not user-scoped and carries no attribution field — so this
  file's core assertion is that another session key's threads, the profile's
  probe/desktop/cli rows and pre-isolation bare ``thread:`` rows never appear.
- ``GET /api/chat/sessions/{thread_id}/messages`` proxies one thread's stored
  transcript, text-only, and derives the session id from the CALLER (a foreign
  or malformed thread id is a 404, never someone else's history).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import acl as acl_module
from app import auth as auth_module
from app import chat as chat_module
from app import main as main_module
from app.auth import Auth0JWTValidator
from app.main import app

from conftest import CLIENT_ID, TENANT, _claims, _sign

USER_SUB = "google-oauth2|100613034256980569871"
OTHER_SUB = "windowslive|9977bfe9b57ad984"
THREAD = "5a5a0b0f-ef38-482c-91e5-b469f3213d2a"


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", "agent-m2m-client-xyz")
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_ACT_AS", "")
    return TestClient(app)


def _token(rsa_keypair, *, sub: str = USER_SUB) -> str:
    return _sign(rsa_keypair, _claims(sub=sub))


def _session(session_id: str, *, title: str = "A thread", active: float = 100.0, **extra) -> dict:
    row = {
        "id": session_id,
        "source": "api_server",
        "user_id": None,
        "title": title,
        "preview": "preview text",
        "message_count": 12,
        "started_at": active - 60,
        "last_active": active,
        "end_reason": None,
        "archived": False,
        "hidden": False,
    }
    row.update(extra)
    return row


# ------------------------------------------------------------------ pure mapping


def test_picker_keeps_only_the_callers_threads() -> None:
    rows = [
        _session(f"{USER_SUB}::thread:{THREAD}", title="Fix flight LIM-CUZ", active=200),
        _session(f"{OTHER_SUB}::thread:other-1", title="Someone else's planning", active=300),
        _session("thread:legacy-bare", title="Pre-isolation history", active=400),
        _session("run_bc833bb4c693471da5c06c084da4dc93", title="hi #5", active=500),
        _session("20261109_105648_aaf83eee", title="desktop session", active=600),
        _session("probe:model-routes-check", title="Reply with exactly: OK", active=700),
        _session(f"{USER_SUB}::thread:archived-1", title="Archived", active=800, archived=True),
        _session(f"{USER_SUB}::thread:hidden-1", title="Hidden", active=900, hidden=True),
    ]

    got = chat_module.picker_threads(USER_SUB, rows)

    assert [row["threadId"] for row in got["threads"]] == [THREAD]
    assert got["hasMore"] is False
    row = got["threads"][0]
    assert row["title"] == "Fix flight LIM-CUZ"
    assert row["messageCount"] == 12
    assert row["startedAt"] == 140.0
    assert row["lastActiveAt"] == 200.0
    assert row["status"] == "open"


def test_picker_two_session_keys_never_see_each_other() -> None:
    rows = [
        _session(f"{USER_SUB}::thread:mine", active=10),
        _session(f"{OTHER_SUB}::thread:theirs", active=20),
    ]

    mine = chat_module.picker_threads(USER_SUB, rows)
    theirs = chat_module.picker_threads(OTHER_SUB, rows)

    assert [row["threadId"] for row in mine["threads"]] == ["mine"]
    assert [row["threadId"] for row in theirs["threads"]] == ["theirs"]


def test_picker_orders_newest_first_and_marks_reaped_threads() -> None:
    rows = [
        _session(f"{USER_SUB}::thread:old", active=100),
        _session(
            f"{USER_SUB}::thread:new",
            active=300,
            end_reason="ws_orphan_reap",
        ),
        _session(f"{USER_SUB}::thread:mid", active=200, title=""),
    ]

    got = chat_module.picker_threads(USER_SUB, rows)

    assert [row["threadId"] for row in got["threads"]] == ["new", "mid", "old"]
    # A reaped thread is a live row with intact history — listed, and labelled
    # so the SPA can (later) render it differently if it wants to.
    assert got["threads"][0]["status"] == "ws_orphan_reap"
    # An upstream row with no title keeps the empty string; the SPA falls back
    # to its local excerpt rather than showing "null".
    assert got["threads"][1]["title"] == ""


def test_picker_caps_the_page_and_reports_more() -> None:
    rows = [_session(f"{USER_SUB}::thread:t{i}", active=float(i)) for i in range(5)]

    got = chat_module.picker_threads(USER_SUB, rows, limit=3)

    assert len(got["threads"]) == 3
    assert got["hasMore"] is True
    assert [row["threadId"] for row in got["threads"]] == ["t4", "t3", "t2"]


@pytest.mark.parametrize(
    "thread_id",
    ["5a5a0b0f-ef38-482c-91e5-b469f3213d2a", "thread-1792504812-123", "a.b_c-1"],
)
def test_valid_thread_ids(thread_id: str) -> None:
    assert chat_module.is_valid_thread_id(thread_id) is True


@pytest.mark.parametrize(
    "thread_id",
    ["", "a/b", "x::thread:y", "../../etc/passwd", "a b", "a" * 129, None],
)
def test_invalid_thread_ids(thread_id) -> None:
    assert chat_module.is_valid_thread_id(thread_id) is False


# ------------------------------------------------------------------- transcript


def test_transcript_is_text_only_and_merges_one_turn() -> None:
    rows = [
        {"id": 1, "role": "user", "content": "Fix the Banff link"},
        {"id": 2, "role": "assistant", "content": "I'll check it.", "tool_calls": "[…]"},
        {"id": 3, "role": "tool", "content": '{"ok": true}', "tool_name": "terminal"},
        {"id": 4, "role": "assistant", "content": "", "tool_calls": "[…]"},
        {"id": 5, "role": "assistant", "content": "Fixed and verified."},
        {"id": 6, "role": "user", "content": "Thanks"},
    ]

    messages = chat_module.transcript_messages(rows)

    assert [message["role"] for message in messages] == ["user", "assistant", "user"]
    assert messages[0]["parts"] == [{"type": "text", "text": "Fix the Banff link"}]
    # One bubble per turn, exactly like the live stream — not one per model call.
    assert messages[1]["parts"] == [
        {"type": "text", "text": "I'll check it.\n\nFixed and verified."}
    ]
    assert messages[1]["id"] == "hermes-2"


def test_transcript_drops_scaffolding_rows_and_media_parts() -> None:
    rows = [
        {"id": 1, "role": "user", "content": "[System: model changed]", "display_kind": "model_switch"},
        {"id": 2, "role": "user", "content": [{"type": "text", "text": "Look at this"}]},
        {"id": 3, "role": "assistant", "content": [{"text": "Nice photo."}]},
        {"id": 4, "role": "system", "content": "system prompt shall never surface"},
        {"id": 5, "role": "assistant", "content": "   "},
        {"id": 6, "role": "session_meta", "content": None},
    ]

    messages = chat_module.transcript_messages(rows)

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[0]["parts"][0]["text"] == "Look at this"
    assert messages[1]["parts"][0]["text"] == "Nice photo."


def test_transcript_keeps_the_travelers_own_turn() -> None:
    """Live regression: the relay's own user turns are stored with
    ``display_kind="internal_notification"``. Skipping every row that carries a
    display_kind erased the user's half of a restored conversation (verified
    against the kiseki profile, 2026-11-09) — only SCAFFOLDING kinds are
    dropped."""
    rows = [
        {
            "id": 1,
            "role": "user",
            "content": "What code did I ask you to remember?",
            "display_kind": "internal_notification",
        },
        {"id": 2, "role": "assistant", "content": "KISEKI-309-RESUME"},
    ]

    messages = chat_module.transcript_messages(rows)

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[0]["parts"][0]["text"] == "What code did I ask you to remember?"


# ----------------------------------------------------------------------- routes


def test_sessions_route_requires_auth(client: TestClient) -> None:
    assert client.get("/api/chat/sessions").status_code == 401


def test_sessions_route_lists_the_actors_threads(
    client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, object] = {}

    async def _list(actor_sub: str, *, limit: int = 50) -> dict:
        seen["actor"] = actor_sub
        seen["limit"] = limit
        return {
            "threads": [
                {
                    "threadId": THREAD,
                    "title": "Fix flight LIM-CUZ",
                    "preview": "p",
                    "messageCount": 139,
                    "startedAt": 1.0,
                    "lastActiveAt": 2.0,
                    "status": "ws_orphan_reap",
                }
            ],
            "hasMore": False,
        }

    monkeypatch.setattr(main_module, "list_thread_sessions", _list)

    resp = client.get(
        "/api/chat/sessions?limit=7",
        headers={"Authorization": f"Bearer {_token(rsa_keypair)}"},
    )

    assert resp.status_code == 200
    assert resp.json()["threads"][0]["threadId"] == THREAD
    # The ACTOR is the token's sub here (mode 1), never a client-supplied value.
    assert seen == {"actor": USER_SUB, "limit": 7}


def test_sessions_route_uses_the_act_as_sub_for_a_service_credential(
    client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, object] = {}

    async def _list(actor_sub: str, *, limit: int = 50) -> dict:
        seen["actor"] = actor_sub
        return {"threads": [], "hasMore": False}

    monkeypatch.setattr(main_module, "list_thread_sessions", _list)
    monkeypatch.setattr(acl_module, "KISEKI_AGENT_CLIENT_ID", "agent-m2m-client-xyz")
    claims = _claims(sub="agent-m2m-client-xyz")
    claims.update(azp="agent-m2m-client-xyz", gty="client-credentials", aud=CLIENT_ID)
    token = _sign(rsa_keypair, claims)

    resp = client.get(
        "/api/chat/sessions",
        headers={"Authorization": f"Bearer {token}", "X-Act-As-Sub": USER_SUB},
    )

    assert resp.status_code == 200
    assert seen["actor"] == USER_SUB


def test_transcript_route_returns_the_callers_messages(
    client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, object] = {}

    async def _messages(actor_sub: str, thread_id: str) -> list[dict]:
        seen["call"] = (actor_sub, thread_id)
        return [
            {"id": "hermes-1", "role": "user", "parts": [{"type": "text", "text": "hi"}]}
        ]

    monkeypatch.setattr(main_module, "fetch_thread_messages", _messages)

    resp = client.get(
        f"/api/chat/sessions/{THREAD}/messages",
        headers={"Authorization": f"Bearer {_token(rsa_keypair)}"},
    )

    assert resp.status_code == 200
    assert resp.json()["threadId"] == THREAD
    assert resp.json()["messages"][0]["parts"][0]["text"] == "hi"
    assert seen["call"] == (USER_SUB, THREAD)


def test_transcript_route_rejects_a_foreign_or_malformed_thread_id(
    client: TestClient, rsa_keypair
) -> None:
    # Nothing reaches upstream: the id cannot be addressed at all.
    resp = client.get(
        "/api/chat/sessions/..%2F..%2Fetc%2Fpasswd/messages",
        headers={"Authorization": f"Bearer {_token(rsa_keypair)}"},
    )
    assert resp.status_code == 404


def test_transcript_route_propagates_unknown_thread_as_404(
    client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    async def _messages(actor_sub: str, thread_id: str) -> list[dict]:
        raise HTTPException(status_code=404, detail="Unknown chat thread")

    monkeypatch.setattr(main_module, "fetch_thread_messages", _messages)

    resp = client.get(
        f"/api/chat/sessions/{THREAD}/messages",
        headers={"Authorization": f"Bearer {_token(rsa_keypair)}"},
    )

    assert resp.status_code == 404


def test_transcript_route_gates_a_named_trip(
    client: TestClient, rsa_keypair, monkeypatch: pytest.MonkeyPatch
) -> None:
    trip = "bf29a027-1111-2222-3333-444455556666"
    monkeypatch.setattr(chat_module, "get_trip_role_for_user", lambda *a, **k: None)
    monkeypatch.setattr(chat_module, "get_trip_by_id", lambda trip_id: None)

    resp = client.get(
        f"/api/chat/sessions/{THREAD}/messages?tripId={trip}",
        headers={"Authorization": f"Bearer {_token(rsa_keypair)}"},
    )

    # Unknown trip → 404 from the ACL gate (same contract as POST /api/chat).
    assert resp.status_code == 404
