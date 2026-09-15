import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";

/**
 * Chat wire client (issue #9 / M4) — the SPA side of `POST /api/chat`.
 *
 * Wire note: the relay speaks the stock Vercel-ai UI-message-stream v1 SSE
 * protocol (`data: {chunk}` events … `data: [DONE]`, header
 * `x-vercel-ai-ui-message-stream: v1` — see `backend/app/chat.py`), which
 * the installed AI SDK (`ai` v7 / `@ai-sdk/react` v4)
 * `DefaultChatTransport` parses natively. This module therefore subclasses
 * `DefaultChatTransport` for auth headers + request shaping only:
 * `prepareSendMessagesRequest` maps the transcript to the relay's
 * `{messages, threadId, tripId}` body, and a fetch wrapper maps 401/403 to
 * `ChatAuthError`. `useChat` still owns all message/state management.
 *
 * Agent tool calls (issue #151) arrive as activity rows — one per
 * `data-kiseki-activity` data part (issue #157: the relay used to emit
 * synthetic tool-lifecycle chunks, but the AI SDK's tool state machine never
 * settled undeclared-tool parts into the shape the reader expected, so
 * nothing rendered). Data parts need no declared tool, trigger no client
 * execution and no resubmit; the panel reads them from message parts via
 * `messageActivities`. The relay maps real tool names to friendly labels
 * server-side; raw names never reach the UI.
 */

const THREADS_KEY = "kiseki.chat.threads.v1";

/** Chat context key: the trip id inside a trip, `"general"` on landing. */
export function chatContextKey(tripId?: string): string {
  return tripId ?? "general";
}

function readThreads(): Record<string, string> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return {};
    const raw = window.localStorage.getItem(THREADS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** The persisted Hermes thread for this context (null = none yet). */
export function loadThreadId(context: string): string | null {
  const id = readThreads()[context];
  return typeof id === "string" && id ? id : null;
}

function randomThreadId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `thread-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/** Rotate a fresh thread for this context (old thread stays resumable by id). */
export function newThreadId(context: string): string {
  const id = randomThreadId();
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(
        THREADS_KEY,
        JSON.stringify({ ...readThreads(), [context]: id }),
      );
    }
  } catch {
    // persistence is a convenience — a chat without it still works
  }
  return id;
}

/** Backend `ChatMessage` shape (`backend/app/chat.py`): content is a plain
 *  string or an array of `{type: "text", text}` / `{type: "image_url",
 *  image_url: {url}}` parts. Unknown part shapes are rejected upstream (400). */
export interface BackendChatMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
  id?: string;
}

function absoluteUrl(url: string): string {
  try {
    if (typeof window !== "undefined") {
      return new URL(url, window.location.origin).href;
    }
  } catch {
    // fall through — keep the URL as-is
  }
  return url;
}

/** Map one `UIMessage` to the relay's message shape. Image file parts become
 *  `image_url` parts (the agent's vision input — URLs are absolutized so the
 *  agent can fetch them over HTTPS); every other file becomes a text link
 *  the agent fetches. Pure-text messages stay plain strings. */
export function toBackendMessage(message: UIMessage): BackendChatMessage {
  const texts: string[] = [];
  const images: string[] = [];
  const links: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      texts.push(part.text);
    } else if (part.type === "file") {
      const url = absoluteUrl(part.url);
      if (part.mediaType === "image" || part.mediaType.startsWith("image/")) {
        images.push(url);
      } else {
        const label = part.filename ?? url;
        links.push(`[${label}](${url})`);
      }
    }
  }
  const text = [...texts, ...links].filter(Boolean).join("\n\n");
  if (images.length === 0) {
    return { role: message.role, content: text, id: message.id };
  }
  const parts: Array<Record<string, unknown>> = images.map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  if (text) {
    parts.unshift({ type: "text", text });
  }
  return { role: message.role, content: parts, id: message.id };
}

/** 401/403 from the relay — the session is gone or the actor has no access.
 *  Never rendered as a blank: the panel routes these to sign-in/no-access. */
export class ChatAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatAuthError";
    this.status = status;
  }
}

async function relayErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // not JSON — fall through to the raw text
  }
  return text || `Request failed (${res.status})`;
}

/** A turn in flight (issue #217): the relay's identity for it, how many of its
 *  frames this client has already rendered, and the anchors a later attach
 *  needs. Persisting them is what turns a dropped connection into a resumed
 *  turn instead of a re-send of the whole thing. */
export interface TurnState {
  turnKey: string;
  cursor: number;
  /** The trip (if any) this turn was SUBMITTED with. It is part of the turn's
   *  identity on the relay, so an attach has to reuse it as-is — a thread that
   *  gained a trip after the turn started would otherwise address a turn that
   *  does not exist. `undefined` = not recorded (state stored by an older
   *  bundle), which the caller must treat as "unknown", not as "no trip". */
  tripId?: string | null;
  /** Id of the user message that opened this turn: everything after it in the
   *  transcript was produced by this turn and is rebuilt from the relay's
   *  frames on resume. Absent = not recorded. */
  userMessageId?: string | null;
}

const TURNS_KEY = "kiseki.chat.turns.v1";

/** How often the frame cursor reaches storage (never once per chunk). */
const PERSIST_INTERVAL_MS = 500;

function readTurnStates(): Record<string, TurnState> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return {};
    const raw = window.localStorage.getItem(TURNS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, TurnState> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const state = value as {
        turnKey?: unknown;
        cursor?: unknown;
        tripId?: unknown;
        userMessageId?: unknown;
      } | null;
      if (typeof state?.turnKey === "string" && state.turnKey) {
        const cursor = typeof state.cursor === "number" ? state.cursor : 0;
        // Anchors are carried over only when they were recorded: an older
        // bundle's state has neither, and inventing values there would send a
        // resume down a wrong turn identity.
        const anchors: Pick<TurnState, "tripId" | "userMessageId"> = {};
        if (typeof state.tripId === "string" || state.tripId === null) {
          anchors.tripId = state.tripId;
        }
        if (
          typeof state.userMessageId === "string" ||
          state.userMessageId === null
        ) {
          anchors.userMessageId = state.userMessageId;
        }
        out[key] = {
          turnKey: state.turnKey,
          cursor: cursor > 0 ? Math.floor(cursor) : 0,
          ...anchors,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember the turn this thread is rendering (null clears it). */
export function saveTurnState(threadId: string, state: TurnState | null): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const all = readTurnStates();
    if (state) all[threadId] = state;
    else delete all[threadId];
    window.localStorage.setItem(TURNS_KEY, JSON.stringify(all));
  } catch {
    // persistence is a convenience — a chat without it still works
  }
}

/** The turn a reloaded thread may still attach to (null = none). */
export function loadTurnState(threadId: string): TurnState | null {
  return readTurnStates()[threadId] ?? null;
}

/** A fresh turn key per submission: the relay derives the turn identity (and
 *  the upstream idempotency key) from it, so a retried request can never
 *  start the work twice. */
function newTurnKey(): string {
  try {
    return `turn-${crypto.randomUUID()}`;
  } catch {
    return `turn-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/** What the relay says it is holding for a turn (issue #217). `known: false`
 *  means it has nothing for that key/thread: the work is not recoverable, and
 *  a POST at that key would start a NEW turn rather than attach to the old
 *  one — which is why the probe, not the attach, decides. `cursor` is how many
 *  frames it can still replay. */
export interface TurnStatus {
  known: boolean;
  turnKey?: string;
  runId?: string;
  status?: string;
  done?: boolean;
  cursor?: number;
}

/**
 * Ask the relay about a turn WITHOUT touching it (issue #217).
 *
 * Read-only, so asking is always safe — it never submits work, never attaches,
 * never advances anything. Addressed by the `turnKey` the client minted, or by
 * `threadId` alone for a thread opened without one (the reply carries the turn
 * key, so a client that lost it can adopt it).
 *
 * Failures are deliberately NOT folded into `known: false`: "the relay is
 * unreachable" and "the relay holds nothing" lead to opposite decisions, so a
 * transport error throws (and an expired session throws `ChatAuthError`) while
 * only a real negative answer comes back as `known: false`.
 */
export async function getTurnStatus(args: {
  threadId: string;
  turnKey?: string | null;
  tripId?: string | null;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<TurnStatus> {
  const fetchImpl: typeof fetch =
    args.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const query = new URLSearchParams({ threadId: args.threadId });
  if (args.turnKey) query.set("turnKey", args.turnKey);
  if (args.tripId) query.set("tripId", args.tripId);
  const res = await fetchImpl(`/api/chat/turn?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${await args.getToken()}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ChatAuthError(res.status, await relayErrorMessage(res));
  }
  if (!res.ok) {
    throw new Error(`Turn status failed (${res.status})`);
  }
  const body = (await res.json()) as Partial<TurnStatus> | null;
  return {
    ...body,
    known: body?.known === true,
  };
}

/** The kiseki relay transport: DefaultChatTransport + bearer auth +
 *  `{messages, threadId, tripId}` request shaping + 401/403 mapping. */
export class KisekiChatTransport extends DefaultChatTransport<UIMessage> {
  constructor(options: {
    tripId?: string;
    threadId: string;
    getToken: () => Promise<string>;
    fetchImpl?: typeof fetch;
    /** A turn carried over from this thread's last session (a reload mid-turn). */
    turn?: TurnState | null;
  }) {
    const tripId = options.tripId;
    const threadId = options.threadId;
    const getToken = options.getToken;
    // N.B. never pass `fetch` itself through: calling the native function as
    // a member (`impl(...)`) is brand-checked — "Failed to execute 'fetch' on
    // 'Window': Illegal invocation" (seen live on the landing chat,
    // v0.23.26). The wrapper calls bare `fetch(...)` (this = undefined),
    // which is always legal.
    const fetchImpl: typeof fetch =
      options.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    // Shared with the request hook below, which runs before `this` is usable.
    const state: { turn: TurnState | null } = {
      turn: options.turn ? { ...options.turn } : null,
    };
    super({
      api: "/api/chat",
      headers: async () => ({
        Authorization: `Bearer ${await getToken()}`,
      }),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fetchImpl(input, init);
        if (res.status === 401 || res.status === 403) {
          throw new ChatAuthError(res.status, await relayErrorMessage(res));
        }
        return res;
      }) as typeof fetch,
      prepareSendMessagesRequest: ({ messages }) => {
        // Every submission is a NEW turn. Minting the key here (and storing
        // it) is what makes the turn addressable later: the relay derives the
        // upstream idempotency key from it, so a retry can never submit the
        // same turn twice, and a reconnect re-attaches to THIS turn instead
        // of starting another one (issue #217).
        //
        // The two anchors ride along for the same reason: the trip the turn
        // was submitted under (the relay keys the turn by it), and the user
        // message that opened it (where a resume rebuilds the transcript).
        const opening = messages[messages.length - 1];
        const turn: TurnState = {
          turnKey: newTurnKey(),
          cursor: 0,
          tripId: tripId ?? null,
          userMessageId:
            typeof opening?.id === "string" && opening.id ? opening.id : null,
        };
        state.turn = turn;
        saveTurnState(threadId, turn);
        return {
          body: {
            messages: messages.map(toBackendMessage),
            threadId,
            turnKey: turn.turnKey,
            ...(tripId ? { tripId } : {}),
          },
        };
      },
    });
    this.state = state;
    this.threadId = threadId;
    this.tripId = tripId;
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
  }

  private readonly state: { turn: TurnState | null };
  private readonly threadId: string;
  private readonly tripId?: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  /** Throttle gate for the persisted cursor (see `onFrame`). */
  private lastPersisted = 0;
  /** Set by every `reconnectToStream()` that came back empty. */
  private attachFailed = false;

  /** True while the relay may still hold frames this client hasn't rendered,
   *  i.e. a reconnect can CONTINUE the turn instead of re-sending it. */
  get resumable(): boolean {
    return this.state.turn !== null;
  }

  /** The turn this transport would attach to (null = none). The caller needs
   *  its anchors to rebuild the transcript: see `turnBoundary`. */
  get turnState(): TurnState | null {
    return this.state.turn;
  }

  /** Whether the last `reconnectToStream()` came back with nothing. The SDK
   *  treats a null reconnect as "no stream to resume" and says nothing about
   *  it, so a caller that has already dropped the partial it was rendering
   *  reads this to know it must put that back. */
  get lastAttachFailed(): boolean {
    return this.attachFailed;
  }

  /** Point the next reconnect at a frame index, 0 = the turn's first frame.
   *  Resuming from 0 is how a client REBUILDS a turn into one message: the
   *  relay replays every frame and the transcript starts the turn over. */
  rewind(cursor: number): void {
    if (!this.state.turn) return;
    this.state.turn.cursor = cursor > 0 ? Math.floor(cursor) : 0;
  }

  /** Forget the turn. Called when the relay says it is holding nothing: the
   *  state would otherwise offer a Reconnect whose POST, at a key the relay
   *  has forgotten, STARTS the turn again. */
  forgetTurn(): void {
    this.state.turn = null;
    saveTurnState(this.threadId, null);
  }

  override async sendMessages(
    options: Parameters<DefaultChatTransport<UIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    return this.counted(await super.sendMessages(options));
  }

  /**
   * Re-attach to the turn this client was rendering (issue #217).
   *
   * The relay keeps a turn's frames, so a dropped connection asks for the
   * ones it never saw (`turnKey` + `cursor`) and the agent keeps working
   * meanwhile — no re-send, no duplicated work. Returning null (no turn, or
   * one the relay no longer knows after a restart) sets `lastAttachFailed`,
   * and the caller reports that outage: a turn the relay has swept cannot be
   * recovered, and re-sending it is never a fallback (issue #256).
   *
   * Callers that resume after dropping the part of the turn already on
   * screen rewind to 0 first, so the whole turn is rebuilt in ONE assistant
   * message: the SDK cannot extend an interrupted one, it appends a second
   * (see `resumeTurn`).
   *
   * The trip the turn was SUBMITTED with is the anchor sent back, not the one
   * on screen now: the relay keys a turn by it, so a thread that gained a trip
   * mid-conversation would otherwise address a different, non-existent turn.
   */
  override async reconnectToStream(): Promise<
    ReadableStream<UIMessageChunk> | null
  > {
    this.attachFailed = false;
    const turn = this.state.turn;
    if (!turn) {
      this.attachFailed = true;
      return null;
    }
    const anchor =
      turn.tripId === undefined ? this.tripId : turn.tripId ?? undefined;
    let res: Response;
    try {
      res = await this.fetchImpl("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${await this.getToken()}`,
        },
        body: JSON.stringify({
          turnKey: turn.turnKey,
          cursor: turn.cursor,
          threadId: this.threadId,
          ...(anchor ? { tripId: anchor } : {}),
        }),
      });
    } catch {
      // Offline, DNS, aborted — nothing attached, so let the caller report the
      // outage (`resumable` stays true, so the attach offer stays with it).
      this.attachFailed = true;
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new ChatAuthError(res.status, await relayErrorMessage(res));
    }
    if (!res.ok || !res.body) {
      this.attachFailed = true;
      return null;
    }
    return this.counted(this.processResponseStream(res.body));
  }

  /** Count the frames the UI consumes: `cursor` is the index a reconnect
   *  replays from, so it must advance exactly once per rendered chunk. */
  private counted(
    stream: ReadableStream<UIMessageChunk>,
  ): ReadableStream<UIMessageChunk> {
    return stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform: (chunk, controller) => {
          this.onFrame(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
  }

  private onFrame(chunk: UIMessageChunk): void {
    const turn = this.state.turn;
    if (!turn) return;
    turn.cursor += 1;
    const meta = (chunk as { messageMetadata?: { interrupted?: unknown } })
      .messageMetadata;
    if (
      chunk.type === "error" ||
      (chunk.type === "finish" && meta?.interrupted !== true)
    ) {
      // Terminal and clean (or failed): the turn is over, so keeping the state
      // would only offer a Reconnect that attaches to nothing.
      this.state.turn = null;
      saveTurnState(this.threadId, null);
      return;
    }
    // A cut `finish` (`interrupted: true`) is exactly what the cursor is for:
    // keep it, throttled, so a reload can resume from here.
    const now = Date.now();
    if (now - this.lastPersisted < PERSIST_INTERVAL_MS) return;
    this.lastPersisted = now;
    saveTurnState(this.threadId, turn);
  }
}

/** A file uploaded into the trip's media namespace, ready to attach. */
export interface UploadedChatFile {
  url: string;
  name: string;
  mediaType: string;
  isImage: boolean;
}

/**
 * Upload (`POST /api/files`, multipart `file` + optional `tripId`).
 *
 * With a `tripId` (editor+ gate): the file lands in the trip's media
 * namespace and the returned `/media/<trip>/<hash>.ext` URL is what
 * `resolve_media_urls` emits. Without one (landing chat, before any trip
 * exists): the file stages in the user's inbox and comes back as an
 * unguessable `/inbox/<hash>.ext` URL — the agent promotes it into the trip
 * it creates via `/api/files/promote`. Either way the next user message
 * carries the URL as an `image_url` part (images) or a text link (docs).
 */
export async function uploadChatFile(
  file: File,
  tripId: string | undefined,
  getToken: () => Promise<string>,
): Promise<UploadedChatFile> {
  const token = await getToken();
  const form = new FormData();
  form.append("file", file);
  if (tripId) form.append("tripId", tripId);
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const message = await relayErrorMessage(res);
    if (res.status === 401 || res.status === 403) {
      throw new ChatAuthError(res.status, message);
    }
    throw new Error(`Upload failed (${res.status}): ${message}`);
  }
  const body = (await res.json()) as { url?: unknown };
  if (typeof body.url !== "string" || !body.url) {
    throw new Error("Upload failed: the server returned no URL.");
  }
  return {
    url: body.url,
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    isImage: file.type.startsWith("image/"),
  };
}

/** Persisted per-thread transcript (issue #152) — `UIMessage[]` serialized
 *  as JSON, capped so one long thread can't evict the others' quota. */
const TRANSCRIPTS_KEY = "kiseki.chat.transcripts.v1";
const MAX_STORED_MESSAGES = 100;

function readTranscripts(): Record<string, UIMessage[]> {
  try {
    if (typeof window === "undefined" || !window.localStorage) return {};
    const raw = window.localStorage.getItem(TRANSCRIPTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, UIMessage[]> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) out[key] = value as UIMessage[];
    }
    return out;
  } catch {
    return {};
  }
}

/** The restored transcript for a thread (empty = none stored yet). */
export function loadTranscript(threadId: string): UIMessage[] {
  try {
    const stored = readTranscripts()[threadId];
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Persist a thread's transcript (fire-and-forget — quota errors drop it). */
export function saveTranscript(threadId: string, messages: UIMessage[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const tail = messages.slice(-MAX_STORED_MESSAGES);
    window.localStorage.setItem(
      TRANSCRIPTS_KEY,
      JSON.stringify({ ...readTranscripts(), [threadId]: tail }),
    );
  } catch {
    // persistence is a convenience — a chat without it still works
  }
}

/** Plain text of a message (assistant rendering + trip-link detection). */
export function messageToText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Agent activity rows for one assistant message (issue #151) — one entry
 * per `data-kiseki-activity` data part the relay emitted, in message order.
 * `label` is the relay's friendly text ("Searching the web…"); `done` flips
 * when the call's output lands. Messages without activity parts yield [].
 */
export interface ChatActivity {
  label: string;
  done: boolean;
}

/** The relay's activity data-part type (issue #157) — a `data-*` custom
 *  part, NOT a tool part: no client execution, no resubmit, no declared
 *  tool needed. The SDK stores the chunk verbatim as a message part and
 *  updates `.data` in place on the completing chunk (same part `id`). */
export const ACTIVITY_PART = "data-kiseki-activity";

export function messageActivities(message: UIMessage): ChatActivity[] {
  const rows: ChatActivity[] = [];
  for (const part of message.parts) {
    if (part.type !== ACTIVITY_PART) continue;
    const data = (part as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const { label, done } = data as { label?: unknown; done?: unknown };
    rows.push({
      label: typeof label === "string" && label ? label : "Working…",
      done: done === true,
    });
  }
  return rows;
}

/** Whether the last assistant message ended on a CUT connection (issue #152).

 * The relay marks the terminal `finish` chunk's `messageMetadata` with
 * `{interrupted: true}` when the upstream stream closed without
 * `response.completed`/`[DONE]` — a dropped turn the UI must surface with
 * Reconnect, never as a clean completion. The SDK persists chunk
 * `messageMetadata` onto the assistant message, so the flag survives as
 * `message.metadata`. */
export function messageInterrupted(message: UIMessage): boolean {
  const meta = message.metadata as { interrupted?: unknown } | undefined;
  return (
    typeof meta === "object" &&
    meta !== null &&
    (meta as { interrupted?: unknown }).interrupted === true
  );
}

/** Trip ids the agent linked (`/t/<uuid>`) — after a create, the landing
 *  offers the newest one as an "Open trip" button. */
export function findTripIds(text: string): string[] {
  const ids: string[] = [];
  const re = /\/t\/([0-9a-fA-F-]{36})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

export interface UseTripChatOptions {
  tripId?: string;
  threadId: string;
  getToken: () => Promise<string>;
  onFinish?: (text: string) => void;
}

/** How a thread's in-flight turn was picked up when the thread opened. */
export type TurnRecovery = "idle" | "checking" | "attached" | "unavailable";

/** When each thread was last looked at for a turn to recover, in this page
 *  load (see `RECOVERY_GUARD_MS`). */
const recoveredAt = new Map<string, number>();

/** Attaching twice to the same turn would rewind a stream that is already
 *  replaying, so an attempt this soon after the previous one is the same
 *  attempt coming back — React StrictMode double-invokes effects in
 *  development, and the panel remounts a thread on rotate. A genuinely later
 *  mount (navigating back to the trip) is past the window and recovers again. */
const RECOVERY_GUARD_MS = 2000;

/**
 * Where a turn's own messages start (issue #217): everything from here on was
 * produced by that turn, and a resume rebuilds it from the relay's frames.
 * The anchor is the user message that OPENED the turn, so a transcript that
 * was trimmed to its most recent messages still resolves (its opening message
 * is always among them).
 *
 * Without an anchor (state stored by a bundle that recorded none) only a tail
 * the relay itself CUT is dropped: that is the one thing known to be a partial
 * of this turn, and guessing would delete real history.
 */
export function turnBoundary(
  messages: UIMessage[],
  userMessageId?: string | null,
): number {
  if (userMessageId) {
    const index = messages.findIndex((message) => message.id === userMessageId);
    if (index >= 0) return index + 1;
  }
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && messageInterrupted(last)) {
    return messages.length - 1;
  }
  return messages.length;
}

/** The bit of `useChat`'s surface a resume needs — kept structural so the
 *  decision logic below can be driven from tests without a DOM. */
export interface ResumeSurface {
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  resumeStream: () => Promise<void>;
}

/**
 * Pick up the turn this thread was left in the middle of (issue #217).
 *
 * Asks the relay FIRST (`status`): attaching at a turn key the relay has
 * forgotten does not fail — it STARTS the turn, the opposite of resuming — so
 * only a turn the relay says it is holding is attached to, and one it has
 * forgotten is forgotten here too. That probe is also what makes a turn which
 * SETTLED while nobody was watching recoverable at all: the relay still has
 * its frames, and replaying them delivers the answer the client never saw.
 *
 * Returns false when there is nothing to attach to. That is NOT a re-send
 * trigger (issue #256): a turn the relay has swept is gone for good, so the
 * caller reports the outcome instead — `recovery` says what the attach did.
 */
export async function resumeStoredTurn(args: {
  transport: KisekiChatTransport;
  chat: ResumeSurface;
  /** How to ask the relay about the turn. Injectable for tests. */
  status: (turn: TurnState) => Promise<TurnStatus>;
}): Promise<boolean> {
  const { transport, chat } = args;
  const turn = transport.turnState;
  if (!turn) return false;
  let status: TurnStatus;
  try {
    status = await args.status(turn);
  } catch {
    // Unreachable relay, or a session that needs re-auth: "could not ask" is
    // not "nothing there", so keep the turn and report no attach.
    return false;
  }
  if (!status.known) {
    transport.forgetTurn();
    return false;
  }
  // Rebuild the turn into ONE assistant message. The SDK cannot extend the
  // message it was streaming when the connection went — it appends the
  // resumed stream as a second message, starting mid-sentence — so the part
  // of the turn already on screen is dropped and the stream is rewound to the
  // turn's first frame, which the relay replays in full.
  const before = chat.messages;
  const boundary = turnBoundary(before, turn.userMessageId);
  const dropped = before.slice(boundary);
  if (dropped.length > 0) chat.setMessages(before.slice(0, boundary));
  transport.rewind(0);
  await chat.resumeStream();
  if (transport.lastAttachFailed) {
    // Nothing came back (offline mid-attach): put the transcript back as it
    // was rather than leaving a hole where the partial used to be.
    if (dropped.length > 0) chat.setMessages(before);
    return false;
  }
  return true;
}

/** How soon after a foreground/online event a second one is the same event
 *  (see the return probes in `useTripChat`). */
const RETURN_GUARD_MS = 2000;

/**
 * Whether "the user is back" should attach to this thread's turn (#237).
 *
 * A phone loses a turn in ways the #227 shape cannot see: the screen turns
 * off mid-answer and the socket dies, so no terminal `finish` chunk ever
 * arrives (`interrupted` can never be set) and the panel stays MOUNTED (the
 * mount probe never runs). The relay, meanwhile, keeps working and holds the
 * turn's frames — so the only thing missing was asking again.
 *
 * Every exclusion matters: without a turn state the relay holds nothing this
 * client can address (and a POST at a forgotten key would START a turn, the
 * opposite of recovering one); `submitted`/`streaming` means the turn is
 * already arriving; `checking` is a probe in flight and attaching twice would
 * rewind a stream that is already replaying. Kept as a predicate so the rule
 * is testable apart from the DOM.
 */
export function shouldAttachToTurn(args: {
  resumable: boolean;
  status: string;
  recovery: TurnRecovery;
  attaching: boolean;
}): boolean {
  if (!args.resumable || args.attaching) return false;
  if (args.status === "submitted" || args.status === "streaming") return false;
  return args.recovery !== "checking";
}

/**
 * `useChat` bound to a trip context (or the general landing chat).
 * `threadId` is caller-owned (persisted per context in localStorage) — the
 * panel remounts the thread on rotate so chat state restarts cleanly.
 *
 * Transcript persistence (issue #152): the thread's messages restore from
 * localStorage on mount (`loadTranscript`) and save on every change — a
 * reload or app switch keeps the visible transcript. Server history stays
 * the source of truth for continuation (the relay forwards only the new
 * input; Hermes chains the rest via `thread:<threadId>`), so a restored
 * transcript is display state, never re-sent.
 */
export function useTripChat({
  tripId,
  threadId,
  getToken,
  onFinish,
}: UseTripChatOptions) {
  const transport = useMemo(
    () =>
      new KisekiChatTransport({
        tripId,
        threadId,
        getToken,
        // A turn this thread was mid-way through survives a reload: the stored
        // cursor is where the last connection stopped rendering (#217).
        turn: loadTurnState(threadId),
      }),
    [tripId, threadId, getToken],
  );
  const chat = useChat({
    id: threadId,
    transport,
    messages: loadTranscript(threadId),
    ...(onFinish
      ? {
          onFinish: ({ message }: { message: UIMessage }) => {
            onFinish(messageToText(message));
          },
        }
      : {}),
  });
  // Persist the visible transcript so a reload / app switch restores it.
  const { messages } = chat;
  useEffect(() => {
    saveTranscript(threadId, messages);
  }, [threadId, messages]);

  const [recovery, setRecovery] = useState<TurnRecovery>("idle");

  /**
   * Continue (or recover) this thread's turn — see `resumeStoredTurn`. Owns the
   * `recovery` state so every caller reports the same thing (issue #256): the
   * `.then(...).catch(...)` dance used to live at each call site, so the panel
   * could not tell "the relay has forgotten this turn" from "nobody asked yet"
   * and fell back to re-sending. `resumeStoredTurn` resolves `false` in exactly
   * that forgotten case, and it never re-sends.
   */
  const resumeTurn = useCallback(async (): Promise<boolean> => {
    setRecovery("checking");
    try {
      const resumed = await resumeStoredTurn({
        transport,
        chat,
        status: (turn) =>
          getTurnStatus({
            threadId,
            turnKey: turn.turnKey,
            tripId: turn.tripId,
            getToken,
          }),
      });
      setRecovery(resumed ? "attached" : "unavailable");
      return resumed;
    } catch {
      setRecovery("unavailable");
      return false;
    }
  }, [transport, chat, threadId, getToken]);

  // Opening a thread picks up whatever the relay is still holding for it. This
  // is the half of resumption that was missing: the work had always survived
  // the disconnect, but nothing ever ASKED about it, so a reopened thread sat
  // there looking finished — no spinner, no answer, nothing — while the agent
  // was still working. Runs once per thread.
  const recovered = useRef<string | null>(null);
  useEffect(() => {
    if (recovered.current === threadId) return;
    // A remount must not attach a second time to a stream that is already
    // replaying: the ref doesn't survive one, so the recency of the last
    // attempt does (see `RECOVERY_GUARD_MS`).
    const now = Date.now();
    if (now - (recoveredAt.get(threadId) ?? 0) < RECOVERY_GUARD_MS) return;
    recoveredAt.set(threadId, now);
    recovered.current = threadId;
    if (!transport.resumable) return;
    void resumeTurn();
  }, [threadId, transport, resumeTurn]);

  /** "The user came back to a turn that never finished" (#237) — the case the
   *  mount probe above cannot reach, because the panel was never unmounted.
   *  See `shouldAttachToTurn` for the guards. */
  const attaching = useRef(false);
  const recoveryRef = useRef<TurnRecovery>("idle");
  useEffect(() => {
    recoveryRef.current = recovery;
  }, [recovery]);

  const attachLostTurn = useCallback((): void => {
    if (
      !shouldAttachToTurn({
        resumable: transport.resumable,
        status: chat.status,
        recovery: recoveryRef.current,
        attaching: attaching.current,
      })
    ) {
      return;
    }
    attaching.current = true;
    void resumeTurn().finally(() => {
      attaching.current = false;
    });
  }, [transport, chat.status, resumeTurn]);

  // The connection dropped mid-turn. #227's banner keys on the relay's CUT
  // `finish` (`interrupted: true`), which the relay writes when the UPSTREAM
  // stream ends without a terminal event; when the CLIENT's own socket dies —
  // screen off, wifi gone, tunnel dropped — no terminal chunk arrives at all,
  // so the transport error is the only evidence of the drop. Ask the relay
  // regardless: while it still holds the turn, attaching replays what was
  // missed instead of re-sending the message.
  const errored = useRef<unknown>(null);
  useEffect(() => {
    if (!chat.error || errored.current === chat.error) return;
    errored.current = chat.error;
    attachLostTurn();
  }, [chat.error, attachLostTurn]);

  // ...and RETURNING is the other half: after a screen-off drop the error may
  // have rendered while nobody was looking (or a soft drop surfaced none at
  // all). Foregrounding the app, or getting the network back, is the user
  // asking for the answer, so ask the relay then too.
  const lastReturn = useRef(0);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastReturn.current < RETURN_GUARD_MS) return;
      lastReturn.current = now;
      attachLostTurn();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("online", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("online", onReturn);
    };
  }, [attachLostTurn]);

  // `resumable` (#256): does this thread still hold a turn key the relay can be
  // asked to attach to? The panel's `chatOutage` needs it to tell "the relay is
  // still holding this turn — offer Reconnect (an attach, never a re-send)"
  // from "the turn is gone — say nothing, or offer an explicit re-run when
  // nothing arrived at all". Read at render time; every flip is accompanied by
  // a `recovery` transition, which re-renders.
  return { ...chat, resumeTurn, recovery, resumable: transport.resumable };
}
