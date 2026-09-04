import { describe, expect, it } from "vitest";
import {
  DETENT_FRACTION,
  detentOcclusionPx,
  detentOffsetPct,
  nearestDetent,
  nextDetent,
  prevDetent,
} from "./sheet";

describe("detentOffsetPct", () => {
  it("does not push the sheet down at full", () => {
    expect(detentOffsetPct("full")).toBe(0);
  });

  it("exposes exactly the detent's fraction of the surface", () => {
    // offset is a percentage of the SHEET's own height (0.9 of the surface),
    // so the exposed slice is (1 - offset/100) * 0.9 of the surface.
    for (const d of ["peek", "half", "full"] as const) {
      const exposed = (1 - detentOffsetPct(d) / 100) * DETENT_FRACTION.full;
      expect(exposed).toBeCloseTo(DETENT_FRACTION[d], 6);
    }
  });
});

describe("nearestDetent", () => {
  it("snaps a drag to the closest detent", () => {
    expect(nearestDetent(0)).toBe("peek");
    expect(nearestDetent(0.2)).toBe("peek");
    expect(nearestDetent(0.4)).toBe("half");
    expect(nearestDetent(0.8)).toBe("full");
    expect(nearestDetent(2)).toBe("full");
  });
});

describe("nextDetent / prevDetent", () => {
  it("steps up and down one detent", () => {
    expect(nextDetent("peek")).toBe("half");
    expect(nextDetent("half")).toBe("full");
    expect(prevDetent("full")).toBe("half");
    expect(prevDetent("half")).toBe("peek");
  });

  it("clamps at the ends — the sheet never dismisses", () => {
    expect(nextDetent("full")).toBe("full");
    expect(prevDetent("peek")).toBe("peek");
  });
});

describe("detentOcclusionPx", () => {
  it("is the map's padding.bottom for the detent", () => {
    expect(detentOcclusionPx("peek", 800)).toBe(120);
    expect(detentOcclusionPx("half", 800)).toBe(400);
    expect(detentOcclusionPx("full", 800)).toBe(720);
  });

  it("is 0 on an unmeasured surface", () => {
    expect(detentOcclusionPx("half", 0)).toBe(0);
  });
});
