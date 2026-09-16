import { describe, expect, it } from "vitest";

import { splitCrew } from "./crew";
import type { Person } from "./types";

const p = (name: string, role: Person["role"]): Person => ({ id: name, name, role });

describe("splitCrew (#315)", () => {
  it("puts every non-follower role in the crew, followers aside", () => {
    const { members, followers } = splitCrew([
      p("Owner", "owner"),
      p("Editor", "editor"),
      p("Viewer", "viewer"),
      p("Watcher", "follower"),
    ]);
    expect(members.map((m) => m.name)).toEqual(["Owner", "Editor", "Viewer"]);
    expect(followers.map((f) => f.name)).toEqual(["Watcher"]);
  });

  it("an undefined crew is two empty lists, not a crash", () => {
    expect(splitCrew(undefined)).toEqual({ members: [], followers: [] });
  });

  it("keeps the original order inside each group", () => {
    const { members, followers } = splitCrew([
      p("A", "follower"),
      p("B", "viewer"),
      p("C", "follower"),
    ]);
    expect(members.map((m) => m.name)).toEqual(["B"]);
    expect(followers.map((f) => f.name)).toEqual(["A", "C"]);
  });
});
