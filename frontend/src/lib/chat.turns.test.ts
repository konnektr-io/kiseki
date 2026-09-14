// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";

import {
  KisekiChatTransport,
  loadTurnState,
  resumeStoredTurn,
  saveTurnState,
  shouldAttachToTurn,
  turnBoundary,
} from "./chat";

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

/** The `sendMessages` argument shape the SDK passes (`chat.transport.test.ts`
 *  has the same helper — the transport's request shaping runs on it). */
function sendOptions(
  messages: Parameters<KisekiChatTransport["sendMessages"]>[0]["messages"],
) {
  return {
    trigger: "submit-message" as const,
    chatId: "chat-1",
    messageId: undefined,
    messages,
    abortSignal: undefined,
  };
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

/* What a submission has to RECORD for a later resume to be possible at all:
 * the relay keys a turn by the trip it was submitted under, and the client
 * rebuilds the transcript from the message that opened the turn (#217). */
describe("turn anchors (#217)", () => {
  beforeEach(() => installStorage().clear());

  it("records the trip and the opening message when a turn is submitted", async () => {
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async () => sseResponse(V1_SSE_BODY)) as typeof fetch,
    });
    await transport.sendMessages(
      sendOptions([
        { id: "u9", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]),
    );
    const stored = loadTurnState("thread-a");
    expect(stored?.tripId).toBe("trip-1");
    expect(stored?.userMessageId).toBe("u9");
    expect(stored?.cursor).toBe(0);
  });

  it("attaches with the trip the turn was SUBMITTED with, not the one on screen", async () => {
    // a landing-page thread that gained a trip mid-conversation: the turn
    // itself has no anchor, and re-addressing it under the trip would name a
    // turn that does not exist (the relay would start a NEW one instead)
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 4, tripId: null });
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const transport = new KisekiChatTransport({
      tripId: "trip-live",
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return sseResponse(V1_SSE_BODY);
      }) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    await transport.reconnectToStream();
    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      turnKey: "turn-1",
      cursor: 4,
      threadId: "thread-a",
    });
  });

  it("rewinds the attach to the turn's first frame", async () => {
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 9 });
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const transport = new KisekiChatTransport({
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return sseResponse(V1_SSE_BODY);
      }) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    transport.rewind(0);
    await transport.reconnectToStream();
    expect(JSON.parse(seen[0].init.body as string).cursor).toBe(0);
  });

  it("reports an attach that found nothing, and can forget the turn", async () => {
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 3 });
    const transport = new KisekiChatTransport({
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async () => new Response("gone", { status: 404 })) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    expect(await transport.reconnectToStream()).toBeNull();
    expect(transport.lastAttachFailed).toBe(true);
    transport.forgetTurn();
    expect(transport.resumable).toBe(false);
    expect(loadTurnState("thread-a")).toBeNull();
  });
});

/* Where a turn's own messages start in the transcript — the anchor the resume
 * rebuilds from. Getting this wrong deletes history (an off-by-one would drop
 * the user's own message) or duplicates the turn. */
describe("turnBoundary (#217)", () => {
  const user: UIMessage = {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "add the RV parks" }],
  };
  const partial: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "Added the" }],
  };
  const settled: UIMessage = {
    id: "a0",
    role: "assistant",
    parts: [{ type: "text", text: "Done." }],
  };

  it("starts just after the message that opened the turn", () => {
    expect(turnBoundary([settled, user, partial], "u1")).toBe(2);
  });

  it("keeps the whole transcript when the anchor is not in it", () => {
    expect(turnBoundary([settled, user, partial], "u-gone")).toBe(3);
  });

  it("without an anchor drops only a tail the relay cut", () => {
    const cut: UIMessage = {
      ...partial,
      metadata: { interrupted: true },
    };
    expect(turnBoundary([user, cut])).toBe(1);
    // unmarked partial: not known to be this turn's, so nothing is dropped
    expect(turnBoundary([user, partial])).toBe(2);
  });
});

/* Picking a turn back up (#217). The probe decides: an attach at a turn key
 * the relay has forgotten STARTS the turn, so "nothing there" must never
 * reach the attach. */
describe("resumeStoredTurn (#217)", () => {
  beforeEach(() => installStorage().clear());

  const messages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "add RV parks" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Added the" }],
    },
  ];

  /** The `useChat` surface, tracked so tests can see every transcript write. */
  function surface(onResume?: () => Promise<void>) {
    const chat = {
      messages,
      resumed: 0,
      writes: [] as UIMessage[][],
      setMessages(next: UIMessage[]) {
        chat.messages = next;
        chat.writes.push(next);
      },
      async resumeStream() {
        chat.resumed += 1;
        if (onResume) await onResume();
      },
    };
    return chat;
  }

  it("rebuilds the turn from its first frame instead of appending to it", async () => {
    saveTurnState("thread-a", {
      turnKey: "turn-1",
      cursor: 2,
      tripId: "trip-1",
      userMessageId: "u1",
    });
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return sseResponse(V1_SSE_BODY);
      }) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    const chat = surface(async () => {
      await transport.reconnectToStream();
    });
    const attached = await resumeStoredTurn({
      transport,
      chat,
      status: async () => ({ known: true, cursor: 2, status: "running" }),
    });
    expect(attached).toBe(true);
    // the partial leaves the transcript BEFORE the stream starts, so the
    // replayed frames own the message and no second bubble appears
    expect(chat.writes[0].map((m) => m.id)).toEqual(["u1"]);
    // and the attach asks for frame 0, not for the cursor the client held
    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      turnKey: "turn-1",
      cursor: 0,
      threadId: "thread-a",
      tripId: "trip-1",
    });
    expect(chat.resumed).toBe(1);
  });

  it("attaches to a turn that settled while nobody was watching", async () => {
    // the exact reported symptom: the relay finished the turn after the client
    // disconnected, so the answer (and the trip edits) were there to collect
    saveTurnState("thread-a", {
      turnKey: "turn-1",
      cursor: 1,
      tripId: "trip-1",
      userMessageId: "u1",
    });
    const transport = new KisekiChatTransport({
      tripId: "trip-1",
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async () => sseResponse(V1_SSE_BODY)) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    const chat = surface();
    const attached = await resumeStoredTurn({
      transport,
      chat,
      status: async () => ({ known: true, cursor: 5, done: true, status: "settled" }),
    });
    expect(attached).toBe(true);
    expect(chat.resumed).toBe(1);
  });

  it("forgets a turn the relay no longer holds instead of attaching", async () => {
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 3, tripId: "trip-1" });
    const transport = new KisekiChatTransport({
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    const chat = surface();
    const attached = await resumeStoredTurn({
      transport,
      chat,
      status: async () => ({ known: false }),
    });
    expect(attached).toBe(false);
    expect(chat.resumed).toBe(0);
    expect(chat.writes).toEqual([]);
    expect(transport.resumable).toBe(false);
    expect(loadTurnState("thread-a")).toBeNull();
  });

  it("keeps the turn, and the transcript, when the relay cannot be asked", async () => {
    saveTurnState("thread-a", { turnKey: "turn-1", cursor: 3, tripId: "trip-1" });
    const transport = new KisekiChatTransport({
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async () => sseResponse(V1_SSE_BODY)) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    const chat = surface();
    const attached = await resumeStoredTurn({
      transport,
      chat,
      status: async () => {
        throw new Error("network down");
      },
    });
    expect(attached).toBe(false);
    expect(chat.writes).toEqual([]);
    expect(transport.resumable).toBe(true);
    expect(loadTurnState("thread-a")).not.toBeNull();
  });

  it("puts the transcript back when the attach comes back empty", async () => {
    saveTurnState("thread-a", {
      turnKey: "turn-1",
      cursor: 2,
      tripId: "trip-1",
      userMessageId: "u1",
    });
    const transport = new KisekiChatTransport({
      threadId: "thread-a",
      getToken: async () => "test-token",
      fetchImpl: (async () => new Response("gone", { status: 404 })) as typeof fetch,
      turn: loadTurnState("thread-a"),
    });
    const chat = surface(async () => {
      await transport.reconnectToStream();
    });
    const attached = await resumeStoredTurn({
      transport,
      chat,
      status: async () => ({ known: true, cursor: 2 }),
    });
    expect(attached).toBe(false);
    expect(chat.writes).toHaveLength(2);
    expect(chat.messages).toEqual(messages);
  });
});

/* "The user is back" is the other way a dropped turn gets picked up (#237).
 * The mount probe cannot see it (the panel was never unmounted) and, when the
 * CLIENT's own socket is what died, no terminal chunk ever arrives to flag
 * `interrupted` — so `useTripChat` asks the relay again on a transport error
 * and when the app is foregrounded, both gated by this predicate. */
describe("shouldAttachToTurn (#237)", () => {
  const base = {
    resumable: true,
    status: "ready",
    recovery: "idle" as const,
    attaching: false,
  };

  it("attaches to a turn the relay still holds", () => {
    expect(shouldAttachToTurn(base)).toBe(true);
    // the error state IS the drop: the turn's frames are worth asking for
    expect(shouldAttachToTurn({ ...base, status: "error" })).toBe(true);
    // a failed earlier probe is no reason to stop looking when the user
    // comes back to the thread
    expect(shouldAttachToTurn({ ...base, recovery: "unavailable" })).toBe(true);
    expect(shouldAttachToTurn({ ...base, recovery: "attached" })).toBe(true);
  });

  it("stays away when there is nothing to attach, or one is running", () => {
    // nothing of this thread's is on the relay: a POST here would START a
    // turn instead of continuing one
    expect(shouldAttachToTurn({ ...base, resumable: false })).toBe(false);
    // the turn is already arriving
    expect(shouldAttachToTurn({ ...base, status: "streaming" })).toBe(false);
    expect(shouldAttachToTurn({ ...base, status: "submitted" })).toBe(false);
    // one probe at a time: a second attach rewinds a stream that is
    // already replaying
    expect(shouldAttachToTurn({ ...base, recovery: "checking" })).toBe(false);
    expect(shouldAttachToTurn({ ...base, attaching: true })).toBe(false);
  });
});
