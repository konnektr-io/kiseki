/**
 * The presentation helpers that stayed in the client after #457.
 *
 * Everything that DECIDED the trip's shape (which places chain, which leg
 * matches which block, which days a place owns) moved to `backend/app/journey.py`
 * and is pinned there. These are the labels and geometry a renderer still needs,
 * and they keep their own tests because they are pure and cheap.
 */

import { describe, expect, it } from "vitest";
import {
  dayRangeLabel,
  greatCircle,
  LEG_GAP_MODE,
  LEG_STAGE_LABELS,
  markerPaintRank,
  resolveLegCoordinates,
} from "./route-surface";

describe("dayRangeLabel", () => {
  it("labels a single day, a run, and a mixed list literally", () => {
    expect(dayRangeLabel([0])).toBe("Day 1");
    expect(dayRangeLabel([2, 3, 4])).toBe("Days 3–5");
    expect(dayRangeLabel([1, 2, 5])).toBe("Days 2–3, 6");
    expect(dayRangeLabel([9, 0])).toBe("Days 1, 10");
  });

  it("has no label for no days", () => {
    expect(dayRangeLabel([])).toBeNull();
  });
});

describe("the leg vocabulary", () => {
  it("names every stage and the gap sentinel", () => {
    expect(LEG_STAGE_LABELS).toEqual({
      provisional: "Provisional",
      planned: "Planned",
      booked: "Booked",
    });
    expect(LEG_GAP_MODE).toBe("gap");
  });
});

describe("markerPaintRank", () => {
  const isExcursion = (place: { name: string }) => place.name === "Venue";

  it("paints an excursion under a stop pin, and a chip above both (#388)", () => {
    expect(markerPaintRank({ role: "place", place: { name: "Venue" } }, isExcursion)).toBe(0);
    expect(markerPaintRank({ role: "place", place: { name: "Base" } }, isExcursion)).toBe(1);
    expect(markerPaintRank({ role: "activity", place: { name: "Venue" } }, isExcursion)).toBe(2);
  });
});

describe("greatCircle", () => {
  it("returns steps + 1 points between the endpoints", () => {
    const arc = greatCircle([4, 50], [10, 45], 8);
    expect(arc).toHaveLength(9);
    expect(arc[0][0]).toBeCloseTo(4, 6);
    expect(arc[8][0]).toBeCloseTo(10, 6);
  });

  it("bows away from the straight line on a long hop", () => {
    // Two points on the same parallel: the great circle runs poleward of it,
    // which is exactly why a flat screen-space line reads as a mistake.
    const arc = greatCircle([0, 60], [100, 60], 48);
    expect(arc[24][1]).toBeGreaterThan(65);
  });

  it("falls back to the two endpoints for a degenerate pair", () => {
    const a: [number, number] = [4, 50];
    expect(greatCircle(a, a)).toEqual([a, a]);
  });
});

describe("resolveLegCoordinates", () => {
  const coords: [number, number][] = [
    [-71.6, -33.0],
    [-70.0, -20.0],
    [-77.0, 12.0],
  ];

  it("keeps a road leg's own geometry", () => {
    expect(resolveLegCoordinates({ road: true, geometry: { type: "LineString", coordinates: coords } })).toBe(
      coords,
    );
  });

  it("arcs a non-road leg between its endpoints (#357 §8.4)", () => {
    const arc = resolveLegCoordinates({ road: false, geometry: { type: "LineString", coordinates: coords } });
    expect(arc).toHaveLength(49);
    expect(arc).not.toBe(coords);
  });

  it("leaves a one-point geometry alone rather than inventing a path", () => {
    const single: [number, number][] = [[4, 50]];
    expect(resolveLegCoordinates({ road: false, geometry: { type: "LineString", coordinates: single } })).toBe(
      single,
    );
  });
});
