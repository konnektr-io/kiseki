import { describe, expect, it } from "vitest";
import { expandSectionDays, sectionIndexForDay, sectionRange } from "./sections";
import type { TripSection } from "./types";

describe("expandSectionDays", () => {
  it("collapses a single-day [n, n] section to one entry", () => {
    expect(expandSectionDays([9, 9])).toEqual([9]);
  });

  it("expands an inclusive range", () => {
    expect(expandSectionDays([2, 4])).toEqual([2, 3, 4]);
  });

  it("passes an explicit non-range day list through unchanged", () => {
    expect(expandSectionDays([0, 3, 7])).toEqual([0, 3, 7]);
  });

  it("returns [] for empty input and undefined", () => {
    expect(expandSectionDays([])).toEqual([]);
    expect(expandSectionDays(undefined)).toEqual([]);
  });
});

describe("sectionRange", () => {
  it("renders a multi-day range from inclusive [first, last]", () => {
    expect(sectionRange([2, 4])).toBe("Days 3–5");
    expect(sectionRange([0, 1])).toBe("Days 1–2");
  });

  it("renders a single day without a range", () => {
    expect(sectionRange([9, 9])).toBe("Day 10");
    expect(sectionRange([0, 0])).toBe("Day 1");
  });

  it("returns null for empty sections (pure ideation pool)", () => {
    expect(sectionRange([])).toBeNull();
    expect(sectionRange(undefined)).toBeNull();
  });

  it("renders an explicit non-contiguous day list as a list, not a range", () => {
    expect(sectionRange([0, 3, 7])).toBe("Days 1, 4, 8");
  });
});

describe("sectionIndexForDay", () => {
  const sections: TripSection[] = [
    { title: "Banff", days: [0, 1] },
    { title: "Revelstoke", days: [2, 4] },
    { title: "The Heli Block", days: [5, 8] },
    { title: "Flex & Fly Home", days: [9, 9] },
  ];

  it("finds the section containing a day inside a range", () => {
    expect(sectionIndexForDay(sections, 0)).toBe(0);
    expect(sectionIndexForDay(sections, 3)).toBe(1);
    expect(sectionIndexForDay(sections, 8)).toBe(2);
  });

  it("handles single-day sections", () => {
    expect(sectionIndexForDay(sections, 9)).toBe(3);
  });

  it("returns undefined for a day outside every section", () => {
    expect(sectionIndexForDay(sections, 11)).toBeUndefined();
  });

  it("returns undefined for empty or missing sections", () => {
    expect(sectionIndexForDay([], 0)).toBeUndefined();
    expect(sectionIndexForDay(undefined, 0)).toBeUndefined();
  });
});
