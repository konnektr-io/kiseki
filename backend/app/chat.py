"""Chat relay (issue #9 / M3) — kiseki app ↔ kiseki content agent.

The kiseki React SPA talks to ``POST /api/chat`` (Vercel-ai ``useChat``
shape). This backend validates the caller, resolves the acting user (mode 1:
end-user Auth0 token → its own sub; mode 2: sanctioned agent M2M token +
request-scoped ``X-Act-As-Sub`` header → that sub), injects an identity
envelope ahead of the user messages, then relays the turn to the kiseki
content profile's Hermes API server (in-cluster) and translates the
OpenAI-compatible stream into the Vercel-ai wire format the SPA consumes.

The translation is deliberately pure: ``iter_wire_frames`` maps OpenAI SSE
body lines (``data: {…}`` chunks) to Vercel-ai data-stream lines
(``0:"<text>"`` … ``d:{…}``) so the wire contract is unit-testable without
any upstream. The IO seam (``fetch_upstream_lines``) is monkeypatched in
tests.
"""

from __future__ import annotations

import json
from typing import AsyncIterator, Iterable, Iterator

from fastapi import Header, HTTPException
from pydantic import BaseModel, ConfigDict

from . import config
from .acl import resolve_request_actor_sub
from .auth import get_current_user
from .store import get_trip_role_for_user, get_trip_by_id

# ------------------------------------------------------------------ payloads


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChatMessage(_Strict):
    """One message in the turn. ``content`` may be a plain string or an array
    of parts (``{"type": "text", "text": …}`` / ``{"type": "image_url",
    "image_url": {"url": …}}``) — the OpenAI-compatible upstream accepts both.
    """

    role: str
    content: str | list[dict]
    id: str | None = None


class ChatRequest(_Strict):
    messages: list[ChatMessage]
    tripId: str | None = None


# ------------------------------------------------------------------ wire fmt

def wire_text(delta: str) -> str:
    """Vercel-ai data-stream line for one text delta (part index 0)."""
    return f"0:{json.dumps(delta)}"


def wire_done() -> str:
    """Terminal data-stream line (finish_reason stop)."""
    return f'd:{{"finishReason":"stop","isContinued":false}}'


def wire_error(message: str) -> str:
    return f'e:{{"error":"{message}"}}'


def iter_wire_frames(lines: Iterable[str]) -> Iterator[str]:
    """Translate OpenAI-compatible SSE body lines → Vercel-ai wire frames.

    Accepts both standard OpenAI chat-completions chunks (``{"choices":
    [{"delta": {"content": "…"}}]}``) and the bare-delta frames some agents
    emit. Emits text deltas as ``0:"…"`` and a single terminal ``d:`` frame
    on ``[DONE]``. Non-content chunks (tool_calls, finish_reason) are
    consumed but not forwarded — tool execution happens agent-side; the SPA
    renders the final text (tool-call UI is a later add, see docs/chat-m3).
    """
    for line in lines:
        line = line.strip()
        if not line or line.startswith(":"):
            continue  # SSE comment / keepalive
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            yield wire_done()
            return
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue  # non-JSON keepalive — ignore
        choices = chunk.get("choices") or []
        if not choices:
            # Some streams use {"delta": "…"} at top level instead.
            delta = chunk.get("delta")
            if isinstance(delta, str) and delta:
                yield wire_text(delta)
            continue
        for choice in choices:
            delta = (choice.get("delta") or {})
            content = delta.get("content")
            if isinstance(content, str) and content:
                yield wire_text(content)
    # Stream ended without [DONE] — still signal completion.
    yield wire_done()


# ------------------------------------------------------------------ IO seam

async def fetch_upstream_lines(
    messages: list[dict],
    *,
    trip_id: str | None,
    actor_sub: str,
) -> AsyncIterator[str]:
    """Stream the upstream chat-completions body (line by line).

    The IO seam tests monkeypatch: production talks to the kiseki profile's
    Hermes API server (``KISEKI_HERMES_URL``) with the shared
    ``KISEKI_HERMES_KEY``; absent config → 503 (no agent to relay to).
    """
    if not config.KISEKI_HERMES_URL or not config.KISEKI_HERMES_KEY:
        raise HTTPException(
            status_code=503,
            detail="The kiseki agent (chat) is not configured on this server",
        )
    import httpx

    body = {
        "model": "kiseki",
        "messages": messages,
        "stream": True,
    }
    url = config.KISEKI_HERMES_URL.rstrip("/") + "/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {config.KISEKI_HERMES_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", url, json=body, headers=headers
        ) as resp:
            if resp.status_code != 200:
                detail = (await resp.aread()).decode("utf-8", "replace")[:500]
                raise HTTPException(
                    status_code=502,
                    detail=f"Kiseki agent upstream error {resp.status_code}: {detail}",
                )
            async for text in resp.aiter_lines():
                yield text


def build_upstream_messages(
    messages: list[ChatMessage],
    *,
    actor_sub: str,
    trip_id: str | None,
) -> list[dict]:
    """User messages + the identity envelope ahead of them.

    The api server has no per-request act-as field, so the acting user's sub
    rides as a system envelope: the agent scopes its writes (act-as) to this
    sub — enforced downstream by the kiseki API ACL, never by prompt alone.
    """
    envelope: dict = {
        "role": "system",
        "content": (
            "You are the Kiseki trip-content agent. The person you are "
            f"helping has identity sub={actor_sub}. "
            + (
                f"The trip in context is {trip_id}; you may read content the "
                "acting user can read and edit content they can edit, and "
                "your write-API calls act-as this user."
                if trip_id
                else "No trip is in context yet."
            )
        ),
    }
    return [envelope] + [m.model_dump(exclude_none=True) for m in messages]


# ------------------------------------------------------------------ deps

def require_actor_trip_access(actor_sub: str, trip_id: str, min_role: str = "follower") -> str:
    """Validate the ACTING user has ``min_role`` on the named trip.

    The chat may reference a trip the caller cannot see — gate it like any
    read: the resolved actor must hold a real crew role. Returns the role.
    """
    trip = get_trip_by_id(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if trip.visibility == "public" and min_role == "follower":
        return "follower"  # public trips are readable by anyone (role: none)
    role = get_trip_role_for_user(trip_id.lower(), actor_sub)
    rank = {"follower": 1, "viewer": 2, "editor": 3, "owner": 4}
    if not role or rank.get(role, 0) < rank.get(min_role, 1):
        raise HTTPException(
            status_code=403,
            detail=f"You need the '{min_role}' role on this trip to chat about it",
        )
    return role
