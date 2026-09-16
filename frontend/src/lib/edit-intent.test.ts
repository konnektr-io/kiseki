/**
 * Edit-intent log (#296, phase 3) — the whole contract: one event carrying
 * entity + field NAMES, and provably no trip content.
 */
import { describe, expect, it, vi } from "vitest";

const captureMock = vi.hoisted(() => vi.fn());
vi.mock("./posthog", () => ({ capture: captureMock }));

const { logEditIntent } = await import("./edit-intent");

describe("logEditIntent", () => {
  it("records entity + fields, never values", () => {
    logEditIntent("day", ["title", "notes"]);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith("agent_edit_requested", {
      entity: "day",
      fields: ["title", "notes"],
    });
  });

  it("a full ask context still logs names only — the draft never travels", () => {
    captureMock.mockClear();
    // What the button hands over: names for the log, values for the drawer.
    // Only the first half may reach this function (typed as strings).
    logEditIntent("block", ["title", "description"]);
    const [, props] = captureMock.mock.calls[0] as [string, Record<string, unknown>];
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain("Revelstoke");
    expect(serialized).toContain("block");
  });
});
