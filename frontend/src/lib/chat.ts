import { useCallback, useEffect, useMemo } from "react";
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

/** A turn in flight (issue #217): the relay's identity for it, plus how many
 *  of its frames this client has already rendered. Persisting the pair is what
 *  turns a dropped connection into an attach at the exact frame instead of a
 *  re-send of the whole turn. */
export interface TurnState {
  turnKey: string;
  cursor: number;
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
      const state = value as { turnKey?: unknown; cursor?: unknown } | null;
      if (typeof state?.turnKey === "string" && state.turnKey) {
        const cursor = typeof state.cursor === "number" ? state.cursor : 0;
        out[key] = {
          turnKey: state.turnKey,
          cursor: cursor > 0 ? Math.floor(cursor) : 0,
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
        const turn = { turnKey: newTurnKey(), cursor: 0 };
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

  /** True while the relay may still hold frames this client hasn't rendered,
   *  i.e. a reconnect can CONTINUE the turn instead of re-sending it. */
  get resumable(): boolean {
    return this.state.turn !== null;
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
   * one the relay no longer knows after a restart) hands the caller back the
   * pre-#217 behaviour: re-send via `regenerate()`.
   *
   * Note the SDK renders the continued output as a NEW assistant message —
   * the partial one stays visible and the tail lands after it.
   */
  override async reconnectToStream(): Promise<
    ReadableStream<UIMessageChunk> | null
  > {
    const turn = this.state.turn;
    if (!turn) return null;
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
          ...(this.tripId ? { tripId: this.tripId } : {}),
        }),
      });
    } catch {
      // Offline, DNS, aborted — nothing to attach to, so let the caller decide
      // (it falls back to re-sending, which fails visibly if the net is down).
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new ChatAuthError(res.status, await relayErrorMessage(res));
    }
    if (!res.ok || !res.body) return null;
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

  /**
   * Continue a dropped turn where it stopped (issue #217) instead of
   * re-sending it: attaches to the relay's remaining frames. False = there is
   * nothing to attach to (no turn yet, or one the relay no longer knows), so
   * the caller re-sends — the pre-#217 behaviour, kept as the fallback.
   */
  const resumeTurn = useCallback(async (): Promise<boolean> => {
    if (!transport.resumable) return false;
    await chat.resumeStream();
    return true;
  }, [transport, chat]);

  return { ...chat, resumeTurn };
}
