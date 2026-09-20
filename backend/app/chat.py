"""Chat relay (issue #9 / M3) — kiseki app ↔ kiseki content agent.

The kiseki React SPA talks to ``POST /api/chat`` (Vercel-ai ``useChat``
shape). This backend validates the caller, resolves the acting user (mode 1:
end-user Auth0 token → its own sub; mode 2: sanctioned agent M2M token +
request-scoped ``X-Act-As-Sub`` header → that sub), and relays the turn to
the kiseki content profile's Hermes API server over the **Runs API**
(``POST /v1/runs``), translating the stream into the Vercel-ai wire
format the SPA consumes.

Why agent-side history (Niko, 2026-09-09): Hermes keeps the conversation
history **on its own side** — the relay sends only the new user message plus a
stable scoped session name, and Hermes chains it to what that session already
holds. No full transcript round-trips every turn. The session name is scoped
per acting user (and trip), so histories never mix across users — cross-user
isolation by construction, not by prompt.

Why *runs*, not a proxied streaming response (issue #217): the turn used to BE
the browser's SSE connection — ``POST /v1/responses`` proxied one-to-one, so a
dropped connection killed the agent turn (``interrupted_by_user``,
``response_len=0`` after 134 API calls, repeatedly). The Runs API decouples
them: the relay *submits* a run (``Idempotency-Key`` → the same ``run_id`` on
replay), *pumps* its ``/events`` feed into a relay-owned buffer, and every
browser connection only *attaches* to that buffer at a cursor. Losing a
connection now costs nothing — the work keeps accumulating, and a reconnect
re-attaches instead of re-sending (so no duplicated trip). ``POST
/api/chat/stop`` is the only thing that stops a run.

The identity envelope travels as ``instructions`` (an ephemeral system
prompt, not part of the stored history chain), telling the agent which user
it is acting for; the agent's write-API calls act-as that sub, enforced
downstream by the kiseki API ACL.

The translation is deliberately pure: ``iter_wire_frames`` maps Responses-API
SSE lines (``event:`` + ``data:``) to Vercel-ai UI-message-stream v1 chunk
dicts (``text-start`` / ``text-delta`` / ``text-end`` / ``data-activity`` /
``finish`` / ``error``, serialized by the route as ``data: {…}`` SSE events per
``x-vercel-ai-ui-message-stream: v1``) so the wire contract is unit-testable
without any upstream. The IO seam (``fetch_upstream_lines``) is monkeypatched
in tests.

Credential silence (#158): the identity envelope instructs the agent never to
narrate tokens/M2M/act-as, and the delta path redacts ``eyJ…``-shaped JWTs
from streamed text (held-back-tail handling so a token split across deltas
cannot leak in fragments) — the user never sees credential mechanics, even by
accident.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator, Iterable, Iterator, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

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
    forwards ONLY the last user message to Hermes (Hermes chains the rest
    server-side via the scoped session).

    ``threadId`` is the CLIENT-persisted conversation identity (a fresh UUID
    per chat thread, reused on resume) — multiple threads per trip, and
    threads that start unanchored. ``tripId`` is an optional ANCHOR: it is
    decoupled from conversation identity so a planning thread can attach a
    trip once it exists (created mid-thread) without losing history. It only
    drives the ACL gate + the agent's context instructions.

    ``turnKey`` names ONE turn (issue #217) — the SPA mints it per user
    message and reuses it verbatim when it needs to reconnect, which is what
    makes a reconnect an ATTACH to the running turn instead of a re-send:
    the relay derives the upstream ``Idempotency-Key`` from it, so the same
    pair (user, thread, turnKey) always resolves to the same run, and a
    second request for a live turn streams that turn's remaining frames
    rather than starting the work again. ``cursor`` is how many frames of
    that turn the caller has already rendered (absent/0 on the first send) —
    the attach replays only the gap. Both are optional: without them each
    POST is a fresh, unattachable turn (legacy shape).

    ``messages`` is empty on an ATTACH (the caller has nothing new to say —
    it only wants the frames it missed); the 400 for a missing user message
    therefore only applies when the request starts a new turn.

    ``focus`` is the ENTITY-level anchor (#296 / #330): the day, section or
    block whose "Ask the agent about this" opened the drawer. Like ``tripId``
    it is context for the agent, never an ACL input — the gate stays the trip
    role — and it only applies to a turn that is being SUBMITTED.
    """

    messages: list[ChatMessage] = []
    threadId: str | None = None
    tripId: str | None = None
    focus: ChatFocus | None = None
    turnKey: str | None = None
    cursor: int | None = None


FocusEntity = Literal["day", "section", "block"]


class ChatFocus(_Strict):
    """The entity the drawer was opened from (#296 phase 2, #330).

    ``entity`` + ``id`` name one day / section / block **twin**. The relay
    resolves them against the trip document it has ALREADY fetched for the ACL
    gate and states the result in the turn's ``instructions``, so the agent is
    told which day it is working on.

    Deliberately an id, never client-authored prose: the composer draft the
    bridge pre-fills is a convenience the user may rewrite or delete, and
    nothing a browser sends should be able to write the agent's system prompt.
    The human-readable label is derived server-side from the graph, and an id
    that no longer resolves degrades to a neutral line instead of failing the
    turn (a stale tab must not be able to 422 a chat).
    """

    entity: FocusEntity
    id: str = Field(min_length=1, max_length=120)


class TurnRequest(_Strict):
    """Turn-addressed request (``/api/chat/stop``, ``GET /api/chat/turn``).

    ``turnKey`` + ``threadId`` (+ optional ``tripId`` anchor) name one turn
    exactly as :func:`turn_key_for` scopes it — the relay re-derives the key
    server-side, so a caller can only ever address its own turn.
    """

    turnKey: str
    threadId: str | None = None
    tripId: str | None = None


# ------------------------------------------------------------------ wire fmt
# Vercel-ai UI-message-stream v1 (x-vercel-ai-ui-message-stream: v1), the
# protocol the installed ai SDK's DefaultChatTransport parses natively. Each
# chunk dict is serialized by the route as one SSE event
# (``data: {json}\n\n``); the stream ends with ``data: [DONE]\n\n``. Minimal
# text-only sequence per turn: text-start → text-delta* → text-end → finish.

def text_start_chunk(part_id: str) -> dict:
    """Open the turn's single text part."""
    return {"type": "text-start", "id": part_id}


def text_delta_chunk(part_id: str, delta: str) -> dict:
    """One text delta on the turn's text part."""
    return {"type": "text-delta", "id": part_id, "delta": delta}


def text_end_chunk(part_id: str) -> dict:
    """Close the turn's text part (only when text started)."""
    return {"type": "text-end", "id": part_id}


def finish_chunk(*, interrupted: bool = False) -> dict:
    """Terminal chunk (stop). Always emitted, exactly once per turn.

    ``interrupted`` marks a cut connection: the upstream stream ended
    without ``response.completed``/``[DONE]`` (transport drop, SSE
    disconnect, server restart). It travels as the chunk's
    ``messageMetadata`` (a first-class field the SDK persists onto the
    assistant message) so the UI can offer Reconnect — never render a
    dropped turn as a clean completion.
    """
    chunk: dict = {"type": "finish", "finishReason": "stop"}
    if interrupted:
        chunk["messageMetadata"] = {"interrupted": True}
    return chunk


#: Friendly activity labels for the agent's tool names (issue #151).
#: The panel renders these, never the raw tool names — unknown tools fall
#: back to "Working…". Keep in sync with the content agent's toolset.
TOOL_ACTIVITY_LABELS: dict[str, str] = {
    "web_search": "Searching the web…",
    "web_extract": "Reading a page…",
    "terminal": "Running a command…",
    "read_file": "Reading trip data…",
    "write_file": "Writing trip data…",
    "patch": "Updating trip content…",
    "search_files": "Searching files…",
    "skill_view": "Checking how to help…",
    "skills_list": "Checking how to help…",
    "vision_analyze": "Looking at an image…",
    "execute_code": "Running a calculation…",
}


def tool_activity_label(tool_name: str) -> str:
    """User-friendly label for an agent tool call (never the raw name)."""
    return TOOL_ACTIVITY_LABELS.get(tool_name, "Working…")


#: The synthetic data-part type the activity feed uses (issue #157). The
#: relay drops the REAL upstream tool names on purpose — raw names
#: (``terminal``, ``execute_code``, …) never reach the UI; the friendly
#: label travels in the part ``data`` instead. Data parts carry NO tool
#: lifecycle semantics: nothing is executed client-side, nothing is
#: resubmitted, and no declared tool is needed for the SPA to render them.
_ACTIVITY_PART = "data-kiseki-activity"


def activity_start_chunk(call_id: str, label: str) -> dict:
    """Open one activity row — the SPA renders it spinning (label, done=F)."""
    return {
        "type": _ACTIVITY_PART,
        "id": call_id,
        "data": {"label": label, "done": False},
    }


def activity_done_chunk(call_id: str, label: str) -> dict:
    """Close the activity row ``call_id`` opened — same id, ``done: true``."""
    return {
        "type": _ACTIVITY_PART,
        "id": call_id,
        "data": {"label": label, "done": True},
    }


def error_chunk(message: str) -> dict:
    """In-stream error signal (terminal — replaces text-end/finish)."""
    return {"type": "error", "errorText": message}


def sse_data(chunk: dict) -> str:
    """Serialize one v1 chunk dict as an SSE ``data:`` event."""
    return f"data: {json.dumps(chunk)}\n\n"


#: Stream terminator appended after the terminal chunk.
SSE_DONE = "data: [DONE]\n\n"

#: Runs-API terminal statuses (``run.<status>``): the turn is over, and the
#: only place a run's final text can still be recovered from (issue #217).
_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled", "interrupted"})


# ------------------------------------------------------- secret scrub (#158)

#: Replacement for redacted credential material. Deliberately free of
#: credential vocabulary — ``[token removed]`` would name the machinery the
#: chat must never talk about (issue #158).
_REDACTED = "[redacted]"

#: A JWT-shaped run: three ``eyJ…`` base64url segments separated by dots.
#: Auth0 access/id tokens (RS256/HS256/…) all start with an ``eyJ`` header
#: segment; the ≥8/≥4/≥4 minimums keep natural ``eyJ``-prefixed words safe.
_JWT_RE = re.compile(
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}"
)

#: A dangling PARTIAL JWT at a delta boundary — header (``eyJ…``, any
#: length), optionally followed by whole ``.payload`` segments and a
#: trailing dot/partial-signature. Held back until the next delta or the
#: stream end resolves it, so a token split across deltas at ANY point
#: (mid-header, mid-payload, mid-signature, at a dot) never streams in
#: fragments. The ``eyJ`` anchor makes false positives on natural prose
#: essentially impossible.
_JWT_PARTIAL_RE = re.compile(
    r"eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]{4,})*(?:\.[A-Za-z0-9_-]*)?$"
)


def scrub_jwt(text: str) -> str:
    """Redact ``eyJ…``-shaped JWTs from agent text.

    Defense in depth (issue #158): the agent is instructed never to
    narrate credentials, but a token that nonetheless gets pasted through
    must never reach the UI either.
    """
    return _JWT_RE.sub(_REDACTED, text)


def iter_wire_frames(
    lines: Iterable[str], *, part_id: str | None = None
) -> Iterator[dict]:
    """Translate a Responses-API SSE body → v1 chunk dicts (one-shot).

    Convenience wrapper over :class:`WireTranslator` for tests and callers
    that hold the whole upstream body at once. The live relay must feed the
    stateful translator line-by-line instead (``feed`` per upstream line,
    ``finish`` at stream end) — a fresh one-shot per line emits a spurious
    terminal ``finish`` for every event/data line (the v0.24.0 no-streaming
    bug: the SPA transport stops at the terminal chunk, so nothing renders).
    """
    translator = WireTranslator(part_id=part_id)
    for line in lines:
        yield from translator.feed(line)
    yield from translator.finish()


class WireTranslator:
    """Incremental Responses-API SSE → v1 chunk translator.

    Feed raw upstream lines one at a time (``feed``); call ``finish`` when
    the upstream stream ends. One instance owns one turn (one stable
    ``<turn-id>`` shared by text-start/delta/end). State that a one-shot
    generator holds across lines survives here across calls:

    - the pending ``event:`` name (SSE sends ``event:`` and ``data:`` as
      separate lines);
    - whether text started (``text-start`` is emitted lazily before the
      first delta — the SDK requires start before delta/end);
    - the held-back scrub tail: a delta ending in a dangling ``eyJ…``
      JWT-charset run is withheld until the next delta / stream end
      resolves it, so a token SPLIT across deltas is never streamed in
      fragments (JWT redaction, issue #158);
    - the terminal flag, so exactly ONE terminal sequence is ever emitted —
      ``text-end`` (only if text started) + ``finish`` on
      ``response.completed``/``[DONE]``, or from ``finish`` when the stream
      ends without a terminal event (cut connection — the emitted ``finish``
      carries ``messageMetadata.interrupted`` so the UI can offer Reconnect
      instead of rendering a fake completion, issue #152). Lifecycle events
      (``response.created``, ``output_item.*`` without tool payloads,
      ``output_text.done``) are consumed and dropped, never echoed as chunks.
    - the text-part SEGMENT id (issue #179): narration between tool calls
      must never render as chat text, so each ``function_call`` open CLOSES
      the active text part and the next delta opens a FRESH part
      (``<turn-id>-seg<n>``). The SDK stores one ``text`` part per
      ``text-start`` id in arrival order, so narration segments sit
      structurally BEFORE the activity parts and the final answer AFTER the
      last one — ``messageFinalText`` (frontend/src/lib/chat.ts) renders
      only post-activity text, and a chatty model's narration can never
      become a chat bubble.

    Agent tool calls (issue #151) forward as activity chunks, not text: each
    upstream ``output_item.added`` carrying a ``function_call`` item emits a
    ``data-kiseki-activity`` part (one activity row per call, ``done: false``
    — spinning), and the matching ``output_item.done`` for that call emits
    the completing part (``done: true``) — issue #157 switched the wire from
    synthetic tool-lifecycle chunks to ``data-*`` custom parts: nothing is
    ever executed client-side, so tool lifecycle semantics only fought the
    SDK's tool state machine (undeclared-tool parts never settle into
    ``message.parts`` as the reader expected, and the UI rendered nothing).
    The REAL upstream tool name never leaves the
    server — the friendly label travels in the part data. Rows update in
    place by part ``id``, so an open call (``done: false``) is a real
    spinner state, not a born-complete row. Emitted BEFORE any
    ``response.completed`` terminal, so mid-turn tool calls render while the
    agent still works.

    Tool/lifecycle events stay agent-side by design — v1 renders text only.

    Handles BOTH upstream dialects on one wire: the Responses API names each
    event in an ``event:`` line (or the payload's ``type``), the Runs API's
    ``/events`` feed carries the name inside the payload (``event``, see
    ``api_server_runs._run_event``) and its text arrives as ``message.delta``,
    its tool rows as ``tool.started``/``tool.completed`` (a tool NAME, no call
    id — rows pair FIFO per name) and its terminals as ``run.<status>``.
    """

    def __init__(self, *, part_id: str | None = None, replay_output: bool = False) -> None:
        self._event: str | None = None
        self._done = False
        self._started = False
        self._part_id = part_id or uuid.uuid4().hex[:16]
        self._call_seq = 0
        self._open_calls: dict[str, tuple[str, str]] = {}  # item id → (call id, label)
        # Runs-API tool rows: ``tool.completed`` carries only the tool name,
        # so open rows are paired FIFO per name (issue #217).
        self._open_run_calls: list[tuple[str, str, str]] = []  # (call id, label, tool)
        # Did any TEXT reach the wire? Only then may a terminal event's
        # ``output`` be ignored (see ``_replay_final_output``, #217).
        self._saw_text = False
        # Replay a terminal run's final output when no delta ever arrived
        # (relay restarted mid-turn: the gateway's feed is forward-only, so
        # the deltas are gone but the finished text is in the run status).
        self._replay_output = replay_output
        # Held-back tail of the last delta (issue #158): a delta that ENDS
        # with a dangling ``eyJ…`` JWT-charset run — the token may complete
        # in the next delta, so the fragment is withheld (never streamed)
        # until the next delta or the stream end resolves it.
        self._partial = ""
        # Text-part segment id (issue #179): the ACTIVE text part's id.
        # Starts as the turn id; every function_call open closes the active
        # part and rotates to ``<turn-id>-seg<n>`` so post-tool text lands
        # in a NEW part AFTER the activity parts (see class docstring).
        self._text_id = self._part_id
        self._seg = 0

    def feed(self, line: str) -> list[dict]:
        """Translate one raw upstream line. Empty when consumed/dropped."""
        if self._done:
            return []
        chunks: list[dict] = []
        line = line.strip()
        if not line or line.startswith(":"):
            return chunks  # SSE comment / keepalive
        if line.startswith("event:"):
            self._event = line[len("event:"):].strip()
            return chunks
        if not line.startswith("data:"):
            return chunks
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            self._done = True
            chunks.extend(self._flush_tail())
            if self._started:
                chunks.append(text_end_chunk(self._text_id))
            chunks.append(finish_chunk())
            return chunks
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return chunks  # non-JSON keepalive — ignore
        name = self._event or data.get("type") or data.get("event") or ""
        self._event = None  # event: applies to the single following data: line
        # ---- Runs API (issue #217): the name travels in the payload ------
        if name == "message.delta":
            chunks.extend(self._feed_text(data.get("delta")))
        elif name == "tool.started":
            chunks.extend(self._open_tool(data.get("tool")))
        elif name == "tool.completed":
            chunks.extend(self._close_tool(data.get("tool")))
        elif name.startswith("run.") and name[4:] in _TERMINAL_RUN_STATUSES:
            chunks.extend(self._feed_run_terminal(name[4:], data))
        elif name == "response.output_text.delta":
            chunks.extend(self._feed_text(data.get("delta")))
        elif name in ("response.completed", "response.done"):
            self._done = True
            chunks.extend(self._flush_tail())
            if self._started:
                chunks.append(text_end_chunk(self._text_id))
            chunks.append(finish_chunk())
        elif name in ("response.failed", "error"):
            detail = data.get("error") or data.get("message") or "agent error"
            if isinstance(detail, dict):
                detail = detail.get("message", "agent error")
            self._done = True
            chunks.extend(self._flush_tail())
            if self._started:
                chunks.append(text_end_chunk(self._text_id))
            chunks.append(error_chunk(str(detail)))
        elif name in ("response.output_item.added", "response.output_item.done"):
            chunks.extend(self._feed_tool_item(name, data))
        # Everything else (created / output_text.done) is lifecycle —
        # ignored for text-only rendering.
        return chunks

    def _scrub_delta(self, delta: str) -> list[dict]:
        """Redact JWT-shaped material from one text delta (issue #158).

        The tricky case is a token SPLIT across deltas — ``eyJhbGciOi…`` in
        one delta and the rest in the next — where a naive per-delta regex
        would stream half the token. So: the accumulated text (held-back
        tail + this delta) is scrubbed for complete JWTs; if it still ENDS
        with a dangling ``eyJ…`` run, that tail is held back (never
        streamed) until the next delta or the stream end resolves it.
        """
        text = self._partial + delta
        self._partial = ""
        text = scrub_jwt(text)
        m = _JWT_PARTIAL_RE.search(text)
        if m:
            self._partial = m.group(0)
            text = text[: m.start()]
        out: list[dict] = []
        if text:
            out.append(text_delta_chunk(self._text_id, text))
        return out

    def _rotate_text_part(self) -> dict | None:
        """Close the active text part and open a fresh segment (issue #179).

        Called when a ``function_call`` opens: whatever the model streamed
        so far is narration (pre-tool chatter), and the next delta must
        land in a NEW ``text`` part positioned AFTER the tool's activity
        parts — that post-activity text is all the UI renders as chat
        (``messageFinalText``). No-op while no text part is open.
        """
        if not self._started:
            return None
        self._started = False
        chunk = text_end_chunk(self._text_id)
        self._seg += 1
        self._text_id = f"{self._part_id}-seg{self._seg}"
        return chunk

    def _flush_tail(self) -> list[dict]:
        """Resolve the held-back tail at stream end.

        The tail was held because it looks like the START of a JWT header
        segment. If the stream ends before it completes (cut stream, text
        ending mid-token), the fragment must not stream either — redact it.
        (False positives cost a phantom ``[redacted]`` on a rare
        ``eyJ…word``; the alternative risks streaming a credential
        fragment.)
        """
        if not self._partial:
            return []
        self._partial = ""
        return [text_delta_chunk(self._text_id, _REDACTED)]

    def _feed_tool_item(self, event: str, data: dict) -> list[dict]:
        """Translate one tool ``output_item`` event → activity parts.

        ``output_item.added`` with a ``function_call`` item opens an activity
        row (``done: false`` — spinning); ``output_item.done`` for the same
        item id closes it with the SAME part id (``done: true``). Anything
        else (message items, ``function_call_output`` items, unknown shapes)
        is consumed silently. Unknown tool names still open a row — the label
        falls back to "Working…", never the raw name.
        """
        item = data.get("item")
        if not isinstance(item, dict):
            return []
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            return []
        if item.get("type") != "function_call":
            return []  # message / function_call_output items stay server-side
        if event == "response.output_item.added":
            tool_name = item.get("name")
            label = tool_activity_label(
                tool_name if isinstance(tool_name, str) else ""
            )
            self._call_seq += 1
            call_id = f"{self._part_id}-tool-{self._call_seq}"
            self._open_calls[item_id] = (call_id, label)
            # Close any open text part FIRST (issue #179): text streamed so
            # far is narration — end it so the activity part (and all later
            # text) sits in a fresh part after it, not inside the narration.
            closed = self._rotate_text_part()
            chunks = [closed] if closed else []
            return chunks + [activity_start_chunk(call_id, label)]
        open_call = self._open_calls.pop(item_id, None)
        if open_call is None:
            return []  # orphan done (no matching added) — ignore
        call_id, label = open_call
        return [activity_done_chunk(call_id, label)]

    def _feed_text(self, delta: object) -> list[dict]:
        """One text delta (either dialect) → v1 text chunks."""
        if not isinstance(delta, str) or not delta:
            return []
        chunks: list[dict] = []
        if not self._started:
            self._started = True
            chunks.append(text_start_chunk(self._text_id))
        self._saw_text = True
        chunks.extend(self._scrub_delta(delta))
        return chunks

    def _open_tool(self, tool_name: object) -> list[dict]:
        """``tool.started`` → one spinning activity row (issue #217).

        The Runs feed carries the tool NAME and no call id, so the row id is
        synthesized here and paired FIFO by name on completion. The raw name
        still never leaves the server (``tool_activity_label``).
        """
        label = tool_activity_label(tool_name if isinstance(tool_name, str) else "")
        self._call_seq += 1
        call_id = f"{self._part_id}-tool-{self._call_seq}"
        self._open_run_calls.append((call_id, label, str(tool_name or "")))
        closed = self._rotate_text_part()
        return ([closed] if closed else []) + [activity_start_chunk(call_id, label)]

    def _close_tool(self, tool_name: object) -> list[dict]:
        """``tool.completed`` → close the oldest row for that tool."""
        name = str(tool_name or "")
        for index, (call_id, label, open_name) in enumerate(self._open_run_calls):
            if open_name == name:
                del self._open_run_calls[index]
                return [activity_done_chunk(call_id, label)]
        if self._open_run_calls:  # unknown name — close the oldest row anyway
            call_id, label, _ = self._open_run_calls.pop(0)
            return [activity_done_chunk(call_id, label)]
        return []  # orphan completion (no matching start) — ignore

    def _feed_run_terminal(self, status: str, data: dict) -> list[dict]:
        """``run.<status>`` → the turn's closing sequence (issue #217).

        ``failed`` becomes an error chunk (terminal, like the Responses
        ``response.failed``); ``completed`` a clean finish; ``interrupted``
        carries ``messageMetadata.interrupted`` so the UI offers a reconnect
        (an attach, which costs nothing) rather than rendering a dropped turn
        as a clean completion. ``cancelled`` — the user pressed Stop — is a
        clean finish: the turn ended on purpose.
        """
        if self._done:
            return []
        self._done = True
        chunks: list[dict] = []
        if status == "failed":
            detail = data.get("error") or data.get("summary") or "agent error"
            if isinstance(detail, dict):
                detail = detail.get("message", "agent error")
            chunks.extend(self._flush_tail())
            if self._started:
                chunks.append(text_end_chunk(self._text_id))
            chunks.append(error_chunk(str(detail)))
            return chunks
        chunks.extend(self._replay_final_output(data))
        chunks.extend(self._flush_tail())
        if self._started:
            chunks.append(text_end_chunk(self._text_id))
        chunks.append(finish_chunk(interrupted=status == "interrupted"))
        return chunks

    def _replay_final_output(self, data: dict) -> list[dict]:
        """Render the terminal event's final text when no delta ever arrived.

        A relay that lost the event feed (its own restart) still learns the
        finished text from the run's terminal status — the gateway's feed is
        forward-only (no ``Last-Event-ID``), so the deltas that streamed
        before the loss are unrecoverable. Showing the answer beats showing
        an empty turn. No-op when text already reached the wire.
        """
        if not self._replay_output or self._saw_text:
            return []
        text = _output_text(data)
        if not text:
            return []
        self._started = True
        self._saw_text = True
        return [
            text_start_chunk(self._text_id),
            text_delta_chunk(self._text_id, scrub_jwt(text)),
        ]

    def fail(self, message: str) -> list[dict]:
        """Terminal error sequence, replacing text-end/finish (issue #217).

        Used when the relay loses the turn's feed without a terminal event:
        the caller gets an explicit error instead of a silent truncation.
        """
        if self._done:
            return []
        self._done = True
        chunks = self._flush_tail()
        if self._started:
            chunks.append(text_end_chunk(self._text_id))
        chunks.append(error_chunk(message))
        return chunks

    def finish(self) -> list[dict]:
        """Signal stream end. Emits the terminal sequence ONLY if no terminal
        event was seen (cut connection must still resolve the turn — with an
        ``interrupted`` finish so the UI offers Reconnect, issue #152). Any
        held-back scrub tail is flushed/redacted first (#158)."""
        if self._done:
            return []
        self._done = True
        chunks = self._flush_tail()
        if self._started:
            chunks.append(text_end_chunk(self._text_id))
        chunks.append(finish_chunk(interrupted=True))
        return chunks


# ------------------------------------------------------------------ identity


def trip_anchor_line(trip) -> str:
    """One line naming the trip this thread is anchored to (#330).

    The agent's ONLY source of truth for WHICH trip it is working on. It used
    to be told nothing at all — ``identity_instructions`` collapsed the anchor
    to a boolean scope sentence, ``conversation_id_for`` carries the trip only
    on the legacy no-thread path, and the run body has no other field — so a
    first message in a trip's drawer (empty history, nothing to infer from) hit
    a 20-tool-call guessing game that ended in "which trip do you mean?".

    Dates/stage/day count ride along because they are what the agent otherwise
    spends its first calls re-discovering, and the id is stated verbatim so it
    can be read straight back through the write API.
    """
    facts = [f"trip id {trip.id}"]
    if getattr(trip, "stage", None):
        facts.append(f"stage {trip.stage}")
    start, end = getattr(trip, "startDate", None), getattr(trip, "endDate", None)
    if start and end:
        facts.append(f"{start} to {end}")
    elif start:
        facts.append(f"from {start}")
    days = getattr(trip, "days", None)
    if days:
        facts.append(f"{len(days)} days")
    return f'"{trip.title}" ({", ".join(facts)})'


def focus_line(trip, focus: ChatFocus | None) -> str | None:
    """Name the day/section/block the drawer was opened from (#296 / #330).

    Resolved against the trip document the ACL gate already fetched, so the
    agent is told which day it is editing instead of having to read it out of
    the composer draft (``lib/ask-agent.ts`` pre-fills one, but the user may
    rewrite or delete it before sending).

    An id that no longer resolves (stale tab, entity deleted meanwhile) yields
    a neutral line rather than an error: this is context, and a missing
    entity must never break the turn.
    """
    if focus is None or not hasattr(trip, "days"):
        return None
    if focus.entity == "day":
        for index, day in enumerate(trip.days):
            if day.id == focus.id:
                name = day.title or day.date
                return (
                    f'day {index + 1} of {len(trip.days)} — "{name}", '
                    f"{day.date} (day id {day.id})"
                )
    elif focus.entity == "section":
        for section in getattr(trip, "sections", []) or []:
            if section.id == focus.id:
                span = ""
                if len(section.days) == 2:
                    first, last = section.days
                    span = (
                        f" covering days {first + 1}-{last + 1}"
                        if last > first
                        else f" covering day {first + 1}"
                    )
                return f'the section "{section.title}"{span} (section id {section.id})'
    elif focus.entity == "block":
        for index, day in enumerate(trip.days):
            for block in day.blocks:
                if block.id == focus.id:
                    title = block.title or "untitled"
                    return (
                        f'the {block.kind} block "{title}" on day {index + 1} '
                        f"({day.date}) (block id {block.id})"
                    )
        for section in getattr(trip, "sections", []) or []:
            for block in section.blocks:
                if block.id == focus.id:
                    title = block.title or "untitled"
                    return (
                        f'the {block.kind} block "{title}" in the section '
                        f'"{section.title}" (block id {block.id})'
                    )
    return f"a {focus.entity} that is no longer in this trip (id {focus.id})"


def identity_instructions(
    actor_sub: str,
    trip_id: str | None,
    thread_id: str | None = None,
    *,
    trip=None,
    focus: ChatFocus | None = None,
) -> str:
    """Ephemeral system prompt (Responses ``instructions``) telling the agent
    which user it is acting for — and WHICH TRIP/entity this thread is about.
    Never stored in the history chain (rebuilt and re-sent every turn).

    The anchored case names the trip (``trip_anchor_line``) and the focused
    entity (``focus_line``) outright (#330). The anchor used to be a boolean:
    the agent was told it *could* read a trip but never which one, so a thread
    with no history could only guess — the Chile + Peru drawer asked in Dutch
    for restaurants and got "which trip do you mean?" back, after 20 API calls
    of heuristics. Callers pass the ``Trip`` the ACL gate already resolved
    (``require_actor_trip_access`` returns it), so this costs no extra graph
    read.

    The envelope also carries the sub the write-API calls act as — and one
    silence rule: never narrate the machinery (tokens, M2M, minting, act-as —
    issue #158) nor any other plumbing (tools, skills, scripts, paths,
    endpoints, HTTP codes, JSON, field names — issue #179). The write path
    stays correct, the plumbing stays invisible.

    The acting sub is ALSO the impersonation instruction: the content agent's
    wrapper mints a service credential that can act as anyone, so a call
    without an explicit act-as silently inherits whatever the profile is
    configured for. Hit 2026-09-18 — a brand-new user asked "what do you know
    about me" and the agent listed Niko's seven trips, because every call
    acted as the profile's static pin. Hence: act-as this sub, explicitly,
    every call, and never another user's content.

    Deliberately NOT a gag on progress narrative: #181 also told the agent that
    step commentary was redundant, and live use showed the opposite need — a
    turn that streams only tool calls leaves the traveler with no idea what
    happened ("it just says Handled and the trip is unchanged"). The rule is
    vocabulary, not volume: speak in traveler terms, one short line at a time.
    """
    if trip_id and trip is not None:
        anchored = focus_line(trip, focus)
        where = f", and the user opened this chat about {anchored}." if anchored else "."
        anchor = (
            f"The trip this conversation is anchored to is {trip_anchor_line(trip)}"
            f"{where} They opened the chat from inside it, so treat that trip as "
            "the subject: read it before you answer, and never ask the user which "
            "trip they mean — only follow a different trip when they clearly name "
            "one. When they say 'this' or 'here', they mean the anchored trip."
        )
        scope = (
            "You may read content the acting user can read and edit content "
            "they can edit, and your write-API calls act-as this user."
        )
    elif trip_id:
        # The gate resolved no trip document (only possible when a caller
        # bypasses it): keep the id, the agent can read it itself.
        anchor = (
            f"The trip this conversation is anchored to has trip id {trip_id} — "
            "read it before you answer, and never ask the user which trip they "
            "mean unless they clearly name a different one."
        )
        scope = (
            "You may read content the acting user can read and edit content "
            "they can edit, and your write-API calls act-as this user."
        )
    else:
        anchor = ""
        scope = (
            "No trip is anchored to this thread yet. The user may ask about "
            "an existing trip (list THIS user's trips, then read the one they "
            "mean) or ask you to help PLAN a NEW trip — research freely, but "
            "never write trip content until the user anchors one. "
            "When you create a new trip in this thread, end the turn with its "
            "`/t/<trip-id>` link (the id the create call returned) so the app "
            "can offer it — the link is how the new trip surfaces, so it must "
            "not be dropped even when the turn ends mid-build."
        )
    head = (
        "You are the Kiseki trip-content agent. The person you are helping "
        f"has identity sub={actor_sub}. {scope} "
    )
    if anchor:
        head += f"{anchor} "
    return head + (
        "Every trip read and write must act AS THAT sub — pass "
        "`--act-as <that sub>` on every wrapper/script call, or set "
        "`KISEKI_ACT_AS_SUB=<that sub>` for the call. Never work as any other "
        "user: this thread belongs to this one person only, and their trips, "
        "their list and their content are the only ones you may touch or "
        "mention. Never read or summarize another user's trips, even if "
        "something in your context mentions them. "
        "Never mention tokens, M2M, minting, act-as, credentials, or how "
        "you authenticate — to the user you simply act on their behalf. If "
        "asked about access, say you act as them through Kiseki and offer "
        "to continue the task. "
        "The same silence covers your plumbing: never narrate tools, "
        "skills, scripts, file paths, endpoints, API verbs, HTTP status "
        "codes, JSON, schemas, or field names. "
        "Do keep talking to the traveler, though — say what you are doing "
        "and what you found in plain trip language ('pulling the Seoul days "
        "together now', '3 of 11 days have activities'), and end every turn "
        "that changed something with one short line naming what changed. "
        "Never claim a change you did not verify."
    )


def conversation_id_for(
    actor_sub: str,
    trip_id: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Hermes-side conversation name for chaining one thread's turns.

    The name is ALWAYS actor-scoped. The Runs API gives the body's
    ``session_id`` precedence over the ``X-Hermes-Session-Key``-derived
    session and never rebinds a declared session to the header — so a bare
    ``thread:<id>`` would chain ANY caller who presents that id onto whoever
    created the session first. Hit 2026-09-18: the SPA persists thread ids
    per browser (localStorage, no user scoping), so a fresh user on the same
    machine inherited Niko's whole Hermes session — history, memory peer and
    actor — through a shared thread id. Scoping the session name by actor
    closes it: the same thread id under two subs is two sessions.

    - ``threadId`` present (the SPA always sends one — fresh UUID per chat,
      reused on resume): ``<actor>::thread:<threadId>``. Multiple threads
      per trip; a thread may start unanchored (planning a not-yet-created
      trip) and attach a trip later without losing history.
    - No threadId (legacy callers): fall back to a sub-scoped trip anchor or
      a single general conversation — sub-scoped so two legacy clients can
      never chain onto each other's stored response.
    """
    if thread_id and thread_id.strip():
        return f"{actor_sub}::thread:{thread_id.strip()}"
    if trip_id:
        return f"{actor_sub}::trip:{trip_id.lower()}"
    return f"{actor_sub}::general"


def last_user_input(messages: list[ChatMessage]) -> dict:
    """The single new message to forward: the last user turn's content.

    History lives on the Hermes side (session chaining), so only this is
    sent as ``input``. Raises 400 when there is no user message.
    """
    for message in reversed(messages):
        if message.role == "user":
            return {"role": "user", "content": message.content}
    raise HTTPException(status_code=400, detail="No user message in request")


# ----------------------------------------------------------- agent transport
# One multiplexed base URL (``KISEKI_HERMES_URL`` → …/p/kiseki) + the
# profile-scoped key is how this relay reaches the kiseki content agent. It
# speaks the Runs API (#217): submit a run, pump its events, let clients
# attach. These functions are the IO seams tests monkeypatch; absent config →
# 503 (there is no agent to relay to).


def _require_hermes_config() -> None:
    """503 when the agent endpoint is not configured on this server."""
    if not config.KISEKI_HERMES_URL or not config.KISEKI_HERMES_KEY:
        raise HTTPException(
            status_code=503,
            detail="The kiseki agent (chat) is not configured on this server",
        )


def _hermes_headers(session_key: str | None = None) -> dict[str, str]:
    """Auth + scoping headers for the Hermes API server.

    ``session_key`` is forwarded as ``X-Hermes-Session-Key`` — the acting
    user's sub — so every session this user creates carries their sub as its
    session key. That is the seam per-user session recall filters on (the
    agent searches sessions whose session_key == the acting sub, never other
    users').
    """
    _require_hermes_config()
    headers = {
        "Authorization": f"Bearer {config.KISEKI_HERMES_KEY}",
        "Content-Type": "application/json",
    }
    if session_key:
        headers["X-Hermes-Session-Key"] = session_key
    return headers


def _hermes_url(path: str) -> str:
    """Absolute URL for one Hermes API-server path."""
    _require_hermes_config()
    return config.KISEKI_HERMES_URL.rstrip("/") + path


class RunGone(Exception):
    """Upstream has no feed/record for the run (settled long ago, or unknown)."""


async def start_chat_run(
    body: dict,
    *,
    session_key: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """Submit one agent run (``POST /v1/runs``) → its admission document.

    ``idempotency_key`` is the turn's server-derived key: Hermes fingerprints
    key + body + session key, so replaying the identical request returns the
    SAME ``run_id`` (``Idempotency-Replayed: true``) instead of starting the
    work twice. That is what makes a client retry safe (#217).
    """
    import httpx

    headers = _hermes_headers(session_key)
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(_hermes_url("/v1/runs"), json=body, headers=headers)
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Kiseki agent upstream error {resp.status_code}: {resp.text[:500]}",
        )
    doc = resp.json()
    if not isinstance(doc, dict) or not doc.get("run_id"):
        raise HTTPException(502, "Kiseki agent upstream returned no run id")
    if resp.headers.get("Idempotency-Replayed") == "true":
        doc["replayed"] = True
    return doc


async def stream_run_events(
    run_id: str, *, session_key: str | None = None
) -> AsyncIterator[str]:
    """Stream one run's lifecycle events (``GET /v1/runs/{id}/events``).

    Yields raw SSE lines for :class:`WireTranslator` (the same line-level seam
    the Responses relay used); comments/keepalives pass through and the
    translator ignores them. Raises :class:`RunGone` when upstream has no feed
    for the run — the gateway drops a run's transport once it settles, so a
    late attach lands here and the caller falls back to polling its status.
    """
    import httpx

    url = _hermes_url(f"/v1/runs/{run_id}/events")
    headers = _hermes_headers(session_key)
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("GET", url, headers=headers) as resp:
            if resp.status_code == 404:
                await resp.aread()
                raise RunGone(run_id)
            if resp.status_code != 200:
                detail = (await resp.aread()).decode("utf-8", "replace")[:500]
                raise HTTPException(
                    status_code=502,
                    detail=f"Kiseki agent upstream error {resp.status_code}: {detail}",
                )
            async for line in resp.aiter_lines():
                yield line


async def fetch_run_status(run_id: str, *, session_key: str | None = None) -> dict:
    """Poll one run (``GET /v1/runs/{id}``) — the fallback when its feed is gone.

    A terminal status is the last place the turn's answer still exists (its
    ``output``), so a relay that lost the event stream can still land the
    result instead of losing the work (#217).
    """
    import httpx

    url = _hermes_url(f"/v1/runs/{run_id}")
    headers = _hermes_headers(session_key)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code == 404:
        raise RunGone(run_id)
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Kiseki agent upstream error {resp.status_code}: {resp.text[:500]}",
        )
    doc = resp.json()
    return doc if isinstance(doc, dict) else {}


async def stop_chat_run(run_id: str, *, session_key: str | None = None) -> dict:
    """Interrupt one run upstream (``POST /v1/runs/{id}/stop``).

    The SPA's Stop control: now that a dropped connection no longer ends a
    turn, this is the ONLY thing that ends agent work early (#217).
    """
    import httpx

    url = _hermes_url(f"/v1/runs/{run_id}/stop")
    headers = _hermes_headers(session_key)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=headers)
    if resp.status_code == 404:
        raise RunGone(run_id)
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Kiseki agent upstream error {resp.status_code}: {resp.text[:500]}",
        )
    doc = resp.json()
    return doc if isinstance(doc, dict) else {}


# ------------------------------------------------------- turn registry (#217)
# A turn is owned by the RELAY, never by the browser connection that started
# it. The pump writes every translated frame into the turn's buffer; a client
# ("subscriber") only reads the buffer from a cursor. Detach is free, attach
# is a cursor, and a reconnect therefore re-attaches instead of re-sending.

#: How long a settled turn stays attachable/queryable (bounded memory).
TURN_TTL_SECONDS = 30 * 60

#: How long the status-poll fallback keeps waiting for a lost run to settle.
RUN_POLL_TIMEOUT_SECONDS = 15 * 60

#: Interval between those polls.
RUN_POLL_INTERVAL_SECONDS = 3.0

#: Idle SSE-comment cadence on an attached stream (see ``attach_turn_stream``).
ATTACH_KEEPALIVE_SECONDS = 15.0

#: ``asyncio.Queue`` payload marking "the turn is over".
_END = object()

#: Server-side turn registry (in-process: one relay process, one registry).
_TURNS: dict[str, Turn] = {}

#: ``thread_scope`` → registry key of that conversation's most recent turn.
#:
#: The turn key alone is enough for a client that kept it, but a client
#: OPENING a thread has only the thread to name it with — and the turn it must
#: not miss is exactly the one the relay is still holding. This index is what
#: makes "is anything running in this thread?" answerable (#217).
_THREAD_TURNS: dict[str, str] = {}


@dataclass
class Turn:
    """One agent turn: its upstream run + the frame buffer clients read.

    The buffer is the whole point (#217): the run's event pump belongs to the
    relay, not to a browser connection, so clients can attach, detach and
    re-attach at a ``cursor`` without the agent turn noticing — and without
    the work being lost or repeated.
    """

    key: str
    run_id: str
    #: The caller's own name for this turn, echoed back so a client that lost
    #: it can adopt it — or the relay-minted one for the legacy wire shape.
    turn_key: str | None = None
    session_key: str | None = None
    frames: list[dict] = field(default_factory=list)
    waiters: set[asyncio.Queue] = field(default_factory=set)
    status: str = "queued"
    done: bool = False
    replayed: bool = False
    task: asyncio.Task | None = None
    created_at: float = field(default_factory=time.monotonic)

    def publish(self, chunk: dict | None) -> None:
        """Append one chunk (``None`` = end marker) and wake every waiter."""
        if chunk is None:
            self.done = True
            marker: object = _END
        else:
            self.frames.append(chunk)
            marker = len(self.frames) - 1
        for queue in list(self.waiters):
            queue.put_nowait(marker)

    def finish(self) -> None:
        """Mark the turn over and release every waiter."""
        self.done = True
        for queue in list(self.waiters):
            queue.put_nowait(_END)

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self.waiters.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.waiters.discard(queue)


def turn_key_for(
    actor_sub: str,
    *,
    trip_id: str | None = None,
    thread_id: str | None = None,
    turn_key: str,
) -> str:
    """Server-side turn identity — which is also the upstream ``Idempotency-Key``.

    Scoped by acting user (and trip/thread), so a turn key can never collide
    across users and a caller can only ever address its own turn: the relay
    re-derives the key from the request instead of trusting a client-supplied
    run id. Hermes fingerprints key + body + session key, so a repeat of the
    identical request returns the existing run.
    """
    raw = f"kiseki-chat-v1|{actor_sub}|{trip_id or '-'}|{thread_id or '-'}|{turn_key}"
    return "kiseki-chat-v1-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_turn_key() -> str:
    """Mint a turn key for a caller that sent none (legacy wire shape, #217).

    Such a turn is still relay-owned — a dropped connection no longer loses
    the work — but it is not addressable afterwards (nothing can re-attach to
    it or stop it), which is exactly what the old wire offered.
    """
    return uuid.uuid4().hex


def thread_scope(
    actor_sub: str, *, trip_id: str | None = None, thread_id: str | None = None
) -> str | None:
    """Identity of a CONVERSATION (no turn): what "this thread's turn" means.

    Scoped by acting user exactly like ``turn_key_for``, so discovery can never
    reach across users. ``None`` when the caller names no thread — such a turn
    is addressable by its turn key only, there being nothing else to look it up
    by. The anchor is part of the scope because it is part of the turn key:
    callers that lost the anchor ask again without one (see
    ``latest_turn_for``).
    """
    if not thread_id:
        return None
    raw = f"kiseki-thread-v1|{actor_sub}|{trip_id or '-'}|{thread_id}"
    return "kiseki-thread-v1-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get_turn(key: str) -> Turn | None:
    """Look up a live/recent turn, sweeping expired ones first."""
    sweep_turns()
    return _TURNS.get(key)


def sweep_turns() -> None:
    """Drop settled turns past their TTL (the registry is bounded)."""
    if not _TURNS:
        return
    now = time.monotonic()
    for key, turn in list(_TURNS.items()):
        if turn.done and now - turn.created_at > TURN_TTL_SECONDS:
            _TURNS.pop(key, None)
            _forget_thread_turn(key)


def forget_turn(key: str) -> Turn | None:
    """Remove one turn from the registry (used by tests and stop)."""
    _forget_thread_turn(key)
    return _TURNS.pop(key, None)


def _forget_thread_turn(key: str) -> None:
    """Drop the conversation → turn mapping of a turn that just left."""
    for scope, mapped in list(_THREAD_TURNS.items()):
        if mapped == key:
            _THREAD_TURNS.pop(scope, None)


def _remember_thread_turn(scope: str | None, key: str) -> None:
    """Make ``key`` the turn a caller naming only this thread gets back."""
    if scope:
        _THREAD_TURNS[scope] = key


def latest_turn_for(scope: str | None) -> Turn | None:
    """The most recent turn the relay still holds for a conversation (#217).

    For a client that opened a thread without a turn key to address it with —
    the probe route asks this when it is given a ``threadId`` and no
    ``turnKey``.
    """
    if not scope:
        return None
    sweep_turns()
    key = _THREAD_TURNS.get(scope)
    if key is None:
        return None
    turn = _TURNS.get(key)
    if turn is None:  # swept between the index write and now
        _THREAD_TURNS.pop(scope, None)
    return turn


def latest_turn_for_thread(
    actor_sub: str, *, trip_id: str | None = None, thread_id: str | None = None
) -> Turn | None:
    """A conversation's latest turn, anchored or not.

    The anchor is part of the turn key, so a client asking with the trip it
    sees now can miss a turn submitted from the landing page before that trip
    existed — the ordinary "the agent created the trip mid-thread" path. Ask
    both scopes rather than making the caller know which one it was.
    """
    scopes = [thread_scope(actor_sub, trip_id=trip_id, thread_id=thread_id)]
    if trip_id:
        scopes.append(thread_scope(actor_sub, thread_id=thread_id))
    for scope in scopes:
        turn = latest_turn_for(scope)
        if turn is not None:
            return turn
    return None


def turn_status_payload(turn: Turn) -> dict:
    """What a client asks before attaching: is it running, settled, how much output?"""
    return {
        "status": "settled" if turn.done else turn.status,
        "done": turn.done,
        "cursor": len(turn.frames),
    }


async def start_turn(
    key: str,
    *,
    body: dict,
    session_key: str | None = None,
    client_turn_key: str | None = None,
    scope: str | None = None,
) -> Turn:
    """Submit the run behind ``key`` and hand it to a relay-owned pump (#217).

    The check-then-register below is await-free, so two racing requests for the
    same turn key cannot both start a pump: the loser's upstream POST is an
    idempotent replay of the same run and it then attaches to the winner's
    turn. Without the registry (relay restarted), a fresh run is admitted —
    which is exactly what a client that re-sends an old turn key asked for.

    ``client_turn_key`` is the caller's name for the turn (kept for the probe's
    reply) and ``scope`` its conversation (``thread_scope``), which is how a
    client that opens this thread later finds the turn without the key.
    """
    existing = get_turn(key)
    if existing is not None:
        _remember_thread_turn(scope, key)
        return existing
    doc = await start_chat_run(body, session_key=session_key, idempotency_key=key)
    existing = get_turn(key)
    if existing is not None:
        _remember_thread_turn(scope, key)
        return existing
    turn = Turn(
        key=key,
        run_id=str(doc["run_id"]),
        turn_key=client_turn_key,
        session_key=session_key,
        status=str(doc.get("status") or "queued"),
        replayed=bool(doc.get("replayed")),
    )
    _TURNS[key] = turn
    _remember_thread_turn(scope, key)
    turn.task = asyncio.create_task(pump_run(turn))
    return turn


async def pump_run(turn: Turn) -> None:
    """Pump one run's events into its buffer until the turn settles.

    Owned by the relay, never by a browser connection: the pump keeps running
    when every client has gone, which is what makes a dropped connection
    harmless (#217). If the event feed itself is lost (relay restarted, or the
    gateway dropped the transport for a run that finished unseen), the pump
    falls back to polling the run's status so a terminal turn still lands.
    """
    translator = WireTranslator(replay_output=True)
    try:
        async for line in stream_run_events(turn.run_id, session_key=turn.session_key):
            for chunk in translator.feed(line):
                turn.publish(chunk)
    except RunGone:
        async for line in _poll_run_until_settled(turn):
            for chunk in translator.feed(line):
                turn.publish(chunk)
    except asyncio.CancelledError:
        raise
    except HTTPException as exc:
        for chunk in translator.fail(str(exc.detail)):
            turn.publish(chunk)
    except Exception as exc:  # noqa: BLE001 — a broken feed must still settle the turn
        for chunk in translator.fail(f"agent stream error: {exc}"):
            turn.publish(chunk)
    finally:
        for chunk in translator.finish():
            turn.publish(chunk)
        turn.finish()


async def _poll_run_until_settled(turn: Turn) -> AsyncIterator[str]:
    """Yield synthetic terminal frames from the run's polled status.

    Last-resort path: the event feed is gone, so the status document is the
    only survivor. Its terminal status becomes a ``run.<status>`` frame shaped
    exactly like the feed's (``WireTranslator`` handles both identically),
    which carries the run's ``output`` as the answer.
    """
    deadline = time.monotonic() + RUN_POLL_TIMEOUT_SECONDS
    while True:
        try:
            status = await fetch_run_status(turn.run_id, session_key=turn.session_key)
        except RunGone:
            yield _synthetic_event(
                "run.failed", error="the agent turn is no longer available"
            )
            return
        state = str(status.get("status") or "")
        if state:
            turn.status = state
        if state in _TERMINAL_RUN_STATUSES:
            yield _synthetic_event(f"run.{state}", **status)
            return
        if time.monotonic() > deadline:
            yield _synthetic_event(
                "run.failed", error="the agent turn did not finish in time"
            )
            return
        await asyncio.sleep(RUN_POLL_INTERVAL_SECONDS)


def _synthetic_event(name: str, **fields) -> str:
    """One SSE ``data:`` line shaped like the gateway's run-event frames."""
    return "data: " + json.dumps({"event": name, **fields})


def _output_text(data: dict) -> str:
    """Extract a run's final text from a status/terminal event (str or parts)."""
    output = data.get("output")
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        parts = [
            part.get("text", "")
            for part in output
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return "".join(part for part in parts if isinstance(part, str))
    return ""


async def attach_turn_stream(turn: Turn, *, cursor: int = 0) -> AsyncIterator[str]:
    """Yield wire frames for ONE browser connection, from ``cursor`` onward.

    Attach/detach is free: the buffer belongs to the turn, so a client that
    reconnects with the cursor it rendered receives exactly the gap — no
    replayed text, no lost chunk — and a client that never comes back costs
    the running turn nothing (#217). Idle time is filled with keepalive
    comments (the protocol's own no-op) so a long tool call cannot be mistaken
    for a dead connection by any proxy in the path. Ends with ``[DONE]``.
    """
    queue = turn.subscribe()
    index = max(0, cursor)
    try:
        while True:
            while index < len(turn.frames):
                yield sse_data(turn.frames[index])
                index += 1
            if turn.done:
                break
            try:
                marker = await asyncio.wait_for(queue.get(), ATTACH_KEEPALIVE_SECONDS)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if marker is _END:
                continue  # the drain loop above flushes whatever is left
    finally:
        turn.unsubscribe(queue)
    yield SSE_DONE


def build_run_body(
    messages: list[ChatMessage],
    *,
    actor_sub: str,
    trip_id: str | None,
    thread_id: str | None = None,
    trip=None,
    focus: ChatFocus | None = None,
) -> dict:
    """Runs-API request body — the submitted turn, nothing else (#217).

    ``input`` is still only the new user message: history stays agent-side,
    chained by ``session_id`` (the thread's conversation name — the Runs API's
    equivalent of the Responses ``conversation`` field, checked against the
    gateway's ``_handle_runs``: body ``session_id`` wins over the
    ``X-Hermes-Session-Key`` derived session and the per-run id). The relay
    therefore never re-sends a transcript, and a replayed turn (same
    ``Idempotency-Key``) can never duplicate it.

    ``trip``/``focus`` only shape the ``instructions`` (which trip and which
    day this thread is about, #330) — the session id is unchanged, so a thread
    keeps its history across trips and an already-running turn stays
    addressable by the same key.
    """
    return {
        "model": "kiseki",
        "input": [last_user_input(messages)],
        "session_id": conversation_id_for(actor_sub, trip_id, thread_id),
        "instructions": identity_instructions(
            actor_sub, trip_id, thread_id, trip=trip, focus=focus
        ),
    }


# ------------------------------------------------------------------ trip gate

def require_actor_trip_access(actor_sub: str, trip_id: str, min_role: str = "follower"):
    """Validate the ACTING user has ``min_role`` on the named trip.

    The chat may reference a trip the caller cannot see — gate it like any
    read: the resolved actor must hold a real crew role.

    Returns the resolved ``Trip`` (not the role): callers that only want the
    verdict ignore it, and the chat route hands it to ``build_run_body`` so the
    agent can be TOLD which trip the thread is anchored to (#330) without a
    second graph read.
    """
    trip = get_trip_by_id(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if trip.visibility == "public" and min_role == "follower":
        return trip  # public trips are readable by anyone (role: none)
    role = get_trip_role_for_user(trip_id.lower(), actor_sub)
    rank = {"follower": 1, "viewer": 2, "editor": 3, "owner": 4}
    if not role or rank.get(role, 0) < rank.get(min_role, 1):
        raise HTTPException(
            status_code=403,
            detail=f"You need the '{min_role}' role on this trip to chat about it",
        )
    return trip
