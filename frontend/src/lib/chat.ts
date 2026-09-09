import { useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

/**
 * Chat wire client (issue #9 / M4) — the SPA side of `POST /api/chat`.
 *
 * Wire note: the relay speaks the legacy Vercel-ai data-stream lines
 * (`0:"<delta>"` … `d:{…finish…}`, `backend/app/chat.py` `wire_text` /
 * `wire_done` / `wire_error`). The installed AI SDK (`ai` v7 /
 * `@ai-sdk/react` v4) no longer consumes that wire natively —
 * `DefaultChatTransport` expects UI-message-chunk SSE — so this module ships
 * a small custom `ChatTransport` (the SDK's documented extension point) that
 * translates the relay lines into `UIMessageChunk`s. `useChat` still owns all
 * message/state management; only the HTTP + wire translation is custom.
 * The relay keeps dropping tool events by design — v1 renders text only.
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

/** Incremental parse state for one relay response body. */
export interface RelayParseState {
  textId: string;
  started: boolean;
  done: boolean;
}

export function initialRelayParseState(): RelayParseState {
  return { textId: "text-1", started: false, done: false };
}

/**
 * Translate ONE relay line into `UIMessageChunk`s (pure — unit-tested).
 * Accepts the bare `0:` lines the relay emits today and the `data: 0:`
 * SSE form from the M3 doc, so either framing renders.
 */
export function relayLineToChunks(
  rawLine: string,
  state: RelayParseState,
): UIMessageChunk[] {
  if (state.done) return [];
  let line = rawLine.trim();
  if (!line) return [];
  if (line.startsWith("data:")) line = line.slice("data:".length).trim();
  if (line.startsWith("0:")) {
    let delta: unknown;
    try {
      delta = JSON.parse(line.slice(2));
    } catch {
      return [];
    }
    if (typeof delta !== "string" || !delta) return [];
    const chunks: UIMessageChunk[] = [];
    if (!state.started) {
      state.started = true;
      chunks.push({ type: "text-start", id: state.textId });
    }
    chunks.push({ type: "text-delta", id: state.textId, delta });
    return chunks;
  }
  if (line.startsWith("d:")) {
    state.done = true;
    return state.started
      ? [
          { type: "text-end", id: state.textId },
          { type: "finish" },
        ]
      : [{ type: "finish" }];
  }
  if (line.startsWith("e:")) {
    state.done = true;
    let message = "The assistant failed to reply.";
    try {
      const body = JSON.parse(line.slice(2)) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // keep the default
    }
    return [{ type: "error", errorText: message }];
  }
  return [];
}

/** The kiseki relay transport: bearer-first POST + `0:`/`d:`/`e:` → chunks. */
export class KisekiChatTransport implements ChatTransport<UIMessage> {
  private readonly tripId?: string;
  private readonly threadId: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    tripId?: string;
    threadId: string;
    getToken: () => Promise<string>;
    fetchImpl?: typeof fetch;
  }) {
    this.tripId = options.tripId;
    this.threadId = options.threadId;
    this.getToken = options.getToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendMessages(options: {
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const token = await this.getToken();
    const res = await this.fetchImpl("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: options.messages.map(toBackendMessage),
        threadId: this.threadId,
        ...(this.tripId ? { tripId: this.tripId } : {}),
      }),
      signal: options.abortSignal,
    });
    if (!res.ok) {
      const message = await relayErrorMessage(res);
      if (res.status === 401 || res.status === 403) {
        throw new ChatAuthError(res.status, message);
      }
      throw new Error(`Kiseki chat failed (${res.status}): ${message}`);
    }
    if (!res.body) throw new Error("The chat response body is empty.");
    const body = res.body;
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const state = initialRelayParseState();
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              for (const chunk of relayLineToChunks(line, state)) {
                controller.enqueue(chunk);
              }
              if (state.done) break;
            }
            if (state.done) break;
          }
          if (buffer.trim()) {
            for (const chunk of relayLineToChunks(buffer, state)) {
              controller.enqueue(chunk);
            }
          }
          // The relay always ends with a terminal frame, but a cut
          // connection must still resolve the turn, never hang it.
          if (!state.done) {
            for (const chunk of relayLineToChunks("d:{}", state)) {
              controller.enqueue(chunk);
            }
          }
        } catch (err) {
          controller.enqueue({
            type: "error",
            errorText: err instanceof Error ? err.message : "Stream failed.",
          });
        } finally {
          controller.close();
        }
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // No resume in v1 — a dropped turn is re-sent, never re-attached.
    return null;
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
 * Anchored-only upload (`POST /api/files`, multipart `file` + `tripId`,
 * editor+). Returns the `/media/<trip>/<hash>.ext` URL the next user message
 * carries as an `image_url` part (images) or a text link (docs).
 */
export async function uploadChatFile(
  file: File,
  tripId: string,
  getToken: () => Promise<string>,
): Promise<UploadedChatFile> {
  const token = await getToken();
  const form = new FormData();
  form.append("file", file);
  form.append("tripId", tripId);
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

/** Plain text of a message (assistant rendering + trip-link detection). */
export function messageToText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
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
 */
export function useTripChat({
  tripId,
  threadId,
  getToken,
  onFinish,
}: UseTripChatOptions) {
  const transport = useMemo(
    () => new KisekiChatTransport({ tripId, threadId, getToken }),
    [tripId, threadId, getToken],
  );
  const chat = useChat({
    id: threadId,
    transport,
    ...(onFinish
      ? {
          onFinish: ({ message }: { message: UIMessage }) => {
            onFinish(messageToText(message));
          },
        }
      : {}),
  });
  return chat;
}
