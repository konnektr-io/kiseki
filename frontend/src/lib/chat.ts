import { useMemo } from "react";
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

/** The kiseki relay transport: DefaultChatTransport + bearer auth +
 *  `{messages, threadId, tripId}` request shaping + 401/403 mapping. */
export class KisekiChatTransport extends DefaultChatTransport<UIMessage> {
  constructor(options: {
    tripId?: string;
    threadId: string;
    getToken: () => Promise<string>;
    fetchImpl?: typeof fetch;
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
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages: messages.map(toBackendMessage),
          threadId,
          ...(tripId ? { tripId } : {}),
        },
      }),
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
