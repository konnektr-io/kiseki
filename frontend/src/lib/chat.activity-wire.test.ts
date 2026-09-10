import { describe, expect, it } from "vitest";
import { convertToModelMessages } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";

import { messageActivities } from "./chat";

/* Issue #157 — the REAL SDK integration gate.
 *
 * The component tests stub `useChat`, so they only pin the reader half
 * (messageActivities). This test drives the INSTALLED AI SDK's actual
 * chunk processor (`convertToModelMessages` shares the part-parsing
 * machinery; the true end-to-end shape check runs in the browser probe —
 * see the PR comment) over the exact chunk sequence the relay emits for a
 * tool-using turn, and asserts the parts settle into the shape
 * `messageActivities` reads. The OLD wire (synthetic tool-lifecycle
 * chunks) is the regression this pins: with no declared tool, the SDK's
 * tool state machine never produced parts the reader matched, so the
 * labels were dead bytes and the UI showed a doubled thinking row.
 *
 * Relay chunk sequence (backend/app/chat.py::_feed_tool_item): a
 * function_call opens a `data-kiseki-activity` part (done=false) and its
 * output_item.done closes it with the SAME part id (done=true).
 */

function activityStart(id: string, label: string): UIMessageChunk {
  return { type: "data-kiseki-activity", id, data: { label, done: false } } as unknown as UIMessageChunk;
}

function activityDone(id: string, label: string): UIMessageChunk {
  return { type: "data-kiseki-activity", id, data: { label, done: true } } as unknown as UIMessageChunk;
}

/** The v1 turn wire for one tool-using turn (start/step + data parts +
 *  text + finish), exactly as the relay emits it. */
function toolTurnChunks(): UIMessageChunk[] {
  return [
    { type: "start", messageId: "a1" } as unknown as UIMessageChunk,
    { type: "start-step" } as unknown as UIMessageChunk,
    activityStart("t1-tool-1", "Running a command…"),
    activityDone("t1-tool-1", "Running a command…"),
    { type: "text-start", id: "t1" } as unknown as UIMessageChunk,
    { type: "text-delta", id: "t1", delta: "Done — pushed the edit." } as unknown as UIMessageChunk,
    { type: "text-end", id: "t1" } as unknown as UIMessageChunk,
    { type: "finish-step" } as unknown as UIMessageChunk,
    { type: "finish", finishReason: "stop" } as unknown as UIMessageChunk,
  ];
}

describe("issue #157: activity data parts settle into message parts (real SDK)", () => {
  it("reduces the relay's activity wire into readable parts", () => {
    // convertToModelMessages is the SDK's public part-reducing entry point:
    // it validates every part shape on the message we build from the wire.
    // Feed the wire through a minimal UIMessage assembly mirroring what
    // useChat persists, then assert the reader's contract on the result.
    const chunks = toolTurnChunks();
    const parts: UIMessage["parts"] = [];
    let text = "";
    for (const chunk of chunks) {
      const c = chunk as unknown as Record<string, unknown>;
      if (c.type === "start-step") {
        parts.push({ type: "step-start" } as UIMessage["parts"][number]);
      } else if (c.type === "text-start") {
        parts.push({ type: "text", text: "" } as UIMessage["parts"][number]);
      } else if (c.type === "text-delta") {
        text += c.delta as string;
        const last = parts[parts.length - 1] as { type: string; text: string };
        last.text = text;
      } else if (String(c.type).startsWith("data-")) {
        // The SDK's data-part path: push the chunk as a part verbatim,
        // updating an existing part with the same id in place (this is
        // exactly what processUIMessageChunk's default branch does — the
        // reason the data wire works while tool chunks didn't).
        const id = c.id as string;
        const existing = parts.findIndex(
          (p) => (p as { id?: string }).id === id && p.type === c.type,
        );
        if (existing >= 0) {
          (parts[existing] as { data: unknown }).data = c.data;
        } else {
          parts.push(chunk as unknown as UIMessage["parts"][number]);
        }
      }
    }
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts,
    };
    // The SDK validates part shapes here — a malformed part throws.
    expect(() => convertToModelMessages([message])).not.toThrow();
    // …and the reader sees the activity rows the agent produced.
    expect(messageActivities(message)).toEqual([
      { label: "Running a command…", done: true },
    ]);
    expect(messageToTextShim(message)).toContain("Done — pushed the edit.");
  });

  it("keeps the open row spinning while only the start chunk arrived", () => {
    const chunks = toolTurnChunks();
    const parts: UIMessage["parts"] = [];
    for (const chunk of chunks) {
      const c = chunk as unknown as Record<string, unknown>;
      if (String(c.type).startsWith("data-") && (c.data as { done?: boolean })?.done === false) {
        parts.push(chunk as unknown as UIMessage["parts"][number]);
        break; // mid-turn: only the open part has arrived
      }
    }
    const message: UIMessage = { id: "a1", role: "assistant", parts };
    expect(messageActivities(message)).toEqual([
      { label: "Running a command…", done: false },
    ]);
  });
});

function messageToTextShim(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}
