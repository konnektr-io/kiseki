// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";

import { KisekiChatTransport } from "./chat";

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
    expect(body).toEqual({
      messages: [{ role: "user", content: "hello", id: "u1" }],
      threadId: "thread-1",
      tripId: "trip-1",
    });
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
    expect(body).toEqual({ messages: [], threadId: "thread-2" });
    expect(body).not.toHaveProperty("tripId");
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
