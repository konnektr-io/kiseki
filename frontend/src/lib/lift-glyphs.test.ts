import { describe, expect, it } from "vitest";
import {
  LIFT_GLYPH_KINDS,
  LIFT_GLYPH_SPRITE_PX,
  liftGlyphClass,
  liftGlyphImageId,
  liftGlyphSvg,
  registerLiftGlyphs,
} from "./lift-glyphs";

/**
 * The lift-glyph contracts, pinned.
 *
 * A wrong glyph is not a crash — it is a chairlift drawn as a gondola, which is
 * exactly the fact the glyph exists to convey. So the aliasing is asserted
 * explicitly rather than left to the drawing.
 */

describe("liftGlyphClass", () => {
  it("maps every aerialway subtype the overlay draws", () => {
    expect(liftGlyphClass("chair_lift")).toBe("chair_lift");
    expect(liftGlyphClass("gondola")).toBe("gondola");
    expect(liftGlyphClass("cable_car")).toBe("gondola");
    expect(liftGlyphClass("drag_lift")).toBe("t-bar");
    expect(liftGlyphClass("t-bar")).toBe("t-bar");
    expect(liftGlyphClass("j-bar")).toBe("t-bar");
    expect(liftGlyphClass("platter")).toBe("t-bar");
    expect(liftGlyphClass("funicular")).toBe("funicular");
  });

  it("only ever returns one of the four drawn kinds", () => {
    for (const s of [
      "chair_lift", "gondola", "cable_car", "drag_lift",
      "t-bar", "j-bar", "platter", "funicular",
    ]) {
      expect(LIFT_GLYPH_KINDS).toContain(liftGlyphClass(s));
    }
  });

  it("returns null for anything that is not an aerialway", () => {
    for (const s of [undefined, null, "", "path", "footway", "downhill-easy", "goods"]) {
      expect(liftGlyphClass(s)).toBeNull();
    }
  });
});

describe("liftGlyphSvg", () => {
  it("gives every glyph the same cable and pylon, so the set reads as a family", () => {
    // The shared construction IS the recognisability: a cable, a pylon dot, a
    // hanger, then the vehicle. A glyph missing the cable does not read as a
    // lift at all — it reads as a box on a stick. This also caught a bug in the
    // screenshot tool, which silently dropped the bare `CABLE`/`PYLON`
    // identifiers and photographed a pictogram that was not the one shipping.
    const svgs = LIFT_GLYPH_KINDS.map((k) => liftGlyphSvg(k, "#111", "#fff"));
    const cables = svgs.filter((s) => s.includes("M2 6 22 2")).length;
    expect(cables, "every glyph must carry the diagonal cable").toBe(LIFT_GLYPH_KINDS.length);
    const pylons = svgs.filter((s) => s.includes('cx="12" cy="4" r="1.1"')).length;
    expect(pylons, "every glyph must carry the pylon dot").toBe(LIFT_GLYPH_KINDS.length);
  });

  it("keeps the cable on the diagonal, because these glyphs never rotate", () => {
    // `icon-rotation-alignment` is `viewport`, so a horizontal cable would point
    // at nothing. If that ever flips to `map`, the cable must turn with it.
    const svg = liftGlyphSvg("gondola", "#000", "#fff");
    expect(svg).toContain("M2 6 22 2"); // diagonal, not "M2 6 22 2" as a flat bar
    expect(svg).not.toContain("M2 2h20");
  });

  it("draws different geometry per kind — otherwise the glyph says nothing", () => {
    const svgs = LIFT_GLYPH_KINDS.map((k) => liftGlyphSvg(k, "#111", "#fff"));
    // Four kinds, four distinct drawings: the whole point of the glyph.
    expect(new Set(svgs).size).toBe(LIFT_GLYPH_KINDS.length);
  });

  it("takes its colours as arguments, never literals", () => {
    const svg = liftGlyphSvg("gondola", "#123456", "#abcdef");
    expect(svg).toContain("#123456");
    expect(svg).toContain("#abcdef");
  });

  it("is a valid svg of the declared sprite size", () => {
    const svg = liftGlyphSvg("chair_lift", "#000", "#fff");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(`width="${LIFT_GLYPH_SPRITE_PX}"`);
    expect(svg).toContain(`viewBox="0 0 ${LIFT_GLYPH_SPRITE_PX} ${LIFT_GLYPH_SPRITE_PX}"`);
  });

  it("names sprites uniquely per kind", () => {
    const ids = LIFT_GLYPH_KINDS.map(liftGlyphImageId);
    expect(new Set(ids).size).toBe(LIFT_GLYPH_KINDS.length);
  });
});

describe("registerLiftGlyphs", () => {
  it("is a no-op without a DOM Image, rather than throwing", () => {
    // The PDF/SSR path has no `Image`; annotation must not break it.
    expect(registerLiftGlyphs({ hasImage: () => false, addImage: () => {} }, { lift: "#000" })).resolves.toEqual(
      [],
    );
  });
});