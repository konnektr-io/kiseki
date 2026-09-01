import { describe, expect, it } from "vitest";
import { expandSectionDays } from "./sections";

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
