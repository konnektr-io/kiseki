import { describe, expect, it } from "vitest";
import { todayDayIdx, todayExactIdx } from "./dates";
import type { Trip } from "./types";

function trip(over: Partial<Trip> = {}): Trip {
  return {
    id: "t1",
    slug: "t1",
    title: "T",
    stage: "live",
    startDate: "2027-09-20",
    endDate: "2027-09-24",
    timezone: "UTC",
    visibility: "private",
    days: [
      { id: "d0", date: "2027-09-20", title: "Day 1", blocks: [] },
      { id: "d1", date: "2027-09-21", title: "Day 2", blocks: [] },
      { id: "d2", date: "2027-09-22", title: "Day 3", blocks: [] },
    ],
    sections: [],
    locations: [],
    crew: [],
    practical: {},
    ...over,
  } as unknown as Trip;
}

describe("todayDayIdx", () => {
  it("resolves an exact day match", () => {
    expect(todayDayIdx(trip(), "2027-09-21")).toBe(1);
  });

  it("falls back to the nearest day when today has no exact day", () => {
    const t = trip({
      days: [
        { id: "d0", date: "2027-09-20", title: "Day 1", blocks: [] },
        { id: "d1", date: "2027-09-22", title: "Day 3", blocks: [] },
      ],
    } as Partial<Trip>);
    expect(todayDayIdx(t, "2027-09-21")).toBe(0);
  });

  it("resolves a section-covered gap to the section's nearest day", () => {
    const t = trip({
      days: [{ id: "d0", date: "2027-09-20", title: "Day 1", blocks: [] }],
      sections: [{ id: "s0", title: "Stay", days: [0, 2] }],
    } as unknown as Partial<Trip>);
    // 2027-09-21 is offset 1 — inside the section range, no exact day.
    expect(todayDayIdx(t, "2027-09-21")).toBe(0);
  });

  it("returns null before / after the range and without dates", () => {
    expect(todayDayIdx(trip(), "2027-09-19")).toBeNull();
    expect(todayDayIdx(trip(), "2027-09-25")).toBeNull();
    expect(todayDayIdx(trip({ startDate: undefined, endDate: undefined }), "2027-09-21")).toBeNull();
  });

  it("returns null when there are no days at all", () => {
    expect(todayDayIdx(trip({ days: [] }), "2027-09-21")).toBeNull();
  });
});

describe("todayExactIdx", () => {
  it("resolves only an exact date match", () => {
    expect(todayExactIdx(trip(), "2027-09-21")).toBe(1);
  });

  it("returns null for nearest-day and section fallbacks", () => {
    // Gap day: todayDayIdx honestly falls back to the nearest day…
    const gap = trip({
      days: [
        { id: "d0", date: "2027-09-20", title: "Day 1", blocks: [] },
        { id: "d1", date: "2027-09-22", title: "Day 3", blocks: [] },
      ],
    } as Partial<Trip>);
    expect(todayDayIdx(gap, "2027-09-21")).toBe(0);
    // …but the today chrome needs the exact date.
    expect(todayExactIdx(gap, "2027-09-21")).toBeNull();
  });

  it("returns null outside the range", () => {
    expect(todayExactIdx(trip(), "2027-09-19")).toBeNull();
    expect(todayExactIdx(trip(), "2027-09-25")).toBeNull();
  });
});
