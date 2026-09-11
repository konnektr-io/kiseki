import { describe, expect, it } from "vitest";
import {
  orderedContainerBlockIds,
  removeBlock,
  roleAtLeast,
  stageOptions,
  swapContainerBlocks,
  withBlockFields,
  withBlockItems,
  withCrewMember,
  withTodoDone,
  withTripStage,
  withTripTheme,
  withTripVisibility,
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

describe("trip scalar snapshots", () => {
  it("withTripStage swaps the stage and nothing else", () => {
    const t = fixture();
    const next = withTripStage(t, "booked");
    expect(next.stage).toBe("booked");
    expect(t.stage).toBe("planned"); // original unchanged
    expect(next.title).toBe(t.title);
  });

  it("withTripVisibility swaps visibility and nothing else", () => {
    const t = fixture();
    const next = withTripVisibility(t, "public");
    expect(next.visibility).toBe("public");
    expect(t.visibility).toBe("private"); // original unchanged
  });

  it("withTripTheme produces exactly { preset } and preserves the rest (#200)", () => {
    const t = fixture();
    const next = withTripTheme(t, "ember");
    expect(next.theme).toEqual({ preset: "ember" });
    expect(Object.keys(next.theme!)).toEqual(["preset"]);
    expect(next.title).toBe(t.title);
    expect(next.stage).toBe(t.stage);
    expect(t.theme).toBeUndefined(); // original unchanged
  });

  it("withTripTheme replaces an existing preset with exactly { preset }", () => {
    const t = { ...fixture(), theme: { preset: "nordic" } };
    const next = withTripTheme(t, "sakura");
    expect(next.theme).toEqual({ preset: "sakura" });
    expect(Object.keys(next.theme!)).toEqual(["preset"]);
  });
});

describe("withTodoDone", () => {  it("flips one todo and leaves the rest untouched (immutably)", () => {
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

describe("withCrewMember", () => {
  it("patches note and role of one member only", () => {
    const t: Trip = {
      ...fixture(),
      crew: [
        { id: "p1", name: "Niko", role: "owner", claimed: true },
        { id: "p2", name: "Nick", role: "viewer", claimed: false, note: "old gear" },
      ],
    };
    const next = withCrewMember(t, "p2", { note: "new gear", role: "editor" });
    expect(next.crew[0]).toEqual({ id: "p1", name: "Niko", role: "owner", claimed: true });
    expect(next.crew[1].note).toBe("new gear");
    expect(next.crew[1].role).toBe("editor");
    expect(next.crew[1].claimed).toBe(false);
  });

  it("null clears the note, others untouched", () => {
    const t: Trip = {
      ...fixture(),
      crew: [
        { id: "p1", name: "Niko", role: "owner", claimed: true },
        { id: "p2", name: "Nick", role: "viewer", claimed: false, note: "old gear" },
      ],
    };
    const next = withCrewMember(t, "p2", { note: null });
    expect(next.crew[1].note).toBeUndefined();
    expect(next.crew[1].role).toBe("viewer");
    expect(next.crew[0].note).toBeUndefined();
  });

  it("returns the same reference when nothing changes", () => {
    const t: Trip = {
      ...fixture(),
      crew: [{ id: "p1", name: "Niko", role: "owner", claimed: true }],
    };
    expect(withCrewMember(t, "p1", {})).toBe(t);
    expect(withCrewMember(t, "p1", { note: undefined, role: "owner" })).toBe(t);
  });
});
