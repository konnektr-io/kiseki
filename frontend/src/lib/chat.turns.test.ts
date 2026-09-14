// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";

import { KisekiChatTransport, loadTurnState, saveTurnState } from "./chat";

/* The turn a thread was rendering survives a reload / app switch (issue
 * #217): `{turnKey, cursor}` is kept per thread, and a transport built from
 * that stored state re-attaches instead of re-sending the instruction. The
 * node-environment wire coverage lives in `chat.transport.test.ts`.
 */

const V1_SSE_BODY = [
  'data: {"type":"text-start","id":"x"}',
  "",
  'data: {"type":"text-delta","id":"x","delta":"hi"}',
  "",
  'data: {"type":"finish","finishReason":"stop"}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

function sseResponse(body: string): Response {
  return new Response(new TextEncoder().encode(body));
}

/* jsdom in this repo runs on an opaque origin, so `window.localStorage` is
 * undefined — the module guards for that, and these tests need the real
 * thing to prove persistence. Install a minimal in-memory Storage. */
function installStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
  if (typeof window !== "undefined" && !window.localStorage) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
  return window.localStorage;
}

describe("turn state persistence (#217)", () => {
  beforeEach(() => installStorage().clear());

  it("round-trips the turn per thread", () => {
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 12 });
    expect(loadTurnState("thread-a")).toEqual({ turnKey: "turn-1", cursor: 12 });
    // conversations are isolated — another thread has no turn
    expect(loadTurnState("thread-b")).toBeNull();
  });

  it("clears the turn once it is no longer attachable", () => {
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 3 });
    saveTurnState("thread-a", null);
    expect(loadTurnState("thread-a")).toBeNull();
  });

  it("ignores a corrupt or foreign payload instead of throwing", () => {
    installStorage().setItem("kiseki.chat.turns.v1", "{not json");
    expect(loadTurnState("thread-a")).toBeNull();
    installStorage().setItem(
      "kiseki.chat.turns.v1",
      JSON.stringify({ "thread-a": { turnKey: "" }, "thread-b": 7 }),
    );
    expect(loadTurnState("thread-a")).toBeNull();
    expect(loadTurnState("thread-b")).toBeNull();
  });

  it("a reloaded thread resumes its turn rather than re-sending it", async () => {
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 4 });
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const transport = new KisekiChatTransport({
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return sseResponse(V1_SSE_BODY);
      }) as typeof fetch,
      // what the reload does: hand the stored turn to a fresh transport
      turn: loadTurnState("thread-a"),
    });
    expect(transport.resumable).toBe(true);
    const stream = await transport.reconnectToStream();
    expect(stream).not.toBeNull();
    const reader = stream!.getReader();
    const chunks: UIMessageChunk[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      turnKey: "turn-1",
      cursor: 4,
      threadId: "thread-a",
    });
    expect(chunks).toContainEqual({ type: "text-delta", id: "x", delta: "hi" });
    // the resumed turn ran to a clean finish, so nothing is left to attach to
    expect(transport.resumable).toBe(false);
    expect(loadTurnState("thread-a")).toBeNull();
  });
});
