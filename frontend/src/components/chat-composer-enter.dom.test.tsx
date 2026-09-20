// @vitest-environment jsdom
/**
 * Chat composer Enter behaviour on touch devices.
 *
 * Desktop: plain Enter sends, Shift+Enter keeps the newline. Phone/tablet
 * software keyboards have no Shift+Enter — Enter IS the newline key — so
 * Enter-to-send made multiline messages impossible there. On a
 * coarse-primary-pointer device plain Enter must NOT send (it inserts the
 * newline); the Send button — or Cmd/Ctrl+Enter with a hardware keyboard —
 * sends instead.
 *
 * Deliberately DOM-only (no import of the decision helper): these tests mount
 * the REAL panel and press REAL keys, so they fail against the pre-fix
 * composer, which sent on every plain Enter.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { chatMock } = vi.hoisted(() => ({
  chatMock: { current: null as unknown },
}));

/* Stable callback identities: a fetch effect keyed on `getAccessTokenSilently`
 * re-fires on every render when the mock builds fresh closures per call. */
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

/* The panel reads its whole chat surface from `useTripChat` — the mock below
 * is the entire backend. The module's real helpers (thread ids, …) stay real,
 * so the mount exercises the real composer wiring. */
vi.mock("../lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat")>();
  return {
    ...actual,
    useTripChat: () => chatMock.current,
  };
});

import { ChatPanel } from "./chat-panel";

type PointerMode = "fine" | "coarse";
let pointerMode: PointerMode = "fine";

function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      pointerMode === "coarse"
        ? query === "(pointer: coarse)"
        : query === "(pointer: fine)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/* jsdom provides no localStorage — the thread-id helpers need the Map-backed
 * stub or the whole file fails at setup instead of at an assertion. */
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

const sent: Array<unknown> = [];

function stubChat(): void {
  sent.length = 0;
  chatMock.current = {
    messages: [],
    status: "ready",
    error: undefined,
    recovery: "idle",
    resumable: true,
    sendMessage: async (msg: unknown) => void sent.push(msg),
    stop: async () => {},
    regenerate: async () => {},
    resumeTurn: async () => false,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountComposer(): HTMLTextAreaElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ChatPanel tripId="trip-1" />);
  });
  const area = container.querySelector(
    'textarea[aria-label="Chat message"]',
  );
  if (!area) throw new Error("composer textarea did not render");
  return area as HTMLTextAreaElement;
}

function typeDraft(area: HTMLTextAreaElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Press Enter on the composer. Returns true when the keypress's default was
 *  NOT prevented — i.e. the newline is still allowed through. */
function pressEnter(
  area: HTMLTextAreaElement,
  opts: {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    keyCode?: number;
    isComposing?: boolean;
  } = {},
): boolean {
  let defaultAllowed = false;
  act(() => {
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      shiftKey: opts.shiftKey,
      ctrlKey: opts.ctrlKey,
      metaKey: opts.metaKey,
    });
    if (opts.keyCode !== undefined)
      Object.defineProperty(ev, "keyCode", { value: opts.keyCode });
    if (opts.isComposing !== undefined)
      Object.defineProperty(ev, "isComposing", { value: opts.isComposing });
    defaultAllowed = area.dispatchEvent(ev);
  });
  return defaultAllowed;
}

function sentText(): string {
  return (sent[0] as { text?: string }).text ?? "";
}

beforeEach(() => {
  pointerMode = "fine";
  stubLocalStorage();
  stubMatchMedia();
  stubChat();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("chat composer Enter (hardware keyboard)", () => {
  it("plain Enter sends the draft", () => {
    const area = mountComposer();
    typeDraft(area, "hello");
    const defaultAllowed = pressEnter(area);
    expect(sent).toHaveLength(1);
    expect(sentText()).toContain("hello");
    expect(defaultAllowed).toBe(false);
  });

  it("Shift+Enter does not send", () => {
    const area = mountComposer();
    typeDraft(area, "line one");
    const defaultAllowed = pressEnter(area, { shiftKey: true });
    expect(sent).toHaveLength(0);
    expect(defaultAllowed).toBe(true);
  });
});

describe("chat composer Enter (touch device)", () => {
  beforeEach(() => {
    pointerMode = "coarse";
  });

  it("plain Enter does NOT send — it is the newline key", () => {
    const area = mountComposer();
    typeDraft(area, "line one");
    const defaultAllowed = pressEnter(area);
    expect(sent).toHaveLength(0);
    // The default (newline insertion) must survive: preventing it would eat
    // the line break the user just typed.
    expect(defaultAllowed).toBe(true);
  });

  it("Ctrl+Enter sends (hardware keyboard on a tablet)", () => {
    const area = mountComposer();
    typeDraft(area, "two lines here");
    pressEnter(area, { ctrlKey: true });
    expect(sent).toHaveLength(1);
    expect(sentText()).toContain("two lines here");
  });

  it("Meta+Enter sends (hardware keyboard on a tablet)", () => {
    const area = mountComposer();
    typeDraft(area, "two lines here");
    pressEnter(area, { metaKey: true });
    expect(sent).toHaveLength(1);
    expect(sentText()).toContain("two lines here");
  });

  it("the return key reads as newline, never send", () => {
    const area = mountComposer();
    expect(area.getAttribute("enterkeyhint")).toBe("enter");
  });
});

describe("chat composer Enter (IME composition)", () => {
  it("Enter mid-composition never sends, even on desktop", () => {
    const area = mountComposer();
    typeDraft(area, "nihon");
    pressEnter(area, { isComposing: true });
    expect(sent).toHaveLength(0);
  });

  it("keyCode 229 (composition keystroke) never sends, even on desktop", () => {
    const area = mountComposer();
    typeDraft(area, "nihon");
    pressEnter(area, { keyCode: 229 });
    expect(sent).toHaveLength(0);
  });
});
