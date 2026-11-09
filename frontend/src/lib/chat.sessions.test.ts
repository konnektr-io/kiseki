// @vitest-environment jsdom
/**
 * Conversation index + picker reconciliation (#309).
 *
 * Three things are proven here:
 * - `kiseki.chat.sessions.v1` records every thread a context has opened, so
 *   "New chat" can no longer lose the previous thread's id (the pointer in
 *   `threads.v1` is overwritten on rotate; the index is not).
 * - `mergePickerThreads` reconciles the relay's list with that index: server
 *   rows win, local-only rows survive, husks are dropped, newest first.
 * - `mergeTranscripts` prefers the SERVER beyond the local tail, so a thread
 *   continued on another device never renders truncated.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  adoptThreadId,
  fetchChatThreads,
  fetchChatTranscript,
  listIndexedThreads,
  loadThreadId,
  mergePickerThreads,
  mergeTranscripts,
  newThreadId,
  rememberThread,
  saveTranscript,
  threadExcerpt,
} from "./chat";

const SUB = "google-oauth2|123";
const CONTEXT = "general";

function installStorage(): void {
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
  } as Storage;
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

beforeEach(() => {
  installStorage();
});

describe("local conversation index", () => {
  it("keeps the rotated-away thread after New chat", () => {
    const first = newThreadId(CONTEXT, SUB);
    const second = newThreadId(CONTEXT, SUB);

    expect(loadThreadId(CONTEXT, SUB)).toBe(second);
    const indexed = listIndexedThreads(CONTEXT, SUB).map((row) => row.threadId);
    expect(indexed).toContain(first);
    expect(indexed).toContain(second);
    // Newest first.
    expect(indexed[0]).toBe(second);
  });

  it("is scoped per user, like the thread pointer", () => {
    newThreadId(CONTEXT, SUB);

    expect(listIndexedThreads(CONTEXT, SUB)).toHaveLength(1);
    expect(listIndexedThreads(CONTEXT, "somebody-else")).toHaveLength(0);
    expect(listIndexedThreads("other-context", SUB)).toHaveLength(0);
  });

  it("upserts, dedupes and keeps the first title", () => {
    rememberThread(CONTEXT, SUB, "t1", "First label");
    rememberThread(CONTEXT, SUB, "t1", "Second label");

    const rows = listIndexedThreads(CONTEXT, SUB);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("First label");
  });

  it("bumps a resumed thread to the top without duplicating it", () => {
    rememberThread(CONTEXT, SUB, "old", "Older");
    rememberThread(CONTEXT, SUB, "new", "Newer");
    adoptThreadId(CONTEXT, "old", SUB);

    const rows = listIndexedThreads(CONTEXT, SUB);
    expect(rows.map((row) => row.threadId)).toEqual(["old", "new"]);
    expect(loadThreadId(CONTEXT, SUB)).toBe("old");
  });

  it("caps the index so one context cannot grow without bound", () => {
    for (let i = 0; i < 60; i += 1) rememberThread(CONTEXT, SUB, `t${i}`, `Thread ${i}`);

    expect(listIndexedThreads(CONTEXT, SUB)).toHaveLength(50);
  });

  it("derives a row label from the thread's first user message", () => {
    saveTranscript("t1", [
      userMessage("m1", "  Plan   a trip\nto Japan for two weeks, please.  "),
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "Sure." }] },
    ]);

    expect(threadExcerpt("t1")).toBe("Plan a trip to Japan for two weeks, please.");
    expect(threadExcerpt("never-opened")).toBeUndefined();
  });
});

describe("picker reconciliation", () => {
  const server = [
    {
      threadId: "s1",
      title: "Fix flight LIM-CUZ",
      lastActiveAt: 1_700_000_000,
      status: "open",
    },
    { threadId: "s2", title: "", lastActiveAt: 1_600_000_000, status: "ws_orphan_reap" },
  ];
  const local = [
    { threadId: "s1", title: "Local label (server wins)", updatedAt: 1 },
    { threadId: "local-1", title: "Plan Japan, winter", updatedAt: 5_000 },
    { threadId: "husk", updatedAt: 9_000 },
  ];

  it("merges server and local rows, newest first, with no duplicates", () => {
    const rows = mergePickerThreads({
      server,
      local,
      activeThreadId: "s2",
      excerpts: { s2: "attachment only" },
    });

    expect(rows.map((row) => row.threadId)).toEqual(["s1", "s2", "local-1"]);
    expect(rows[0].title).toBe("Fix flight LIM-CUZ");
    // The server's empty title falls back to the local excerpt.
    expect(rows[1].title).toBe("attachment only");
    expect(rows[1].active).toBe(true);
    expect(rows[2].source).toBe("local");
  });

  it("drops an untitled local husk — unless it is the active thread", () => {
    const without = mergePickerThreads({ server, local, activeThreadId: "s1" });
    expect(without.map((row) => row.threadId)).not.toContain("husk");

    const withActive = mergePickerThreads({ server, local, activeThreadId: "husk" });
    expect(withActive.find((row) => row.threadId === "husk")?.title).toBe("New conversation");
  });

  it("renders the local index alone when the relay returned nothing", () => {
    const rows = mergePickerThreads({ server: [], local, activeThreadId: "s1" });
    // Titles come from the index; the untitled husk is dropped.
    expect(rows.map((row) => row.threadId)).toEqual(["local-1", "s1"]);
  });
});

describe("transcript restore", () => {
  it("prefers the server copy only when it reaches further back/forward", () => {
    const local = [userMessage("a", "hi")];
    const remote = [userMessage("a", "hi"), userMessage("b", "from the phone")];

    expect(mergeTranscripts(local, remote)).toBe(remote);
    expect(mergeTranscripts(remote, remote)).toBe(remote);
    expect(mergeTranscripts(remote, local)).toBe(remote);
  });
});

describe("relay client", () => {
  it("asks for the caller's conversations and normalizes the payload", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ threads: [{ threadId: "t1", title: "One" }], hasMore: true }),
        { status: 200 },
      );
    }) as typeof fetch;

    const page = await fetchChatThreads({ getToken: async () => "tok", fetchImpl });

    expect(calls).toEqual(["/api/chat/sessions?limit=50"]);
    expect(page.threads).toEqual([{ threadId: "t1", title: "One" }]);
    expect(page.hasMore).toBe(true);
  });

  it("treats a 404 transcript as 'nothing to restore', not an error", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as typeof fetch;

    await expect(
      fetchChatTranscript({ threadId: "t1", getToken: async () => "tok", fetchImpl }),
    ).resolves.toEqual([]);
  });

  it("surfaces a session failure as ChatAuthError", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "expired" }), { status: 401 })) as typeof fetch;

    await expect(
      fetchChatTranscript({ threadId: "t1", getToken: async () => "tok", fetchImpl }),
    ).rejects.toMatchObject({ name: "ChatAuthError", status: 401 });
  });
});
