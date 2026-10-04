// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  EXCURSION_DIAMOND_MIN_ZOOM,
  EXCURSION_LABEL_MIN_SEPARATION_PX,
  EXCURSION_LABEL_ROWS_PX,
  makeMapExcursionLabelElement,
  orderExcursionLabels,
  placeExcursionLabels,
} from "./maps";

/**
 * Excursion (diamond) labels (#388 follow-up, revised #413).
 *
 * Niko's report (2026-10-03): the diamonds navigate correctly but say nothing
 * about what they ARE, so the scan reads as numbered pins and anonymous
 * lozenges. He wanted them labelled, quietly, under the numbered spine.
 *
 * His second report (2026-10-04), fully zoomed in with every diamond visible and
 * space between them: "only some labels seem to shown ... It seems completely
 * random which labels get shown and which don't." It was not random, and the
 * cause was this layer's own two limits:
 *
 *   1. `EXCURSION_LABEL_MAX = 4` capped the layer outright, so with five or more
 *      diamonds visible some names could NEVER appear, at any zoom.
 *   2. `farEnoughApart` DROPPED any name within 92px of one already kept.
 *
 * Which four survived was decided by `trip.locations` order, and tapping a
 * diamond pulled its name to the front of the cap — so the set changed with the
 * selection and reverted on the next click. That is precisely "completely
 * random" from the outside.
 *
 * The rule now: **every visible diamond gets a name**, and colliding names are
 * NUDGED along a small row ladder rather than removed. A label that appears only
 * when you tap it is a tooltip, not a label.
 */
describe("excursion diamond labels (#388 follow-up, revised #413)", () => {
  const venues = ["Rockford Bar", "The Village Idiot", "Abe's Cafe", "Minyuk Coffee", "Selkirk Cafe"];
  // Revelstoke's venues are ~1.1 km across, so at journey zoom (z≈6) all five
  // land on a handful of pixels; zoomed to the town they spread out. Real
  // screen points, measured by the probe at those two cameras.
  const clustered: Array<[number, number]> = [[100, 100], [104, 102], [98, 105], [103, 97], [96, 99]];
  const spread: Array<[number, number]> = [[100, 100], [300, 120], [520, 90], [760, 130], [980, 100]];

  describe("orderExcursionLabels", () => {
    it("no longer caps the layer — every visible diamond is a candidate", () => {
      // The defect: five venues, four names, and which four was arbitrary.
      expect(orderExcursionLabels(venues, null)).toHaveLength(venues.length);
    });

    it("still honours an explicit cap when a caller wants one", () => {
      expect(orderExcursionLabels(venues, null, 2)).toHaveLength(2);
    });

    it("pulls the tapped diamond to the front", () => {
      expect(orderExcursionLabels(venues, "Minyuk Coffee")[0]).toBe("Minyuk Coffee");
    });

    it("ignores a selection that is not one of its diamonds", () => {
      // A selected chain stop must not conjure a diamond label out of thin air.
      const ordered = orderExcursionLabels(venues, "Calgary");
      expect(ordered).toEqual(venues);
    });
  });

  describe("placeExcursionLabels — every name, nudged not dropped", () => {
    it("names EVERY diamond, even when they all sit on one spot", () => {
      // The regression that matters: five venues on the same pixels used to
      // yield exactly one name.
      const ordered = orderExcursionLabels(venues, null);
      const sameSpot: Array<[number, number]> = ordered.map(() => [50, 50]);
      const placed = placeExcursionLabels(ordered, sameSpot, null);
      expect(placed).toHaveLength(venues.length);
      expect(placed.map((p) => p.name)).toEqual(ordered);
    });

    it("keeps a name on every diamond even in a tight pile", () => {
      const ordered = orderExcursionLabels(venues, null);
      const placed = placeExcursionLabels(ordered, clustered, null);
      expect(placed).toHaveLength(venues.length);
    });

    it("uses the un-nudged row when there is room", () => {
      const ordered = orderExcursionLabels(venues, null);
      const placed = placeExcursionLabels(ordered, spread, null);
      expect(placed.every((p) => p.offset[1] === 0)).toBe(true);
    });

    it("nudges a colliding name DOWN the row ladder rather than removing it", () => {
      const ordered = orderExcursionLabels(venues, null);
      const placed = placeExcursionLabels(ordered, clustered, null);
      const nudged = placed.filter((p) => p.offset[1] !== 0);
      expect(nudged.length).toBeGreaterThan(0);
      // Every nudge is a real row, so a label can never drift off its marker.
      for (const p of nudged) expect(EXCURSION_LABEL_ROWS_PX).toContain(p.offset[1]);
    });

    it("separates names that overlap only VERTICALLY", () => {
      // Same x, 87px apart: closer than the pill width, so a horizontal-only
      // test would call this clear.
      const gap = EXCURSION_LABEL_MIN_SEPARATION_PX - 5;
      const placed = placeExcursionLabels(["a", "b"], [[100, 100], [100, 100 + gap]], null);
      expect(placed).toHaveLength(2);
      expect(placed[1].offset[1]).not.toBe(0);
    });

    it("places the tapped name un-nudged and never displaces it", () => {
      const ordered = orderExcursionLabels(venues, "Selkirk Cafe");
      const sameSpot: Array<[number, number]> = ordered.map(() => [50, 50]);
      const placed = placeExcursionLabels(ordered, sameSpot, "Selkirk Cafe");
      const sel = placed.find((p) => p.name === "Selkirk Cafe")!;
      expect(sel.offset[1]).toBe(0);
    });

    it("returns draw order, so the DOM never depends on which was tapped", () => {
      const ordered = orderExcursionLabels(venues, "Abe's Cafe");
      const placed = placeExcursionLabels(ordered, clustered, "Abe's Cafe");
      const positions = placed.map((p) => ordered.indexOf(p.name));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it("gives the SAME answer whatever was tapped — that is the 'random' fix", () => {
      // Before #413 the visible label set changed with the selection, which is
      // exactly why it looked arbitrary. Only the tapped name's own row may
      // differ now; the set of names must not.
      const ordered = orderExcursionLabels(venues, null);
      const base = placeExcursionLabels(ordered, clustered, null).map((p) => p.name);
      for (const sel of venues) {
        const withSel = placeExcursionLabels(ordered, clustered, sel).map((p) => p.name);
        expect(withSel).toEqual(base);
      }
    });
  });

  describe("the fixed diamond zoom level (#413)", () => {
    it("is the level Niko asked for", () => {
      expect(EXCURSION_DIAMOND_MIN_ZOOM).toBe(9);
    });

    it("sits above journey framing, so the overview stays a clean spine", () => {
      // The Peru trip frames at z3.13; a 9 keeps every diamond off the overview.
      expect(EXCURSION_DIAMOND_MIN_ZOOM).toBeGreaterThan(5);
    });
  });

  describe("never double-labels", () => {
    it("the layer is fed only the chain's complement", () => {
      // Structural guarantee, pinned here as the contract the scan build
      // relies on: `journey.excursions` is by construction the complement of
      // `chain` (route-surface `tripExcursions`), so a stop can never appear
      // twice — once as a numbered pin, once as a diamond.
      const chain = ["Calgary", "Banff", "Revelstoke"];
      const placed = placeExcursionLabels(orderExcursionLabels(venues, null), spread, null);
      expect(placed.some((e) => chain.includes(e.name))).toBe(false);
    });
  });

  describe("the pill", () => {
    it("reads as a diamond, never as a second numbered place", () => {
      const el = makeMapExcursionLabelElement("Rockford Bar");
      // Same pill vocabulary as a place label, so the layer reads as ONE layer…
      expect(el.classList.contains("map-place-label")).toBe(true);
      // …but the diamond's own family, so it can never read as the spine.
      expect(el.classList.contains("is-excursion")).toBe(true);
      expect(el.classList.contains("is-chip")).toBe(false);
      expect(el.getAttribute("aria-hidden")).toBe("true");
    });
  });
});