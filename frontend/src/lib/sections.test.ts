import { describe, expect, it } from "vitest";
import { expandSectionDays, itineraryItems, sectionIndexForDay, sectionRange } from "./sections";
import type { TripSection } from "./types";

describe("expandSectionDays", () => {
  it("collapses a single-day [n, n] section to one entry", () => {
    expect(expandSectionDays([9, 9])).toEqual([9]);
  });

  it("expands an inclusive [first, last] range", () => {
    expect(expandSectionDays([2, 4])).toEqual([2, 3, 4]);
  });

  it("returns [] for empty input", () => {
    expect(expandSectionDays([])).toEqual([]);
    expect(expandSectionDays(undefined)).toEqual([]);
  });
});

describe("sectionRange", () => {
  it("renders a range as 'Days N–M'", () => {
    expect(sectionRange([2, 4])).toBe("Days 3–5");
  });

  it("renders a single day as 'Day N'", () => {
    expect(sectionRange([9, 9])).toBe("Day 10");
  });

  it("returns null when there are no days", () => {
    expect(sectionRange([])).toBeNull();
    expect(sectionRange(undefined)).toBeNull();
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

describe("itineraryItems", () => {
  it("renders every day when no fold is declared", () => {
    const s: TripSection = { title: "Revelstoke", days: [2, 4] };
    expect(itineraryItems(s)).toEqual([
      { kind: "day", idx: 2 },
      { kind: "day", idx: 3 },
      { kind: "day", idx: 4 },
    ]);
  });

  it("folds a consecutive group into one card in place", () => {
    const s: TripSection = {
      title: "The Heli Block",
      days: [5, 8],
      fold: [{ title: "Heli Days 1–3", days: [6, 7, 8] }],
    };
    expect(itineraryItems(s)).toEqual([
      { kind: "day", idx: 5 },
      { kind: "fold", title: "Heli Days 1–3", indices: [6, 7, 8] },
    ]);
  });

  it("ignores a fold that is not consecutive or outside the section range", () => {
    const s: TripSection = {
      title: "The Heli Block",
      days: [5, 8],
      fold: [
        { title: "bad-gap", days: [5, 7] },
        { title: "bad-range", days: [8, 9] },
        { title: "bad-single", days: [6] },
      ],
    };
    expect(itineraryItems(s)).toEqual([
      { kind: "day", idx: 5 },
      { kind: "day", idx: 6 },
      { kind: "day", idx: 7 },
      { kind: "day", idx: 8 },
    ]);
  });

  it("supports multiple folds and a leading single day", () => {
    const s: TripSection = {
      title: "Multi",
      days: [0, 6],
      fold: [
        { title: "A", days: [0, 1] },
        { title: "B", days: [4, 5] },
      ],
    };
    expect(itineraryItems(s)).toEqual([
      { kind: "fold", title: "A", indices: [0, 1] },
      { kind: "day", idx: 2 },
      { kind: "day", idx: 3 },
      { kind: "fold", title: "B", indices: [4, 5] },
      { kind: "day", idx: 6 },
    ]);
  });

  it("returns [] for an empty section", () => {
    expect(itineraryItems({ title: "Pool", days: [] })).toEqual([]);
  });
});
