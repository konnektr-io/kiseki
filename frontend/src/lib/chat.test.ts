import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  chatContextKey,
  findTripIds,
  loadThreadId,
  loadTranscript,
  messageActivities,
  messageInterrupted,
  messageToText,
  saveTranscript,
  toBackendMessage,
} from "./chat";

/* The chat wire client: the outbound message mapping (UIMessage → backend
 * ChatMessage), trip-link detection, and the thread/trip-id helpers.
 *
 * The wire itself (UI-message-stream v1 SSE — `data: {chunk}` events …
 * `data: [DONE]`, `x-vercel-ai-ui-message-stream: v1`) is parsed by the
 * stock `DefaultChatTransport` our `KisekiChatTransport` extends; its
 * coverage lives in `chat.transport.test.ts`.
 */

function textMessage(text: string): UIMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text }],
  };
}

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

describe("chat threads", () => {
  it("keys the general context separately from trips", () => {
    expect(chatContextKey()).toBe("general");
    expect(chatContextKey("trip-1")).toBe("trip-1");
  });

  it("returns null without a browser store (SSR-safe)", () => {
    expect(loadThreadId("general")).toBeNull();
  });
});

describe("messageInterrupted (issue #152: cut vs clean terminal)", () => {
  function assistantMessage(parts: UIMessage["parts"]): UIMessage {
    return { id: "a1", role: "assistant", parts };
  }

  it("flags a finish marked interrupted (cut connection)", () => {
    expect(
      messageInterrupted({
        id: "a1",
        role: "assistant",
        metadata: { interrupted: true },
        parts: [{ type: "text", text: "par" }],
      }),
    ).toBe(true);
  });

  it("passes a clean finish (agent completed)", () => {
    expect(
      messageInterrupted(
        assistantMessage([{ type: "text", text: "done" }]),
      ),
    ).toBe(false);
  });

  it("ignores user messages and text-only parts", () => {
    expect(
      messageInterrupted({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      }),
    ).toBe(false);
  });
});

describe("messageActivities (issue #157: activity data parts)", () => {
  function activityPart(
    id: string,
    data: { label: string; done: boolean },
  ): UIMessage["parts"][number] {
    return { type: "data-kiseki-activity", id, data } as unknown as UIMessage["parts"][number];
  }

  it("reads activity rows from data-kiseki-activity parts", () => {
    const rows = messageActivities({
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "One moment…" },
        activityPart("c1", { label: "Searching the web…", done: true }),
        activityPart("c2", { label: "Running a command…", done: false }),
      ],
    });
    expect(rows).toEqual([
      { label: "Searching the web…", done: true },
      { label: "Running a command…", done: false },
    ]);
  });

  it("yields [] for tool parts and unknown data parts (never trusts them)", () => {
    // The old wire (tool-kiseki-activity tool parts) must NOT be picked up:
    // the SDK only settles declared-tool parts, so a stale tool part would
    // have shown a row the data wire no longer sends.
    const rows = messageActivities({
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-kiseki-activity",
          toolCallId: "c1",
          toolName: "kiseki-activity",
          state: "input-available",
          input: { label: "Searching the web…" },
        },
        { type: "data-trip-update", id: "d1", data: { anything: true } },
      ],
    } as unknown as UIMessage);
    expect(rows).toEqual([]);
  });

  it("falls back to the generic label and ignores malformed data", () => {
    expect(
      messageActivities({
        id: "a1",
        role: "assistant",
        parts: [
          activityPart("c1", { label: "", done: false }),
          { type: "data-kiseki-activity", id: "c2" },
        ],
      } as unknown as UIMessage),
    ).toEqual([
      { label: "Working…", done: false },
      { label: "Working…", done: false },
    ]);
  });
});

describe("transcript persistence (issue #152: reload restores)", () => {
  it("returns [] with no browser store (SSR-safe)", () => {
    expect(loadTranscript("thread-1")).toEqual([]);
  });

  it("saveTranscript is a no-op without a browser store", () => {
    expect(() =>
      saveTranscript("thread-1", [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]),
    ).not.toThrow();
  });
});
