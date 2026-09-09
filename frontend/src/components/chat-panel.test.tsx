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

describe("ChatPanel attach button (anchored-only uploads)", () => {
  it("is visible when a trip chat is bound", () => {
    stubChat();
    expect(renderPanel("trip-1")).toContain('aria-label="Attach a file"');
  });

  it("is hidden on the unanchored landing chat", () => {
    stubChat();
    expect(renderPanel()).not.toContain('aria-label="Attach a file"');
  });
});
