import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  chatContextKey,
  composeUserMessage,
  findTripIds,
  loadThreadId,
  loadTranscript,
  messageActivities,
  messageInterrupted,
  messageToText,
  saveTranscript,
  toBackendMessage,
  type UploadedChatFile,
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
        {
          type: "text",
          // The handle line rides along with the image_url part: the agent's
          // own view of an image part loses the URL (issue #252), so it gets a
          // resolvable `name @ url` reference for every attachment.
          text: "What is this?\n\nfile: abc123.jpg @ /media/t1/abc123.jpg",
        },
        {
          type: "image_url",
          image_url: { url: "/media/t1/abc123.jpg" },
        },
      ],
      id: "u2",
    });
  });

  it("sends a document as a compact handle, never a markdown link (issue #252)", () => {
    const message: UIMessage = {
      id: "u3",
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "application/pdf",
          filename: "Roadbook II- RAES.pdf",
          url: "/inbox/f00c480ad41b70bd53b14d6644bf5300.pdf",
        },
      ],
    };
    const backend = toBackendMessage(message);
    expect(typeof backend.content).toBe("string");
    expect(backend.content).toBe(
      "file: Roadbook II- RAES.pdf @ /inbox/f00c480ad41b70bd53b14d6644bf5300.pdf",
    );
    // No markdown link: the agent no longer has to parse a URL out of prose
    // that the user also sees.
    expect(String(backend.content)).not.toContain("](");
  });
});

describe("composeUserMessage (issue #252: attachments are parts, not prose)", () => {
  const pdf: UploadedChatFile = {
    url: "/inbox/f00c480ad41b70bd53b14d6644bf5300.pdf",
    name: "Roadbook II- RAES.pdf",
    mediaType: "application/pdf",
    isImage: false,
    size: 2_411_724,
  };
  const photo: UploadedChatFile = {
    url: "/media/t1/abc123.jpg",
    name: "IMG_2812.jpg",
    mediaType: "image/jpeg",
    isImage: true,
    size: 1_048_576,
  };

  it("sends the user's own words as the message text", () => {
    const composed = composeUserMessage("  See attached roadbook.  ", [pdf]);
    expect(composed.text).toBe("See attached roadbook.");
    // The internal storage path never enters the text the bubble renders.
    expect(composed.text).not.toContain("/inbox/");
  });

  it("carries every attachment as a file part with its byte size", () => {
    expect(composeUserMessage("Here you go", [pdf, photo]).files).toEqual([
      {
        type: "file",
        mediaType: "application/pdf",
        url: "/inbox/f00c480ad41b70bd53b14d6644bf5300.pdf",
        filename: "Roadbook II- RAES.pdf",
        size: 2_411_724,
      },
      {
        type: "file",
        mediaType: "image/jpeg",
        url: "/media/t1/abc123.jpg",
        filename: "IMG_2812.jpg",
        size: 1_048_576,
      },
    ]);
  });

  it("keeps a plain message plain", () => {
    expect(composeUserMessage("Hi", [])).toEqual({ text: "Hi", files: [] });
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

describe("assistant text (issue #181 revert: the bubble shows everything)", () => {
  const activityPart = (id: string, done: boolean) =>
    ({
      type: "data-kiseki-activity",
      id,
      data: { label: "Running a command…", done },
    }) as unknown as UIMessage["parts"][number];

  // #181 rendered only the text AFTER the last activity part. Live use showed
  // what that cost: the agent's commentary IS the product ("Days are in. Now
  // the section chapters."), plain answers surfaced late — sometimes after the
  // user's NEXT message — and previous agent messages vanished while a new
  // turn streamed. The bubble renders `messageToText`: every part, in order.
  it("keeps narration and the answer, in stream order", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Days are in. Now the section chapters." },
        activityPart("c1", true),
        { type: "text", text: " 11 days, 3 cities — activities on every day." },
      ],
    };
    const text = messageToText(message);
    expect(text).toContain("Days are in");
    expect(text).toContain("11 days, 3 cities");
    expect(text.indexOf("Days are in")).toBeLessThan(text.indexOf("11 days"));
  });

  it("keeps a plain Q&A answer intact (no activity parts)", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Hello — here's the plan." }],
    };
    expect(messageToText(message)).toBe("Hello — here's the plan.");
  });

  it("keeps a tool-only turn's narration (nothing else would render)", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Pulling the Seoul days together…" },
        activityPart("c1", false),
      ],
    };
    expect(messageToText(message)).toContain("Pulling the Seoul days together");
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

  it("falls back to the generic label and skips parts without data", () => {
    // Empty label → the generic fallback; a recognized part with NO data
    // object at all is malformed (the relay never sends one) → no row.
    expect(
      messageActivities({
        id: "a1",
        role: "assistant",
        parts: [
          activityPart("c1", { label: "", done: false }),
          { type: "data-kiseki-activity", id: "c2" },
        ],
      } as unknown as UIMessage),
    ).toEqual([{ label: "Working…", done: false }]);
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
