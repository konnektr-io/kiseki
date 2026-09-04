import { describe, expect, it } from "vitest";
import {
  orderedContainerBlockIds,
  removeBlock,
  roleAtLeast,
  stageOptions,
  swapContainerBlocks,
  withBlockFields,
  withBlockItems,
  withTodoDone,
} from "./editing";
import type { Trip } from "./types";

function fixture(): Trip {
  return {
    id: "trip-1",
    slug: "fixture",
    title: "Fixture",
    stage: "planned",
    visibility: "private",
    myRole: "owner",
    crew: [],
    practical: {
      todos: [
        { label: "deposit", done: false },
        { label: "flights", done: true },
      ],
    },
    days: [
      {
        id: "day-1",
        date: "2027-02-15",
        title: "Arrival",
        blocks: [
          { id: "b1", kind: "activity", title: "First", order: 1 },
          { id: "b2", kind: "lodging", title: "Second", order: 2 },
        ],
      },
    ],
    sections: [
      {
        id: "sec-1",
        title: "Chapter",
        days: [0, 0],
        blocks: [{ id: "b3", kind: "todo", title: "Pool idea", order: 1 }],
      },
    ],
  };
}

describe("roleAtLeast", () => {
  it("ranks the ladder and rejects anonymous", () => {
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast(undefined, "follower")).toBe(false);
    expect(roleAtLeast("follower", "viewer")).toBe(false);
  });
});

describe("stageOptions", () => {
  it("offers owners every other stage", () => {
    expect(stageOptions("planned", "owner")).toEqual([
      "idea",
      "options",
      "shortlist",
      "booked",
      "live",
      "archive",
    ]);
  });
  it("offers editors only forward moves, never archive", () => {
    expect(stageOptions("planned", "editor")).toEqual(["booked", "live"]);
    expect(stageOptions("idea", "editor")).toEqual(["options", "shortlist", "planned", "booked", "live"]);
    expect(stageOptions("archive", "editor")).toEqual([]);
  });
  it("offers viewers/followers/anonymous nothing", () => {
    expect(stageOptions("planned", "viewer")).toEqual([]);
    expect(stageOptions("planned", undefined)).toEqual([]);
  });
});

describe("withTodoDone", () => {
  it("flips one todo and leaves the rest untouched (immutably)", () => {
    const t = fixture();
    const next = withTodoDone(t, 0, true);
    expect(next.practical.todos?.[0]?.done).toBe(true);
    expect(next.practical.todos?.[1]?.done).toBe(true); // untouched value
    expect(t.practical.todos?.[0]?.done).toBe(false); // original unchanged
  });
  it("returns the same reference for a no-op", () => {
    const t = fixture();
    expect(withTodoDone(t, 1, true)).toBe(t); // already done
    expect(withTodoDone(t, 99, true)).toBe(t);
  });
});

describe("block snapshots", () => {
  it("patches fields across day and section containers", () => {
    const t = fixture();
    const next = withBlockFields(t, "b2", { status: "booked" });
    expect(next.days[0].blocks[1].status).toBe("booked");
    expect(t.days[0].blocks[1].status).toBeUndefined();

    const sec = withBlockFields(t, "b3", { title: "Scheduled soon" });
    expect(sec.sections?.[0]?.blocks?.[0]?.title).toBe("Scheduled soon");
  });

  it("replaces todo items on a block", () => {
    const t = fixture();
    const next = withBlockItems(t, "b3", [{ label: "Pool idea", done: true }]);
    expect(next.sections?.[0]?.blocks?.[0]?.items).toEqual([{ label: "Pool idea", done: true }]);
  });
});

describe("container order", () => {
  it("lists ids in display order and swaps order values on move", () => {
    const t = fixture();
    expect(orderedContainerBlockIds(t, "day-1")).toEqual(["b1", "b2"]);
    const moved = swapContainerBlocks(t, "day-1", "b2", "b1");
    expect(orderedContainerBlockIds(moved, "day-1")).toEqual(["b2", "b1"]);
  });
});

describe("removeBlock", () => {
  it("drops the block from its container", () => {
    const t = fixture();
    const next = removeBlock(t, "b2");
    expect(next.days[0].blocks.map((b) => b.id)).toEqual(["b1"]);
    const sec = removeBlock(t, "b3");
    expect(sec.sections?.[0]?.blocks ?? []).toEqual([]);
  });
});
