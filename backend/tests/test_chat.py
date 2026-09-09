"""Chat relay + file upload tests (issue #9 / M3).

Covers the M3 acceptance contract:
- identity is bearer-first: end-user token → its own sub (mode 1); sanctioned
  M2M token + X-Act-As-Sub header → that sub (mode 2); M2M with no act-as and
  no pin → 401;
- /api/chat translates an OpenAI-compatible upstream stream to Vercel-ai
  ``0:`` frames and injects the identity envelope;
- /api/chat gates the named trip (follower+ for the ACTING user);
- /api/files stores content-addressed bytes into the trip's media namespace
  and returns the /media URL (editor+ only);
- claims/follow still refuse M2M tokens (regression, #142).
"""

from __future__ import annotations

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
            self.id = "bf29a027-1111-2222-3333-444455556666"
            self.visibility = visibility
            self.claimToken = "secret"

    monkeypatch.setattr(
        chat_module,
        "get_trip_by_id",
        lambda trip_id: (_Trip() if trip_id == "bf29a027-1111-2222-3333-444455556666" else None),
    )


def _fake_upstream(monkeypatch: pytest.MonkeyPatch, chunks: list[dict] | None = None):
    """Point the relay at a canned upstream body (line by line)."""
    if chunks is None:
        chunks = [
            {"choices": [{"delta": {"content": "Hel"}}]},
            {"choices": [{"delta": {"content": "lo"}}]},
            {"choices": [{"delta": {}}]},
        ]
    lines = ["data: " + json.dumps(c) for c in chunks] + ["data: [DONE]"]

    async def _fake(messages, *, trip_id, actor_sub):
        for line in lines:
            yield line

    monkeypatch.setattr(main_module, "fetch_upstream_lines", _fake)
    return lines


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
    _fake_upstream(monkeypatch)
    token = _user_token(rsa_keypair)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": "bf29a027-1111-2222-3333-444455556666",
            "messages": [{"role": "user", "content": "Summarize day 1"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert '0:"Hel"' in resp.text
    assert '0:"lo"' in resp.text
    assert "finishReason" in resp.text


def test_chat_injects_identity_envelope(client, rsa_keypair, monkeypatch) -> None:
    """The upstream request carries the acting sub as a system envelope."""
    _role(monkeypatch, "owner")
    _fake_trip(monkeypatch, visibility="private")
    captured: dict = {}

    async def _fake(messages, *, trip_id, actor_sub):
        captured["messages"] = messages
        captured["actor_sub"] = actor_sub
        yield "data: [DONE]"

    monkeypatch.setattr(main_module, "fetch_upstream_lines", _fake)
    token = _user_token(rsa_keypair, sub=OTHER_SUB)
    client.post(
        "/api/chat",
        json={
            "tripId": "bf29a027-1111-2222-3333-444455556666",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert captured["actor_sub"] == OTHER_SUB
    assert captured["messages"][0]["role"] == "system"
    assert OTHER_SUB in captured["messages"][0]["content"]
    assert captured["messages"][1]["role"] == "user"


def test_chat_m2m_act_as_header_reaches_agent(
    client, rsa_keypair, monkeypatch
) -> None:
    _role(monkeypatch, "editor")
    _fake_trip(monkeypatch, visibility="private")
    captured: dict = {}

    async def _fake(messages, *, trip_id, actor_sub):
        captured["actor_sub"] = actor_sub
        yield "data: [DONE]"

    monkeypatch.setattr(main_module, "fetch_upstream_lines", _fake)
    token = _user_token(rsa_keypair, m2m=True)
    resp = client.post(
        "/api/chat",
        json={
            "tripId": "bf29a027-1111-2222-3333-444455556666",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers={
            "Authorization": f"Bearer {token}",
            "X-Act-As-Sub": OTHER_SUB,
        },
    )
    assert resp.status_code == 200
    assert captured["actor_sub"] == OTHER_SUB


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
            "tripId": "bf29a027-1111-2222-3333-444455556666",
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


def test_wire_translation_of_upstream_stream() -> None:
    lines = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
    ]
    frames = list(chat_module.iter_wire_frames(lines))
    assert frames == ['0:"Hel"', '0:"lo"', chat_module.wire_done()]


def test_wire_translation_skips_tool_chunks() -> None:
    lines = [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1"}]}}]}',
        'data: {"choices":[{"delta":{"content":"answer"}}]}',
        "data: [DONE]",
    ]
    frames = list(chat_module.iter_wire_frames(lines))
    assert frames == ['0:"answer"', chat_module.wire_done()]


def test_wire_translation_keepalives_ignored() -> None:
    lines = [": keepalive", "", 'data: {"choices":[{"delta":{"content":"x"}}]}', "data: [DONE]"]
    frames = list(chat_module.iter_wire_frames(lines))
    assert '0:"x"' in frames


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
            data={"trip_id": "bf29a027-1111-2222-3333-444455556666"},
            files={"file": ("photo.jpg", io.BytesIO(raw), "image/jpeg")},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        url = resp.json()["url"]
        # content-addressed: /media/<trip>/<sha256[:32]>.jpg
        assert url.startswith("/media/bf29a027-1111-2222-3333-444455556666/")
        assert url.endswith(".jpg")
        import hashlib

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
        data={"trip_id": "bf29a027-1111-2222-3333-444455556666"},
        files={"file": ("a.txt", io.BytesIO(b"hi"), "text/plain")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


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
