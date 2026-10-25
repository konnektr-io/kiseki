import { describe, expect, it } from "vitest";
import {
  DETENT_FRACTION,
  detentOcclusionPx,
  detentOffsetPct,
  nearestDetent,
  nextDetent,
  prevDetent,
  sheetBodyHeightPx,
  sheetFloorPx,
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

describe("sheetFloorPx", () => {
  it("ends at the surface's bottom edge when the surface is fully on screen", () => {
    expect(sheetFloorPx(61, 663, 780)).toBe(724);
  });

  it("ends at the viewport when the surface runs under the browser chrome", () => {
    // A surface taller than what you can see: the floor is the viewport's
    // bottom, in the SAME frame as the rects (the old code compared a
    // surface-local number against `innerHeight` — different frames).
    expect(sheetFloorPx(61, 900, 780)).toBe(780);
  });
});

describe("sheetBodyHeightPx", () => {
  // The real phone geometry (360×780, 61px of app chrome above the surface).
  const geo = {
    surfaceTop: 61,
    surfaceHeight: 663,
    sheetHeight: 597, // 90% of the surface
    viewportHeight: 780,
    bodyOffsetTop: 116, // drag handle + peek line
  };
  /** Where the body's bottom lands, given the sheet's visual top. */
  const bodyBottom = (detent: "peek" | "half" | "full", height: number, dragPx = 0) =>
    geo.surfaceTop +
    geo.surfaceHeight -
    geo.sheetHeight +
    (detentOffsetPct(detent) / 100) * geo.sheetHeight +
    dragPx +
    geo.bodyOffsetTop +
    height;

  it("ends the body on the sheet's visible floor at every visible detent", () => {
    for (const detent of ["half", "full"] as const) {
      const h = sheetBodyHeightPx({ ...geo, detent });
      expect(bodyBottom(detent, h)).toBeCloseTo(sheetFloorPx(61, 663, 780), 0);
    }
  });

  it("already reaches the fold at `half` — no blank strip under the list", () => {
    // The defect (Niko's phone): the sheet sat at `full` while its body was
    // sized for `half`, so the revealed 40% of the surface painted blank.
    const halfHeight = sheetBodyHeightPx({ ...geo, detent: "half" });
    const fullHeight = sheetBodyHeightPx({ ...geo, detent: "full" });
    expect(fullHeight - halfHeight).toBeCloseTo(0.4 * geo.surfaceHeight, -1);
    expect(halfHeight).toBeGreaterThan(0);
  });

  it("follows the finger while dragging — a revealed strip is never blank", () => {
    // Pulling the sheet up by 200px must grow the body by 200px, so the list
    // fills the newly revealed area instead of leaving it empty.
    const settled = sheetBodyHeightPx({ ...geo, detent: "half" });
    const pulledUp = sheetBodyHeightPx({ ...geo, detent: "half", dragPx: -200 });
    expect(pulledUp - settled).toBe(200);
    expect(bodyBottom("half", pulledUp, -200)).toBeCloseTo(sheetFloorPx(61, 663, 780), 0);

    // Dragging down shrinks it (clamped at zero, never negative).
    const pushedDown = sheetBodyHeightPx({ ...geo, detent: "half", dragPx: 400 });
    expect(pushedDown).toBe(Math.max(0, settled - 400));
  });

  it("never returns a negative height at `peek`", () => {
    expect(sheetBodyHeightPx({ ...geo, detent: "peek" })).toBe(0);
  });

  it("clamps to the viewport when the surface is taller than the screen", () => {
    const h = sheetBodyHeightPx({ ...geo, surfaceHeight: 900, sheetHeight: 810, detent: "full" });
    expect(geo.surfaceTop + 900 - 810 + 116 + h).toBe(780);
  });
});
