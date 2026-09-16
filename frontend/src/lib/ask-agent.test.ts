/**
 * Ask-agent context builders (#296, phase 2) — pure functions: entity ids,
 * human labels, the field-name list (for the intent log) and the pre-filled
 * composer draft (ids + current values, capped).
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  ASK_AGENT_EVENT,
  blockAskContext,
  dayAskContext,
  requestAskAgent,
  sectionAskContext,
  type AskAgentContext,
} from "./ask-agent";
import type { Trip } from "./types";

function trip(): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test Trip",
    stage: "planned",
    visibility: "private",
    crew: [],
    practical: {},
    days: [
      {
        id: "d1",
        date: "2027-07-01",
        title: "Rest day",
        notes: "Sleep in.",
        blocks: [{ id: "b1", kind: "activity", title: "Ski", order: 0 }],
      },
    ],
    sections: [{ id: "s1", title: "First tracks", days: [0, 0] }],
    locations: [],
  } as unknown as Trip;
}

describe("dayAskContext", () => {
  it("carries the day id, label, fields and current values", () => {
    const ctx = dayAskContext(trip(), 0);
    expect(ctx?.entity).toBe("day");
    expect(ctx?.id).toBe("d1");
    expect(ctx?.label).toBe("Day 1 — Rest day");
    expect(ctx?.fields).toEqual(["title", "notes"]);
    expect(ctx?.draft).toContain("day_id=d1");
    expect(ctx?.draft).toContain("Rest day");
    expect(ctx?.draft).toContain("Sleep in.");
  });

  it("falls back to the date for an untitled day, null for a bad index", () => {
    const t = trip();
    t.days[0].title = "";
    expect(dayAskContext(t, 0)?.label).toBe("Day 1 — 2027-07-01");
    expect(dayAskContext(t, 9)).toBeNull();
  });

  it("caps a long notes blob instead of pasting it whole", () => {
    const t = trip();
    t.days[0].notes = "x".repeat(2000);
    const draft = dayAskContext(t, 0)?.draft ?? "";
    expect(draft.length).toBeLessThan(1000);
    expect(draft).toContain("…");
  });
});

describe("sectionAskContext", () => {
  it("names the section and its day range", () => {
    const ctx = sectionAskContext(trip().sections![0]);
    expect(ctx.entity).toBe("section");
    expect(ctx.id).toBe("s1");
    expect(ctx.fields).toEqual(["title"]);
    expect(ctx.draft).toContain("section_id=s1");
    expect(ctx.draft).toContain("day 1");
  });
});

describe("blockAskContext", () => {
  it("says where the block lives (day container)", () => {
    const t = trip();
    const ctx = blockAskContext(t, t.days[0].blocks[0], "d1");
    expect(ctx.entity).toBe("block");
    expect(ctx.id).toBe("b1");
    expect(ctx.fields).toEqual(["title", "description"]);
    expect(ctx.draft).toContain("block_id=b1");
    expect(ctx.draft).toContain("on Day 1");
    expect(ctx.draft).toContain("activity");
  });

  it("names the section for a section container, stays vague otherwise", () => {
    const t = trip();
    const b = t.days[0].blocks[0];
    expect(blockAskContext(t, b, "s1").draft).toContain("in the section “First tracks”");
    expect(blockAskContext(t, b, "nope").draft).toContain("unknown container");
  });
});

describe("requestAskAgent", () => {
  it("dispatches the bridge event with the context as detail", () => {
    const seen: AskAgentContext[] = [];
    const onAsk = (e: Event) => seen.push((e as CustomEvent<AskAgentContext>).detail);
    window.addEventListener(ASK_AGENT_EVENT, onAsk);
    try {
      const ctx = dayAskContext(trip(), 0)!;
      requestAskAgent(ctx);
      expect(seen).toEqual([ctx]);
    } finally {
      window.removeEventListener(ASK_AGENT_EVENT, onAsk);
    }
  });
});
