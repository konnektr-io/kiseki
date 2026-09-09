import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import type { UIMessageChunk } from "ai";
import {
  chatContextKey,
  findTripIds,
  initialRelayParseState,
  KisekiChatTransport,
  loadThreadId,
  messageToText,
  relayLineToChunks,
  toBackendMessage,
} from "./chat";

/* The chat wire client: pure-function coverage for the relay translation
 * (`0:`/`d:`/`e:` → UI chunks), the outbound message mapping (UIMessage →
 * backend ChatMessage), and the thread/trip-id helpers.
 *
 * The frame samples mirror `backend/app/chat.py` exactly:
 *   wire_text(delta)  →  f'0:{json.dumps(delta)}'
 *   wire_done()       →  'd:{"finishReason":"stop","isContinued":false}'
 *   wire_error(msg)   →  f'e:{{"error":"{msg}"}}'
 */

function runLines(lines: string[]) {
  const state = initialRelayParseState();
  return lines.flatMap((line) => relayLineToChunks(line, state));
}

function textMessage(text: string): UIMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text }],
  };
}

describe("relayLineToChunks (relay wire → UI chunks)", () => {
  it("translates a delta sequence into text-start/delta chunks", () => {
    const chunks = runLines(['0:"Hello"', '0:" world"']);
    expect(chunks).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hello" },
      { type: "text-delta", id: "text-1", delta: " world" },
    ]);
  });

  it("ends the turn on the d: frame (text-end + finish)", () => {
    const chunks = runLines([
      '0:"Hi"',
      'd:{"finishReason":"stop","isContinued":false}',
    ]);
    expect(chunks.at(-2)).toEqual({ type: "text-end", id: "text-1" });
    expect(chunks.at(-1)).toEqual({ type: "finish" });
  });

  it("emits only finish when the stream completes with no text", () => {
    expect(
      runLines(['d:{"finishReason":"stop","isContinued":false}']),
    ).toEqual([{ type: "finish" }]);
  });

  it("turns the e: frame into an error chunk carrying the message", () => {
    const chunks = runLines(['0:"partial"', 'e:{"error":"agent error"}']);
    expect(chunks.at(-1)).toEqual({
      type: "error",
      errorText: "agent error",
    });
  });

  it("ignores blank lines and unknown frames", () => {
    expect(runLines(["", "   ", "9:{\"ignored\":true}"])).toEqual([]);
  });

  it("accepts the data:-prefixed SSE form from the M3 doc", () => {
    const chunks = runLines(['data: 0:"Hi"', "data: d:{}", "data: 0:\"late\""]);
    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "text-1",
      delta: "Hi",
    });
    expect(chunks).toContainEqual({ type: "finish" });
    // lines after the terminal frame are dropped
    expect(chunks).not.toContainEqual({
      type: "text-delta",
      id: "text-1",
      delta: "late",
    });
  });

  it("drops malformed deltas without breaking the turn", () => {
    const chunks = runLines(['0:not-json', '0:"ok"']);
    expect(chunks).toContainEqual({
      type: "text-delta",
      id: "text-1",
      delta: "ok",
    });
  });
});

describe("toBackendMessage (UIMessage → relay shape)", () => {
  it("keeps pure-text messages as plain strings", () => {
    expect(toBackendMessage(textMessage("Hello"))).toEqual({
      role: "user",
      content: "Hello",
      id: "u1",
    });
  });

  it("maps image file parts to image_url parts (vision input)", () => {
    const message: UIMessage = {
      id: "u2",
      role: "user",
      parts: [
        { type: "text", text: "What is this?" },
        {
          type: "file",
          mediaType: "image/jpeg",
          url: "/media/t1/abc123.jpg",
        },
      ],
    };
    expect(toBackendMessage(message)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        {
          type: "image_url",
          image_url: { url: "/media/t1/abc123.jpg" },
        },
      ],
      id: "u2",
    });
  });

  it("sends non-image files as a text link the agent fetches", () => {
    const message: UIMessage = {
      id: "u3",
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "application/pdf",
          filename: " itinerary.pdf",
          url: "/media/t1/def456.pdf",
        },
      ],
    };
    const backend = toBackendMessage(message);
    expect(typeof backend.content).toBe("string");
    expect(backend.content).toContain("/media/t1/def456.pdf");
  });
});

describe("messageToText + findTripIds", () => {
  it("joins text parts and finds /t/<uuid> links", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Created it — open " },
        {
          type: "text",
          text: "/t/bf29a027-1111-2222-3333-444455556666/",
        },
      ],
    };
    const text = messageToText(message);
    expect(text).toContain("/t/bf29a027-1111-2222-3333-444455556666/");
    expect(findTripIds(text)).toEqual([
      "bf29a027-1111-2222-3333-444455556666",
    ]);
  });

  it("returns no ids for plain prose", () => {
    expect(findTripIds("No links here.")).toEqual([]);
  });
});

describe("KisekiChatTransport", () => {
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
          // split mid-line on purpose — the parser must handle chunks
          controller.enqueue(bytes.slice(0, 7));
          controller.enqueue(bytes.slice(7));
          controller.close();
        },
      }),
      { status },
    );
  }

  it("posts {messages, threadId, tripId} with the bearer token", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return sseResponse('0:"hi"\nd:{}\n');
    }) as typeof fetch;
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-1",
      getToken: async () => "test-token",
      fetchImpl,
    });
    const chunks = await readAll(
      await transport.sendMessages({
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
        abortSignal: undefined,
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/chat");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
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
      id: "text-1",
      delta: "hi",
    });
    expect(chunks.at(-1)).toEqual({ type: "finish" });
  });

  it("omits tripId for the general chat and resolves a cut stream", async () => {
    const fetchImpl = (async () =>
      sseResponse('0:"par')) as typeof fetch;
    const transport = new KisekiChatTransport({
      threadId: "thread-2",
      getToken: async () => "test-token",
      fetchImpl,
    });
    const chunks = await readAll(
      await transport.sendMessages({ messages: [], abortSignal: undefined }),
    );
    expect(chunks.at(-1)).toEqual({ type: "finish" });
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
      transport.sendMessages({ messages: [], abortSignal: undefined }),
    ).rejects.toMatchObject({ name: "ChatAuthError", status: 401 });
  });
});

describe("chat threads", () => {
  it("keys the general context separately from trips", () => {
    expect(chatContextKey()).toBe("general");
    expect(chatContextKey("trip-1")).toBe("trip-1");
  });

  it("returns null without a browser store (SSR-safe)", () => {
    expect(loadThreadId("general")).toBeNull();
  });
});
