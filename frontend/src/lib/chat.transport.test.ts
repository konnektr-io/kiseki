// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";

import { getTurnStatus, KisekiChatTransport } from "./chat";

/* `KisekiChatTransport` (DefaultChatTransport subclass): request shaping
 * (`{messages, threadId, tripId}` + bearer token) and 401/403 mapping. The
 * response bodies are UI-message-stream v1 SSE — the same shape the relay
 * emits (`backend/app/chat.py`: `data: {chunk}` events … `data: [DONE]`).
 */

const V1_SSE_BODY = [
  'data: {"type":"text-start","id":"x"}',
  "",
  'data: {"type":"text-delta","id":"x","delta":"hi"}',
  "",
  'data: {"type":"text-end","id":"x"}',
  "",
  'data: {"type":"finish","finishReason":"stop"}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

const INTERRUPTED_SSE_BODY = [
  'data: {"type":"text-start","id":"x"}',
  "",
  'data: {"type":"text-delta","id":"x","delta":"partial"}',
  "",
  // what the relay emits when its own upstream dies mid-turn: a cut finish,
  // carrying the metadata the UI keys on (issues #152 / #217)
  'data: {"type":"finish","messageMetadata":{"interrupted":true}}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

async function readAll(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function sseResponse(body: string, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream({
      start(controller) {
        // split mid-line on purpose — the SDK parser must handle chunked
        // delivery (that is now the SDK's job, proven through our subclass)
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    }),
    { status },
  );
}

function sendOptions(messages: Parameters<KisekiChatTransport["sendMessages"]>[0]["messages"]) {
  return {
    trigger: "submit-message" as const,
    chatId: "chat-1",
    messageId: undefined,
    messages,
    abortSignal: undefined,
  };
}

describe("KisekiChatTransport", () => {
  it("posts {messages, threadId, tripId} with the bearer token", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return sseResponse(V1_SSE_BODY);
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-1",
      getToken: async () => "test-token",
      fetchImpl,
    });
    const chunks = await readAll(
      await transport.sendMessages(
        sendOptions([
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ]),
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/chat");
    const headers = seen[0].init.headers as Record<string, string>;
    // the SDK normalizes header names to lowercase before sending
    expect(headers.authorization ?? headers.Authorization).toBe(
      "Bearer test-token",
    );
    const body = JSON.parse(seen[0].init.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      messages: [{ role: "user", content: "hello", id: "u1" }],
      threadId: "thread-1",
      tripId: "trip-1",
    });
    // Issue #217: every submission names its turn, so a reconnect can attach
    // to THIS turn instead of re-sending the instruction as a new one.
    expect(body.turnKey).toMatch(/^turn-[0-9a-f-]{8,}$/);
    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "x",
      delta: "hi",
    });
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
  });

  it("omits tripId for the general chat", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return sseResponse(V1_SSE_BODY);
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      threadId: "thread-2",
      getToken: async () => "test-token",
      fetchImpl,
    });
    await readAll(await transport.sendMessages(sendOptions([])));
    const body = JSON.parse(seen[0].init.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ messages: [], threadId: "thread-2" });
    expect(body).not.toHaveProperty("tripId");
    expect(body.turnKey).toMatch(/^turn-[0-9a-f-]{8,}$/);
  });

  it("re-attaches to a carried turn instead of re-sending it", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return sseResponse(V1_SSE_BODY);
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-1",
      getToken: async () => "test-token",
      fetchImpl,
      // the state a reloaded thread carries over: the turn it was rendering,
      // and how many of its frames it had already shown
      turn: { turnKey: "turn-abc", cursor: 7 },
    });
    expect(transport.resumable).toBe(true);
    const stream = await transport.reconnectToStream();
    expect(stream).not.toBeNull();
    const chunks = await readAll(stream!);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/chat");
    expect(seen[0].init.method).toBe("POST");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      turnKey: "turn-abc",
      cursor: 7,
      threadId: "thread-1",
      tripId: "trip-1",
    });
    // the gap arrives on the wire the SPA already parses
    expect(chunks).toContainEqual({ type: "text-delta", id: "x", delta: "hi" });
  });

  it("has nothing to attach to without a turn in flight", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return sseResponse(V1_SSE_BODY);
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      threadId: "thread-9",
      getToken: async () => "test-token",
      fetchImpl,
    });
    expect(transport.resumable).toBe(false);
    expect(await transport.reconnectToStream()).toBeNull();
    expect(calls).toBe(0);
  });

  it("keeps the turn on a cut stream, drops it on a clean finish", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages?: unknown[] };
      const isSubmission = Array.isArray(body.messages);
      return sseResponse(isSubmission ? INTERRUPTED_SSE_BODY : V1_SSE_BODY);
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      threadId: "thread-4",
      getToken: async () => "test-token",
      fetchImpl,
    });
    await readAll(await transport.sendMessages(sendOptions([])));
    expect(transport.resumable).toBe(true);
    expect(await transport.reconnectToStream()).not.toBeNull();

    // a clean finish (no `interrupted` metadata) ends the turn for good
    const clean = new KisekiChatTransport({
      threadId: "thread-5",
      getToken: async () => "test-token",
      fetchImpl: (async () => sseResponse(V1_SSE_BODY)) as typeof fetch,
    });
    await readAll(await clean.sendMessages(sendOptions([])));
    expect(clean.resumable).toBe(false);
    expect(await clean.reconnectToStream()).toBeNull();
  });

  it("sends the entity focus with the turn (#330)", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return sseResponse(V1_SSE_BODY);
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-1",
      getToken: async () => "test-token",
      fetchImpl,
      focus: { entity: "day", id: "day-2" },
    });
    await readAll(await transport.sendMessages(sendOptions([])));
    const body = JSON.parse(seen[0].init.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      tripId: "trip-1",
      focus: { entity: "day", id: "day-2" },
    });
  });

  it("omits the focus for a whole-trip chat, and re-scopes a live transport", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return sseResponse(V1_SSE_BODY);
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-1",
      getToken: async () => "test-token",
      fetchImpl,
    });
    await readAll(await transport.sendMessages(sendOptions([])));
    const first = JSON.parse(seen[0].init.body as string) as Record<
      string,
      unknown
    >;
    expect(first).not.toHaveProperty("focus");

    // A second "ask the agent about this" while the drawer is open updates the
    // SAME transport (no rebuild — an in-flight turn keeps its attach state),
    // and the next submitted turn carries the new entity.
    transport.setFocus({ entity: "block", id: "block-9" });
    await readAll(await transport.sendMessages(sendOptions([])));
    const second = JSON.parse(seen[1].init.body as string) as Record<
      string,
      unknown
    >;
    expect(second).toMatchObject({ focus: { entity: "block", id: "block-9" } });

    // …and clearing it goes back to a whole-trip turn.
    transport.setFocus(null);
    await readAll(await transport.sendMessages(sendOptions([])));
    const third = JSON.parse(seen[2].init.body as string) as Record<
      string,
      unknown
    >;
    expect(third).not.toHaveProperty("focus");
  });

  it("throws a ChatAuthError on 401 (never a blank)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "Missing bearer token" }), {
        status: 401,
      })) as typeof fetch;
    const transport = new KisekiChatTransport({
      threadId: "thread-3",
      getToken: async () => "bad-token",
      fetchImpl,
    });
    await expect(
      transport.sendMessages(sendOptions([])),
    ).rejects.toMatchObject({ name: "ChatAuthError", status: 401 });
  });
});

/* The status probe (#217) — what a thread opening ASKS before it decides
 * between attaching to a turn and showing a settled transcript. Read-only, so
 * it may be called freely; the interesting part is that "could not ask" must
 * never look like "nothing there". */
describe("getTurnStatus (#217)", () => {
  function statusResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it("asks with the turn key, the thread and the trip", async () => {
    const seen: string[] = [];
    const ok = await getTurnStatus({
      threadId: "thread-1",
      turnKey: "turn-1",
      tripId: "trip-1",
      getToken: async () => "test-token",
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return statusResponse({ known: true, cursor: 7, done: false });
      }) as typeof fetch,
    });
    expect(seen[0]).toBe(
      "/api/chat/turn?threadId=thread-1&turnKey=turn-1&tripId=trip-1",
    );
    expect(ok).toEqual({ known: true, cursor: 7, done: false });
  });

  it("asks by thread alone when the client has no key to name it with", async () => {
    const seen: string[] = [];
    await getTurnStatus({
      threadId: "thread-1",
      getToken: async () => "test-token",
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return statusResponse({ known: true, turnKey: "turn-1", cursor: 3 });
      }) as typeof fetch,
    });
    expect(seen[0]).toBe("/api/chat/turn?threadId=thread-1");
  });

  it("reports a turn the relay is not holding", async () => {
    const status = await getTurnStatus({
      threadId: "thread-1",
      turnKey: "turn-old",
      getToken: async () => "test-token",
      fetchImpl: (async () => statusResponse({ known: false })) as typeof fetch,
    });
    expect(status.known).toBe(false);
  });

  it("raises ChatAuthError instead of reporting 'no turn'", async () => {
    await expect(
      getTurnStatus({
        threadId: "thread-1",
        turnKey: "turn-1",
        getToken: async () => "expired",
        fetchImpl: (async () =>
          statusResponse({ detail: "Invalid token" }, 401)) as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "ChatAuthError", status: 401 });
  });

  it("throws when the relay cannot be asked at all", async () => {
    // "the relay said no" and "the relay never answered" lead to opposite
    // decisions (forget the turn vs. keep it), so they must not look alike
    await expect(
      getTurnStatus({
        threadId: "thread-1",
        turnKey: "turn-1",
        getToken: async () => "test-token",
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as typeof fetch,
      }),
    ).rejects.toThrow("network down");
  });
});
