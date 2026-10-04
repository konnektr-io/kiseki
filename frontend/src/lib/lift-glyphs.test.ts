import { describe, expect, it } from "vitest";
import {
  LIFT_GLYPH_KINDS,
  LIFT_GLYPH_SPRITE_PX,
  liftGlyphKindFor,
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

describe("liftGlyphKindFor", () => {
  it("maps every aerialway subtype the overlay draws", () => {
    expect(liftGlyphKindFor("chair_lift")).toBe("chair_lift");
    expect(liftGlyphKindFor("gondola")).toBe("gondola");
    expect(liftGlyphKindFor("cable_car")).toBe("gondola");
    expect(liftGlyphKindFor("t-bar")).toBe("t-bar");
    expect(liftGlyphKindFor("j-bar")).toBe("j-bar");
    expect(liftGlyphKindFor("platter")).toBe("platter");
    expect(liftGlyphKindFor("funicular")).toBe("funicular");
  });

  it("keeps the three surface lifts distinct — that is what the glyph is for", () => {
    // A T-bar is a crossbar, a J-bar a hooked bar, a platter a disc. Collapsing
    // them into one puck (which I did first) throws away exactly the distinction
    // the pictogram exists to carry.
    const three = [liftGlyphKindFor("t-bar"), liftGlyphKindFor("j-bar"), liftGlyphKindFor("platter")];
    expect(new Set(three).size).toBe(3);
  });

  it("borrows the platter for drag_lift, the closest drawn shape", () => {
    // A drag lift is a rope loop you push around. No seventh icon was supplied,
    // so this collapse is deliberate and recorded rather than accidental.
    expect(liftGlyphKindFor("drag_lift")).toBe("platter");
  });

  it("only ever returns one of the drawn kinds", () => {
    for (const s of [
      "chair_lift", "gondola", "cable_car", "drag_lift",
      "t-bar", "j-bar", "platter", "funicular",
    ]) {
      expect(LIFT_GLYPH_KINDS).toContain(liftGlyphKindFor(s));
    }
  });

  it("returns null for anything that is not an aerialway", () => {
    for (const s of [undefined, null, "", "path", "footway", "downhill-easy", "goods"]) {
      expect(liftGlyphKindFor(s)).toBeNull();
    }
  });
});

describe("liftGlyphSvg", () => {
  it("gives every CABLE lift the same cable and pylon, so the set reads as a family", () => {
    // The shared construction IS the recognisability: a cable, a pylon dot, a
    // hanger, then the vehicle. A glyph missing the cable does not read as a
    // lift at all — it reads as a box on a stick. This also caught a bug in the
    // screenshot tool, which silently dropped the bare `CABLE`/`PYLON`
    // identifiers and photographed a pictogram that was not the one shipping.
    //
    // The funicular is excluded on purpose: it runs on a TRACK, so it carries a
    // slope instead of the diagonal cable — that difference is the whole reason it
    // is distinguishable from a gondola cabin.
    const CABLE_LIFTS = LIFT_GLYPH_KINDS.filter((k) => k !== "funicular");
    const svgs = CABLE_LIFTS.map((k) => liftGlyphSvg(k, "#111", "#fff"));
    const cables = svgs.filter((s) => s.includes("M2 6 22 2")).length;
    expect(cables, "every cable lift must carry the diagonal cable").toBe(CABLE_LIFTS.length);
    const pylons = svgs.filter((s) => s.includes('cx="12" cy="4" r="1.1"')).length;
    expect(pylons, "every cable lift must carry the pylon dot").toBe(CABLE_LIFTS.length);
  });

  it("gives the funicular a sloped track and wheels, not a cable", () => {
    // A funicular runs on rails: the slope it climbs IS the signal, and it is
    // exactly what separates it from a gondola cabin at a glance. Asserting it
    // stops a future edit "harmonising" it back to the shared cable and quietly
    // turning it into a fourth gondola.
    const svg = liftGlyphSvg("funicular", "#000", "#fff");
    expect(svg).toContain("M2 21 22 9"); // the sloped track
    expect(svg).not.toContain("M2 6 22 2"); // NOT the cable-lift diagonal
    expect(svg).toContain('r="1.1"'); // wheels
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
    // Every kind, every drawing distinct: the whole point of the glyph.
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


describe("the ground truth Niko supplied", () => {
  // He drew six lifts and named them in order:
  //   "T-bar - chairlift - gondola - J-bar - platter - funicular"
  // I then identified each icon by reading its path data, and got THREE wrong:
  // I shipped a T-bar where the funicular belonged, and turned the actual
  // chairlift into an unused second t-bar variant while calling the J-bar a
  // chair. Inference from geometry is not identification — this table is the
  // only authority for what each glyph IS.
  //
  // It is deliberately a flat literal rather than anything derived from the
  // module, so that changing the module to disagree with this table FAILS.
  const GROUND_TRUTH: ReadonlyArray<readonly [subtype: string, kind: string]> = [
    ["t-bar", "t-bar"],
    ["chair_lift", "chair_lift"],
    ["gondola", "gondola"],
    ["j-bar", "j-bar"],
    ["platter", "platter"],
    ["funicular", "funicular"],
  ];

  it.each(GROUND_TRUTH)("%s draws the %s glyph", (subtype, kind) => {
    expect(liftGlyphKindFor(subtype)).toBe(kind);
  });

  it("has a drawn glyph for every lift in the ground truth", () => {
    // The failure mode was a supplied icon silently going UNUSED: the chairlift
    // was mapped to a t-bar variant and file 2 never reached the map at all.
    const drawn = new Set(LIFT_GLYPH_KINDS);
    for (const [, kind] of GROUND_TRUTH) expect(drawn).toContain(kind);
  });

  it("uses each supplied icon exactly once — none dropped, none doubled", () => {
    const kinds = GROUND_TRUTH.map(([, k]) => k);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});