"""Chat relay (issue #9 / M3) — kiseki app ↔ kiseki content agent.

The kiseki React SPA talks to ``POST /api/chat`` (Vercel-ai ``useChat``
shape). This backend validates the caller, resolves the acting user (mode 1:
end-user Auth0 token → its own sub; mode 2: sanctioned agent M2M token +
request-scoped ``X-Act-As-Sub`` header → that sub), and relays the turn to
the kiseki content profile's Hermes API server over the **Responses API**
(``POST /v1/responses``), translating the stream into the Vercel-ai wire
format the SPA consumes.

Why Responses, not chat completions (Niko, 2026-09-09): the Responses API
keeps conversation history **on the Hermes side** — the relay sends only the
new user message plus a stable ``conversation`` name, and Hermes chains it to
the stored response. No full transcript round-trips every turn. The
conversation name is scoped per acting user (and trip), so histories never
mix across users — cross-user isolation by construction, not by prompt.

The identity envelope travels as ``instructions`` (an ephemeral system
prompt, not part of the stored history chain), telling the agent which user
it is acting for; the agent's write-API calls act-as that sub, enforced
downstream by the kiseki API ACL.

The translation is deliberately pure: ``iter_wire_frames`` maps Responses-API
SSE lines (``event:`` + ``data:``) to Vercel-ai data-stream lines
(``0:\"<text>\"`` … ``d:{…}``) so the wire contract is unit-testable without
any upstream. The IO seam (``fetch_upstream_lines``) is monkeypatched in
tests.
"""

from __future__ import annotations

import json
from typing import AsyncIterator, Iterable, Iterator

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict

from . import config
from .store import get_trip_role_for_user, get_trip_by_id

# ------------------------------------------------------------------ payloads


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChatMessage(_Strict):
    """One message in the turn. ``content`` may be a plain string or an array
    of parts (``{"type": "text", "text": …}`` / ``{"type": "image_url",
    "image_url": {"url": …}}``) — the Responses API accepts both.
    """

    role: str
    content: str | list[dict]
    id: str | None = None


class ChatRequest(_Strict):
    """Vercel-ai ``useChat`` payload.

    ``messages`` carries the SPA's full transcript for display; the relay
    forwards ONLY the last user message to Hermes (the Responses API chains
    the rest server-side via ``conversation``).

    ``threadId`` is the CLIENT-persisted conversation identity (a fresh UUID
    per chat thread, reused on resume) — multiple threads per trip, and
    threads that start unanchored. ``tripId`` is an optional ANCHOR: it is
    decoupled from conversation identity so a planning thread can attach a
    trip once it exists (created mid-thread) without losing history. It only
    drives the ACL gate + the agent's context instructions.
    """

    messages: list[ChatMessage]
    threadId: str | None = None
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
    """Translate Hermes Responses-API SSE lines → Vercel-ai wire frames.

    Frames carry an ``event:`` name plus a JSON ``data:`` body. Text deltas
    arrive as ``response.output_text.delta``; the stream ends with
    ``response.completed`` (success) or ``response.failed`` (error). Tool and
    lifecycle events (``response.created``, ``output_item.added/done``,
    ``output_text.done``) are consumed but not forwarded — tool execution
    happens agent-side; the SPA renders the final text (tool-call UI is a
    later add, see docs/chat-m3).
    """
    event: str | None = None
    for line in lines:
        line = line.strip()
        if not line or line.startswith(":"):
            continue  # SSE comment / keepalive
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
            continue
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            yield wire_done()
            return
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue  # non-JSON keepalive — ignore
        name = event or data.get("type") or ""
        event = None  # event: applies to the single following data: line
        if name == "response.output_text.delta":
            delta = data.get("delta")
            if isinstance(delta, str) and delta:
                yield wire_text(delta)
        elif name in ("response.completed", "response.done"):
            yield wire_done()
            return
        elif name in ("response.failed", "error"):
            detail = (
                data.get("error") or data.get("message") or "agent error"
            )
            if isinstance(detail, dict):
                detail = detail.get("message", "agent error")
            yield wire_error(str(detail))
            return
        # Everything else (created / output_item.* / output_text.done) is
        # lifecycle or tool metadata — ignored for text-only rendering.
    # Stream ended without a terminal event — still signal completion.
    yield wire_done()


# ------------------------------------------------------------------ identity


def identity_instructions(
    actor_sub: str,
    trip_id: str | None,
    thread_id: str | None = None,
) -> str:
    """Ephemeral system prompt (Responses ``instructions``) telling the agent
    which user it is acting for. Never stored in the history chain."""
    if trip_id:
        scope = (
            f"The trip anchored to this thread is {trip_id}. You may read "
            "content the acting user can read and edit content they can "
            "edit, and your write-API calls act-as this user."
        )
    else:
        scope = (
            "No trip is anchored to this thread yet. The user may ask about "
            "an existing trip (list the user's trips, then read the one they "
            "mean) or ask you to help PLAN a NEW trip — research freely, but "
            "never write trip content until the user anchors one."
        )
    return (
        "You are the Kiseki trip-content agent. The person you are helping "
        f"has identity sub={actor_sub}. {scope}"
    )


def conversation_id_for(
    actor_sub: str,
    trip_id: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Hermes-side conversation name for chaining one thread's turns.

    Identity is NOT encoded in the name (Niko, 2026-09-09): per-user scoping
    comes from ``X-Hermes-Session-Key`` (→ Honcho derives an independent
    ``user-default-<sub>`` peer per user) and from the request ACL, so the
    conversation name only needs to distinguish THREADS.

    - ``threadId`` present (the SPA always sends one — fresh UUID per chat,
      reused on resume): ``thread:<threadId>``. Multiple threads per trip; a
      thread may start unanchored (planning a not-yet-created trip) and
      attach a trip later without losing history.
    - No threadId (legacy callers): fall back to a sub-scoped trip anchor or
      a single general conversation — sub-scoped so two legacy clients can
      never chain onto each other's stored response.
    """
    if thread_id and thread_id.strip():
        return f"thread:{thread_id.strip()}"
    if trip_id:
        return f"{actor_sub}::trip:{trip_id.lower()}"
    return f"{actor_sub}::general"


def last_user_input(messages: list[ChatMessage]) -> dict:
    """The single new message to forward: the last user turn's content.

    History lives on the Hermes side (Responses chaining), so only this is
    sent as ``input``. Raises 400 when there is no user message.
    """
    for message in reversed(messages):
        if message.role == "user":
            return {"role": "user", "content": message.content}
    raise HTTPException(status_code=400, detail="No user message in request")


# ------------------------------------------------------------------ IO seam

async def fetch_upstream_lines(body: dict, *, session_key: str | None = None) -> AsyncIterator[str]:
    """Stream the upstream Responses-API body (line by line).

    The IO seam tests monkeypatch: production talks to the kiseki profile's
    Hermes API server (``KISEKI_HERMES_URL``, multiplexed /p/kiseki) with the
    profile-scoped ``KISEKI_HERMES_KEY``; absent config → 503 (no agent to
    relay to).

    ``session_key`` is forwarded as ``X-Hermes-Session-Key`` — the acting
    user's sub — so every session this user creates carries their sub as its
    session key. That is the seam per-user session recall filters on (the
    agent searches sessions whose session_key == the acting sub, never other
    users').
    """
    if not config.KISEKI_HERMES_URL or not config.KISEKI_HERMES_KEY:
        raise HTTPException(
            status_code=503,
            detail="The kiseki agent (chat) is not configured on this server",
        )
    import httpx

    url = config.KISEKI_HERMES_URL.rstrip("/") + "/v1/responses"
    headers = {
        "Authorization": f"Bearer {config.KISEKI_HERMES_KEY}",
        "Content-Type": "application/json",
    }
    if session_key:
        headers["X-Hermes-Session-Key"] = session_key
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


def build_upstream_body(
    messages: list[ChatMessage],
    *,
    actor_sub: str,
    trip_id: str | None,
    thread_id: str | None = None,
) -> dict:
    """Responses-API request body: new input + scoped conversation +
    identity instructions. Hermes chains prior turns from ``conversation``."""
    return {
        "model": "kiseki",
        "input": [last_user_input(messages)],
        "conversation": conversation_id_for(actor_sub, trip_id, thread_id),
        "instructions": identity_instructions(actor_sub, trip_id, thread_id),
        "stream": True,
    }


# ------------------------------------------------------------------ trip gate

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
