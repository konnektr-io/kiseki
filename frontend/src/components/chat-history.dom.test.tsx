// @vitest-environment jsdom
/**
 * The conversation picker (#309) — mounted panel, real component.
 *
 * The panel reads its chat surface from `useTripChat` (mocked, as in the other
 * jsdom panel tests) but the picker's own wiring is REAL: the real local index
 * helpers, the real `fetchChatThreads` over a stubbed `fetch`, and the real
 * `adoptThreadId` pointer write. So these tests fail against the pre-#309
 * panel, where "New chat" left the previous thread unreachable and a header
 * had no way back to an earlier conversation at all.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { chatMock } = vi.hoisted(() => ({
  chatMock: { current: null as unknown },
}));

const authFns = vi.hoisted(() => ({
  getAccessTokenSilently: async () => "test-token",
  loginWithRedirect: async () => {},
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { sub: "e2e-probe" },
    ...authFns,
  }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => chatMock.current,
}));

vi.mock("../lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat")>();
  return { ...actual, useTripChat: () => chatMock.current };
});

import { ChatPanel } from "./chat-panel";

const SUB = "e2e-probe";
const ACTIVE = "11111111-1111-4111-8111-111111111111";
const OLDER = "22222222-2222-4222-8222-222222222222";

function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: fine)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountPanel(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ChatPanel />);
  });
  return container;
}

/** Let the picker's `await fetch(...)` chain settle inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openHistory(box: HTMLElement): void {
  const button = box.querySelector('button[aria-label="Earlier conversations"]');
  if (!button) throw new Error("the history affordance is missing from the header");
  act(() => {
    (button as HTMLButtonElement).click();
  });
}

function menuRows(box: HTMLElement): HTMLButtonElement[] {
  return [...box.querySelectorAll('[data-testid="chat-history-menu"] [role="menuitem"]')] as
    HTMLButtonElement[];
}

beforeEach(() => {
  stubLocalStorage();
  stubMatchMedia();
  chatMock.current = {
    messages: [],
    status: "ready",
    error: undefined,
    recovery: "idle",
    resumable: false,
    failure: null,
    setMessages: () => {},
    sendMessage: async () => {},
    stop: async () => {},
    regenerate: async () => {},
    resumeTurn: async () => false,
  };
  // The ACTIVE thread is this context's pointer; an older thread lives in the
  // local index only (never continued on this browser since).
  localStorage.setItem("kiseki.chat.threads.v1", JSON.stringify({ [`${SUB}::general`]: ACTIVE }));
  localStorage.setItem(
    "kiseki.chat.sessions.v1",
    JSON.stringify({
      [`${SUB}::general`]: [
        { threadId: ACTIVE, title: "Fix the Banff link", updatedAt: 2_000 },
        { threadId: OLDER, title: "Plan Japan, winter", updatedAt: 1_000 },
      ],
    }),
  );
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("conversation picker (#309)", () => {
  it("lists earlier threads from the relay, newest first, and marks the active one", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          threads: [
            {
              threadId: ACTIVE,
              title: "Fix the Banff link",
              messageCount: 5,
              lastActiveAt: 1_700_000_000,
              status: "open",
            },
            {
              threadId: "33333333-3333-4333-8333-333333333333",
              title: "Peru 2027 — cheaper options",
              messageCount: 161,
              lastActiveAt: 1_600_000_000,
              status: "ws_orphan_reap",
            },
          ],
          hasMore: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const box = mountPanel();
    openHistory(box);
    await flush();

    const rows = menuRows(box);
    const titles = rows.map((row) => row.textContent ?? "");
    expect(titles[0]).toContain("Fix the Banff link");
    expect(titles[0]).toContain("current");
    expect(titles[1]).toContain("Peru 2027 — cheaper options");
    // A reaped thread is a live row with intact history — listed, not hidden.
    expect(titles.join(" ")).not.toContain("ws_orphan_reap");
    // The local-only thread is still listed (the relay's page may not hold it).
    expect(titles.join(" ")).toContain("Plan Japan, winter");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes an older thread by adopting it as this context's pointer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ threads: [], hasMore: false }), { status: 200 })),
    );

    const box = mountPanel();
    openHistory(box);
    await flush();

    const older = menuRows(box).find((row) => (row.textContent ?? "").includes("Plan Japan, winter"));
    expect(older).toBeTruthy();
    act(() => {
      older!.click();
    });

    const pointers = JSON.parse(localStorage.getItem("kiseki.chat.threads.v1") ?? "{}");
    expect(pointers[`${SUB}::general`]).toBe(OLDER);
    // ...and the menu closes on pick.
    expect(box.querySelector('[data-testid="chat-history-menu"]')).toBeNull();
  });

  it("degrades to this device's history when the relay cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 502 })),
    );

    const box = mountPanel();
    openHistory(box);
    await flush();

    expect(box.textContent).toContain("showing this device");
    const titles = menuRows(box).map((row) => row.textContent ?? "");
    expect(titles.join(" ")).toContain("Plan Japan, winter");
    expect(titles.join(" ")).toContain("Fix the Banff link");
  });
});
