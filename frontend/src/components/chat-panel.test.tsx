import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

/* ChatPanel component tests (issue #9 / M4).
 *
 * SSR through `renderToString` like the other component tests (node-env
 * vitest, no DOM): `@auth0/auth0-react` is stubbed signed-in and
 * `@ai-sdk/react`'s `useChat` is stubbed per test via a hoisted mutable —
 * the panel reads everything it renders (messages, status, error, tripId)
 * from those two seams, so SSR pins the contracts that matter:
 * streamed text renders, error states show, the attach button follows
 * the trip anchor.
 */

const { chatMock } = vi.hoisted(() => ({
  chatMock: { current: null as unknown },
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: async () => {},
  }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => chatMock.current,
}));

import { ChatAuthError } from "../lib/chat";
import { ChatPanel } from "./chat-panel";

function assistantText(text: string): UIMessage {
  return { id: "a1", role: "assistant", parts: [{ type: "text", text }] };
}

function userText(text: string): UIMessage {
  return { id: "u1", role: "user", parts: [{ type: "text", text }] };
}

function stubChat(overrides: Record<string, unknown> = {}) {
  chatMock.current = {
    messages: [],
    status: "ready",
    error: undefined,
    sendMessage: async () => {},
    stop: async () => {},
    regenerate: async () => {},
    ...overrides,
  };
}

function renderPanel(tripId?: string): string {
  return renderToString(createElement(ChatPanel, { tripId }));
}

describe("ChatPanel messages", () => {
  it("renders streamed assistant markdown", () => {
    stubChat({
      messages: [userText("Hi"), assistantText("Hello **there**")],
      status: "streaming",
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Hi");
    expect(html).toContain("<strong>there</strong>");
  });

  it("renders a bare /media/ URL as an inline image", () => {
    stubChat({
      messages: [assistantText("See /media/t1/abc123.jpg from today")],
    });
    const html = renderPanel("trip-1");
    expect(html).toContain('src="/media/t1/abc123.jpg"');
  });

  it("shows the thinking indicator while the turn runs", () => {
    stubChat({ status: "submitted" });
    expect(renderPanel("trip-1")).toContain("Agent is thinking");
  });

  it("renders ONLY the latest activity row — rows replace each other (issue #175)", () => {
    const activity = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          // data-kiseki-activity custom data part (issue #157) — the SDK
          // stores the relay chunk verbatim on message.parts.
          type: "data-kiseki-activity",
          id: "c1",
          data: { label: "Searching the web…", done: true },
        },
        {
          type: "data-kiseki-activity",
          id: "c2",
          data: { label: "Running a command…", done: false },
        },
      ],
    } as unknown as UIMessage;
    stubChat({ messages: [activity], status: "streaming" });
    const html = renderPanel("trip-1");
    expect(html).toContain("Agent activity");
    // the latest call's row is the one on screen
    expect(html).toContain("Running a command…");
    // earlier calls do NOT pile up (issue #175) — one row, not a stack
    expect(html).not.toContain("Searching the web…");
    const rows = html.split("Running a command…").length - 1;
    expect(rows).toBe(1);
    // raw tool names never render
    expect(html).not.toContain("kiseki-activity");
  });

  it("scopes the feed to the current turn — later messages replace earlier ones", () => {
    // Two streamed assistant segments in one busy window (text deltas can
    // split a turn into several messages): only the LAST message's latest
    // part is live — earlier segments' rows are replaced, not stacked.
    const earlier = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "data-kiseki-activity",
          id: "c1",
          data: { label: "Checking how to help…", done: true },
        },
      ],
    } as unknown as UIMessage;
    const current = {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "data-kiseki-activity",
          id: "c3",
          data: { label: "Writing trip data…", done: false },
        },
      ],
    } as unknown as UIMessage;
    stubChat({ messages: [earlier, current], status: "streaming" });
    const html = renderPanel("trip-1");
    expect(html).toContain("Writing trip data…");
    expect(html).not.toContain("Checking how to help…");
  });

  it("a fresh turn starts from thinking, not the previous turn's last row (issue #175)", () => {
    const previous = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "data-kiseki-activity",
          id: "c1",
          data: { label: "Writing trip data…", done: true },
        },
        { type: "text", text: "Done — trip created." },
      ],
    } as unknown as UIMessage;
    stubChat({
      messages: [previous, userText("Add a day in Banff")],
      status: "submitted",
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Agent is thinking");
    expect(html).not.toContain("Writing trip data…");
  });

  it("shows the thinking indicator at most ONCE per turn (issue #157)", () => {
    // Before the fix the panel rendered AgentActivity's thinking fallback
    // AND a separate `submitted` thinking row — "Agent is thinking" twice.
    stubChat({ status: "submitted" });
    const html = renderPanel("trip-1");
    const count = html.split("Agent is thinking").length - 1;
    expect(count).toBe(1);
  });

  it("keeps one thinking row while streaming with no activity yet", () => {
    stubChat({ messages: [userText("Hi")], status: "streaming" });
    const html = renderPanel("trip-1");
    const count = html.split("Agent is thinking").length - 1;
    expect(count).toBe(1);
  });

  it("falls back to thinking when the turn has no activity yet", () => {
    stubChat({ messages: [assistantText("partial")], status: "streaming" });
    const html = renderPanel("trip-1");
    expect(html).toContain("Agent is thinking");
  });

  it("renders user image attachments as thumbnails", () => {
    const message: UIMessage = {
      id: "u2",
      role: "user",
      parts: [
        { type: "text", text: "What is this?" },
        {
          type: "file",
          mediaType: "image/jpeg",
          url: "/media/t1/abc123.jpg",
          filename: "hut.jpg",
        },
      ],
    };
    stubChat({ messages: [message] });
    const html = renderPanel("trip-1");
    expect(html).toContain('src="/media/t1/abc123.jpg"');
    expect(html).toContain("What is this?");
  });
});

describe("ChatPanel errors", () => {
  it("shows the error banner with retry on turn failure", () => {
    stubChat({ status: "error", error: new Error("boom") });
    const html = renderPanel("trip-1");
    expect(html).toContain("boom");
    expect(html).toContain("Try again");
  });

  it("routes a 401 to the sign-in-again CTA, not a retry", () => {
    stubChat({
      status: "error",
      error: new ChatAuthError(401, "Session gone"),
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Sign in again");
    expect(html).not.toContain("Try again");
  });

  it("shows no-access on a 403", () => {
    stubChat({
      status: "error",
      error: new ChatAuthError(403, "No access"),
    });
    expect(renderPanel("trip-1")).toContain("have access");
  });
});

describe("ChatPanel reconnect (issue #152: dropped turn)", () => {
  it("shows the Reconnect banner on an interrupted finish", () => {
    stubChat({
      messages: [
        userText("Create a trip"),
        {
          id: "a1",
          role: "assistant",
          metadata: { interrupted: true },
          parts: [{ type: "text", text: "partial…" }],
        },
      ],
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Connection lost");
    expect(html).toContain("Reconnect");
  });

  it("shows no banner on a clean finish", () => {
    stubChat({
      messages: [
        userText("Hi"),
        assistantText("Hello **there**"),
      ],
      status: "ready",
    });
    const html = renderPanel("trip-1");
    expect(html).not.toContain("Connection lost");
    expect(html).not.toContain("Reconnect");
  });
});

describe("ChatPanel attach button (trip chat or landing inbox)", () => {
  it("is visible when a trip chat is bound", () => {
    stubChat();
    expect(renderPanel("trip-1")).toContain('aria-label="Attach a file"');
  });

  it("is visible on the unanchored landing chat (files stage in the inbox)", () => {
    stubChat();
    expect(renderPanel()).toContain('aria-label="Attach a file"');
  });
});

describe("ChatPanel close button", () => {
  it("appears when onClose is provided (popup chrome)", () => {
    stubChat();
    const html = renderToString(
      createElement(ChatPanel, { tripId: "trip-1", onClose: () => {} }),
    );
    expect(html).toContain('aria-label="Close chat"');
  });

  it("is absent in the inline (non-popup) form", () => {
    stubChat();
    expect(renderPanel("trip-1")).not.toContain('aria-label="Close chat"');
  });
});
