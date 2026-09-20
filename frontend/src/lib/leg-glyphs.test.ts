import { describe, expect, it } from "vitest";
import {
  classifiedGlyphMode,
  GLYPH_MIN_LEG_KM,
  LEG_GLYPH_ICON_SIZE,
  LEG_GLYPH_NODES,
  legGlyphImageId,
  legGlyphMode,
  legGlyphPoints,
  legGlyphSvg,
  validGlyphMode,
} from "./leg-glyphs";
import { classifyTransportMode } from "./transport";
import type { Block } from "./types";

describe("legGlyphMode (#357 slice 3B: data decides, road is authoritative)", () => {
  it("draws the declared mode on a matching leg", () => {
    expect(legGlyphMode({ road: false, mode: "flight" })).toBe("flight");
    expect(legGlyphMode({ road: true, mode: "drive" })).toBe("drive");
    expect(legGlyphMode({ road: true, mode: "train" })).toBe("train");
    expect(legGlyphMode({ road: false, mode: "ferry" })).toBe("ferry");
  });

  it("never dresses a road route as a flight or ferry", () => {
    expect(legGlyphMode({ road: true, mode: "flight" })).toBeNull();
    expect(legGlyphMode({ road: true, mode: "ferry" })).toBeNull();
  });

  it("draws nothing with no declared mode", () => {
    expect(legGlyphMode({ road: true, mode: undefined })).toBeNull();
    expect(legGlyphMode({ road: false, mode: null })).toBeNull();
  });

  it("geometry never decides the glyph — only the mode value", () => {
    // Same call shape a far-flung road leg and a flight leg produce: the
    // road flag + mode say everything, coordinates say nothing.
    expect(legGlyphMode({ road: true, mode: "drive" })).toBe("drive");
    expect(legGlyphMode({ road: false, mode: "drive" })).toBe("drive");
  });
});

describe("validGlyphMode", () => {
  it("narrows the echoed server string to the four modes", () => {
    expect(validGlyphMode("flight")).toBe("flight");
    expect(validGlyphMode("car")).toBeUndefined();
    expect(validGlyphMode(null)).toBeUndefined();
    expect(validGlyphMode(undefined)).toBeUndefined();
  });
});

describe("classifiedGlyphMode", () => {
  it("is Block.mode first, then the shared evidence classifier", () => {
    const drive = { kind: "transport", mode: "drive" } as Block;
    expect(classifiedGlyphMode(drive)).toBe("drive");
    expect(classifiedGlyphMode(undefined)).toBeUndefined;
    // Same classifier BlockGlyph uses — one ruling, both surfaces.
    const booking = { kind: "transport", bookingCode: "ABC123" } as Block;
    expect(classifiedGlyphMode(booking)).toBe(classifyTransportMode(booking));
  });
});

describe("legGlyphPoints (#357 slice 3B: two per leg, short legs skipped)", () => {
  // ~111km per degree of latitude: a 2° line is well above the floor.
  const long: [number, number][] = [
    [0, 0],
    [0, 1],
    [0, 2],
  ];

  it("places two glyphs at one-quarter and three-quarters along", () => {
    const pts = legGlyphPoints(long);
    expect(pts).toHaveLength(2);
    expect(pts[0][1]).toBeCloseTo(0.5, 5);
    expect(pts[1][1]).toBeCloseTo(1.5, 5);
  });

  it("skips short legs entirely", () => {
    // ~5.5km — under the floor.
    expect(
      legGlyphPoints([
        [0, 0],
        [0, 0.05],
      ]),
    ).toEqual([]);
    expect(GLYPH_MIN_LEG_KM).toBe(15);
  });

  it("draws nothing for degenerate geometry", () => {
    expect(legGlyphPoints([])).toEqual([]);
    expect(legGlyphPoints([[1, 2]])).toEqual([]);
  });

  it("follows the drawn arc, not the chord", () => {
    const arc: [number, number][] = [
      [-70.6, -33.4],
      [-71.5, -23],
      [-72.0, -13.5],
    ];
    const [q1, q3] = legGlyphPoints(arc);
    // Quarter points sit between the endpoints' longitudes, on the curve.
    expect(q1[0]).toBeGreaterThan(-72.0);
    expect(q1[0]).toBeLessThan(-70.6);
    expect(q3[0]).toBeGreaterThan(-72.0);
    expect(q3[0]).toBeLessThan(-70.6);
    expect(q1[1]).toBeLessThan(q3[1]);
  });
});

describe("glyph sprites", () => {
  it("covers exactly the four BlockGlyph transport modes", () => {
    expect(Object.keys(LEG_GLYPH_NODES).sort()).toEqual(["drive", "ferry", "flight", "train"]);
    expect(legGlyphImageId("flight")).toBe("leg-glyph-flight");
  });

  it("builds a chipped SVG from token colours, no literal", () => {
    const svg = legGlyphSvg("flight", "TOKEN_ROUTE", "TOKEN_CASING");
    expect(svg).toContain('stroke="TOKEN_ROUTE"');
    expect(svg).toContain('fill="TOKEN_CASING"');
    expect(svg).toContain('width="28"');
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("reads small on the map", () => {
    expect(LEG_GLYPH_ICON_SIZE).toBeLessThan(1);
  });
});
