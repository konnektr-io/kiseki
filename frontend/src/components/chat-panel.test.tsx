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
import { ChatPanel, shouldOfferReconnect } from "./chat-panel";

function assistantText(text: string): UIMessage {
  return { id: "a1", role: "assistant", parts: [{ type: "text", text }] };
}

function userText(text: string): UIMessage {
  return { id: "u1", role: "user", parts: [{ type: "text", text }] };
}

/** A user message carrying attachments — SDK file parts plus the `size` the
 *  bubble's chip reads (issue #252; the SDK type has no room for it). */
function userFiles(
  text: string,
  files: Array<Record<string, unknown>>,
): UIMessage {
  return {
    id: "u-files",
    role: "user",
    parts: [{ type: "text", text }, ...files],
  } as unknown as UIMessage;
}

/** `n` photo parts, as a batch upload produces them. */
function photos(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    type: "file",
    mediaType: "image/jpeg",
    filename: `p${i + 1}.jpg`,
    url: `/media/t1/p${i + 1}.jpg`,
    size: 900_000,
  }));
}

/** An assistant message shaped like a REAL tool-using turn (issue #179):
 *  narration text parts, `data-kiseki-activity` parts, then the answer. */
function toolTurn(
  segments: Array<
    | { kind: "text"; text: string }
    | { kind: "activity"; id: string; label: string; done: boolean }
  >,
): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: segments.map((s) =>
      s.kind === "text"
        ? { type: "text", text: s.text }
        : {
            type: "data-kiseki-activity",
            id: s.id,
            data: { label: s.label, done: s.done },
          },
    ),
  } as unknown as UIMessage;
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
  it("renders settled assistant markdown", () => {
    stubChat({
      messages: [userText("Hi"), assistantText("Hello **there**")],
      status: "ready",
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Hi");
    expect(html).toContain("<strong>there</strong>");
  });

  it("streams a plain answer while the turn is still running (issue #181 revert)", () => {
    // #181 held pre-tool text back mid-stream (unclassifiable as answer vs
    // narration) and rendered it only at settle — which also delayed every
    // plain answer, so it could surface after the user's NEXT message. Text
    // renders as it arrives.
    stubChat({
      messages: [userText("Hi"), assistantText("Hello **there**")],
      status: "streaming",
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("<strong>there</strong>");
    expect(html).toContain("Agent is thinking");
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

  it("renders the agent's running commentary as well as its answer (issue #181 revert)", () => {
    // Live use of #181: hiding pre-tool text also hid the commentary the user
    // wants — "Days are in. Now the section chapters." — and delayed the
    // answer until settle. The bubble shows every text part, in stream order.
    stubChat({
      messages: [
        userText("Plan day 3"),
        toolTurn([
          { kind: "text", text: "Days are in. Now the section chapters." },
          { kind: "activity", id: "c1", label: "Checking trip data…", done: true },
          { kind: "text", text: "Day 3 is in — heli day, lunch in Catomba." },
        ]),
      ],
      status: "streaming",
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Days are in. Now the section chapters.");
    expect(html).toContain("Day 3 is in");
    expect(html).toContain("Checking trip data…");
  });

  it("keeps earlier agent messages on screen while a new turn streams (issue #181 revert)", () => {
    // The reported defect: send a follow-up and every agent bubble vanished —
    // `busy` was passed to EVERY bubble, and a busy bubble with no activity
    // parts rendered nothing. Only the live activity row belongs to `busy`.
    stubChat({
      messages: [
        userText("What's the plan?"),
        assistantText("Three cities, eleven days."),
        userText("add activities on all days"),
        toolTurn([
          { kind: "text", text: "Working through the days…" },
          { kind: "activity", id: "c1", label: "Writing trip data…", done: false },
        ]),
      ],
      status: "streaming",
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Three cities, eleven days.");
    expect(html).toContain("Working through the days…");
  });

  it("never claims a finished tool: the row spins for the whole turn", () => {
    // A per-call checkmark flipped the instant one call's result landed, while
    // the turn kept working — a premature "finished" claim in a single-row feed.
    stubChat({
      messages: [
        userText("add activities"),
        toolTurn([
          { kind: "activity", id: "c1", label: "Writing trip data…", done: true },
        ]),
      ],
      status: "streaming",
    });
    const html = renderPanel("trip-1");
    expect(html).not.toContain("✓");
    expect(html).toContain("Writing trip data…");
  });

  it("adds no synthetic acknowledgement for a tool-only turn", () => {
    // "Handled — your trip is up to date." asserted success the agent never
    // stated (and was sometimes untrue). The agent's own words are the only
    // text the UI shows.
    stubChat({
      messages: [
        userText("Plan day 3"),
        toolTurn([
          { kind: "text", text: "Checking the trip data first…" },
          { kind: "activity", id: "c1", label: "Writing trip data…", done: true },
        ]),
      ],
      status: "ready",
    });
    const html = renderPanel("trip-1");
    expect(html).not.toContain("Handled");
    expect(html).toContain("Checking the trip data first…");
  });

  it("keeps plain Q&A turns fully visible (no activity parts)", () => {
    stubChat({
      messages: [userText("Hi"), assistantText("Hello — where to next?")],
      status: "ready",
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("Hello — where to next?");
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

  it("chips a document — filename + size, the URL only as an href (issue #252)", () => {
    stubChat({
      messages: [
        userFiles("See attached roadbook.", [
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "Roadbook II- RAES.pdf",
            url: "/inbox/f00c480ad41b70bd53b14d6644bf5300.pdf",
            size: 2_411_724,
          },
        ]),
      ],
    });
    const html = renderPanel("trip-1");
    expect(html).toContain("See attached roadbook.");
    expect(html).toContain("Roadbook II- RAES.pdf");
    expect(html).toContain("2.3 MB");
    expect(html).toContain(
      'href="/inbox/f00c480ad41b70bd53b14d6644bf5300.pdf"',
    );
    // The internal path is a link target, never text the bubble has to wrap.
    expect(html).not.toContain("](/inbox/");
  });

  it("collapses a photo batch into one count chip (issue #252)", () => {
    stubChat({ messages: [userFiles("Ten photos.", photos(10))] });
    const html = renderPanel("trip-1");
    expect(html).toContain("Ten photos.");
    expect(html).toContain("10 photos");
    // One thumbnail carries the batch — not ten images stacked in the bubble.
    expect((html.match(/<img/g) ?? []).length).toBe(1);
  });

  it("can never be widened by a long unbreakable token (issue #252)", () => {
    // Even a URL the user types by hand wraps instead of stretching the card.
    stubChat({
      messages: [userText("/inbox/f00c480ad41b70bd53b14d6644bf5300.pdf")],
    });
    const html = renderPanel("trip-1");
    // `wrap-anywhere` (overflow-wrap: anywhere) is the safety net: unlike
    // break-word it also shrinks the bubble's min-content width, so a pasted
    // token can't push the bubble past its `max-w-[85%]` cap the way the
    // roadbook URL did (#252).
    expect(html).toContain("wrap-anywhere");
    expect(html).toContain("min-w-0");
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

/* When to offer Reconnect (#152 → #217). The banner is the LAST resort: a turn
 * the relay cut that nothing is picking up. A thread that is re-attaching to
 * its turn (or already has) must not offer it — the resume is happening. */
describe("shouldOfferReconnect (#217)", () => {
  const cut: UIMessage = {
    id: "a1",
    role: "assistant",
    metadata: { interrupted: true },
    parts: [{ type: "text", text: "partial…" }],
  };
  const base = { working: false, error: undefined, recovery: "idle" as const };

  it("offers it for a cut turn nothing is resuming", () => {
    expect(shouldOfferReconnect({ ...base, lastMessage: cut })).toBe(true);
    expect(shouldOfferReconnect({ ...base, lastMessage: userText("hi") })).toBe(
      false,
    );
    expect(
      shouldOfferReconnect({ ...base, lastMessage: assistantText("done") }),
    ).toBe(false);
    expect(shouldOfferReconnect({ ...base, lastMessage: null })).toBe(false);
  });

  it("stays out of the way while the turn is being attached to", () => {
    expect(
      shouldOfferReconnect({ ...base, recovery: "checking", lastMessage: cut }),
    ).toBe(false);
    // the attach rebuilt the turn — the affordance has nothing left to do
    expect(
      shouldOfferReconnect({ ...base, recovery: "attached", lastMessage: cut }),
    ).toBe(false);
    // ...but once the relay holds nothing, re-sending is the user's call
    expect(
      shouldOfferReconnect({
        ...base,
        recovery: "unavailable",
        lastMessage: cut,
      }),
    ).toBe(true);
  });

  it("never competes with live work", () => {
    expect(shouldOfferReconnect({ ...base, working: true, lastMessage: cut })).toBe(
      false,
    );
  });

  /** #238: on a phone the socket dies with the screen, so no terminal chunk —
   *  and therefore no `interrupted` flag — ever arrives. The error the
   *  transport surfaces IS the drop, and the turn is still worth attaching to
   *  (the relay kept working), so the button must be there. */
  it("offers it for a turn the transport errored on (#237)", () => {
    const partial: UIMessage = {
      id: "a2",
      role: "assistant",
      parts: [{ type: "text", text: "The Daisetsuzan stretch…" }],
    };
    const dropped = { ...base, error: new Error("network error") };
    expect(shouldOfferReconnect({ ...dropped, lastMessage: partial })).toBe(true);
    // a user tail is not a dropped answer — there is nothing to attach to
    expect(
      shouldOfferReconnect({ ...dropped, lastMessage: userText("hi") }),
    ).toBe(false);
    expect(shouldOfferReconnect({ ...dropped, lastMessage: null })).toBe(false);
    // ...and an attach that is already running still owns the turn
    expect(
      shouldOfferReconnect({
        ...dropped,
        recovery: "checking",
        lastMessage: partial,
      }),
    ).toBe(false);
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
