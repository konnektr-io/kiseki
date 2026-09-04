import { describe, expect, it } from "vitest";
import { CHROME_PADDING, clampPadding, findLocation, markerNumber } from "./maps";
import type { Trip } from "./types";

const trip = {
  locations: [
    { name: "Banff", alias: [], lat: 51.1784, lng: -115.5708 },
    { name: "Revelstoke", alias: ["Hillcrest"], lat: 50.9981, lng: -118.1957 },
    { name: "Golden", marker: 9, alias: [], lat: 51.292, lng: -116.9656 },
  ],
} as unknown as Trip;

describe("findLocation", () => {
  it("matches a name or an alias, case-insensitively", () => {
    expect(findLocation(trip, "banff")?.name).toBe("Banff");
    expect(findLocation(trip, " Hillcrest ")?.name).toBe("Revelstoke");
  });

  it("is undefined for an unknown place", () => {
    expect(findLocation(trip, "Whistler")).toBeUndefined();
  });
});

describe("markerNumber", () => {
  it("is the registry position, unless the entry overrides it", () => {
    expect(markerNumber(trip, trip.locations![0])).toBe(1);
    expect(markerNumber(trip, trip.locations![2])).toBe(9);
  });
});

describe("clampPadding", () => {
  it("passes padding through when the box has room", () => {
    expect(clampPadding(CHROME_PADDING, 900, 700)).toEqual(CHROME_PADDING);
  });

  it("squeezes opposing sides proportionally, keeping the lean", () => {
    // A sheet at `full` occludes far more than the surface can spare.
    const p = clampPadding({ top: 36, right: 44, bottom: 660, left: 64 }, 390, 700);
    expect(p.top + p.bottom).toBeLessThanOrEqual(700 - 96);
    // The camera still leans away from the sheet.
    expect(p.bottom).toBeGreaterThan(p.top);
    // The unaffected axis is untouched.
    expect(p.left).toBe(64);
    expect(p.right).toBe(44);
  });

  it("gives up entirely on a box smaller than the minimum", () => {
    expect(clampPadding(CHROME_PADDING, 60, 60)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("handles an unmeasured box without producing NaN", () => {
    const p = clampPadding(CHROME_PADDING, 0, 0);
    expect(Object.values(p).every((v) => Number.isFinite(v))).toBe(true);
  });
});
