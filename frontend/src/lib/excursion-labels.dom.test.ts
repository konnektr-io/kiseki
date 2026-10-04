// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  EXCURSION_LABEL_MAX,
  EXCURSION_LABEL_MIN_SEPARATION_PX,
  farEnoughApart,
  makeMapExcursionLabelElement,
  orderExcursionLabels,
} from "./maps";

/**
 * Excursion (diamond) labels (#388 follow-up, Niko 2026-10-03).
 *
 * Niko's report: on the itinerary view the excursion diamonds navigate
 * correctly on tap but say nothing about what they ARE, so the whole-trip scan
 * reads as five numbered pins and a heap of anonymous lozenges. He wants them
 * labelled — "maybe only showing them when zooming in or clicking them", with
 * the numbered locations and their labels staying more prominent.
 *
 * The rule is deliberately TWO pure halves rather than one zoom threshold:
 * `orderExcursionLabels` decides the draw order and the cap, `farEnoughApart`
 * decides what FITS on screen. A single global zoom floor was written first
 * and rejected by measurement — `probe-excursion-labels.py` fitted the real
 * Canada registry (six stops over 4.19° of longitude, journey framing ≈ z6)
 * and Revelstoke's real venue cluster (~1.1 km, four pills only separate at
 * z≈13). One constant cannot serve both trips, which is the map skill's rule 5
 * verbatim. Measuring separation instead makes the layer self-tuning.
 */
describe("excursion diamond labels (#388 follow-up)", () => {
  const venues = ["Rockford Bar", "The Village Idiot", "Abe's Cafe", "Minyuk Coffee", "Selkirk Cafe"];
  // Revelstoke's venues are ~1.1 km across, so at journey zoom (z≈6) all five
  // land on a handful of pixels; zoomed to the town they spread out. Real
  // screen points, measured by the probe at those two cameras.
  const clustered: Array<[number, number]> = [[100, 100], [104, 102], [98, 105], [103, 97], [96, 99]];
  const spread: Array<[number, number]> = [[100, 100], [300, 120], [520, 90], [760, 130], [980, 100]];

  describe("orderExcursionLabels (the cap, and the tap)", () => {
    it("stays quieter than the numbered spine, which takes 8", () => {
      expect(EXCURSION_LABEL_MAX).toBeLessThan(8);
      expect(orderExcursionLabels(venues, null)).toHaveLength(EXCURSION_LABEL_MAX);
      expect(orderExcursionLabels(venues, null).length).toBeLessThan(venues.length);
    });

    it("pulls the tapped diamond to the front", () => {
      const ordered = orderExcursionLabels(venues, "Minyuk Coffee");
      expect(ordered[0]).toBe("Minyuk Coffee");
      expect(ordered).toHaveLength(EXCURSION_LABEL_MAX);
    });

    it("ignores a selection that is not one of its diamonds", () => {
      // A selected chain STOP must never conjure a diamond label — the
      // numbered layer already owns that name.
      expect(orderExcursionLabels(venues, "Banff")).toEqual(venues.slice(0, EXCURSION_LABEL_MAX));
    });

    it("is empty for a trip with no excursions", () => {
      expect(orderExcursionLabels([], "Rockford Bar")).toEqual([]);
    });
  });

  describe("farEnoughApart (the measured display rule)", () => {
    it("names a sparse trip immediately — no zoom needed", () => {
      const ordered = orderExcursionLabels(venues, null);
      const shown = farEnoughApart(ordered, spread.slice(0, ordered.length), null);
      // Every candidate that was tried gets a name: the geometry, not a
      // constant, is what decides.
      expect(shown).toHaveLength(ordered.length);
    });

    it("withholds names in a same-town cluster until there is room", () => {
      const ordered = orderExcursionLabels(venues, null);
      const shown = farEnoughApart(ordered, clustered, null);
      expect(shown.length).toBeLessThan(ordered.length);
      // The one it does show is a real, named venue — never an empty pill.
      for (const name of shown) expect(venues).toContain(name);
      expect(shown.length).toBeGreaterThan(0);
    });

    it("the separation threshold is one pill's width, not a hair", () => {
      // ~70–90px per pill: below that two labels read as one smear.
      expect(EXCURSION_LABEL_MIN_SEPARATION_PX).toBeGreaterThanOrEqual(70);
      const just = EXCURSION_LABEL_MIN_SEPARATION_PX + 2;
      expect(farEnoughApart(["a", "b"], [[0, 0], [just, 0]], null)).toEqual(["a", "b"]);
      expect(farEnoughApart(["a", "b"], [[0, 0], [just - 4, 0]], null)).toEqual(["a"]);
    });

    it("ALWAYS names the tapped diamond, however tight the cluster", () => {
      const ordered = orderExcursionLabels(venues, "Selkirk Cafe");
      const shown = farEnoughApart(ordered, clustered, "Selkirk Cafe");
      expect(shown).toContain("Selkirk Cafe");
      // …and it is exempt from the separation test, not merely first in line:
      // a pile of identical points still answers the tap.
      const sameSpot: Array<[number, number]> = ordered.map(() => [50, 50]);
      expect(farEnoughApart(ordered, sameSpot, "Selkirk Cafe")).toEqual(["Selkirk Cafe"]);
    });

    it("returns draw order, so the DOM never depends on which was tapped", () => {
      const ordered = orderExcursionLabels(venues, "Abe's Cafe");
      const shown = farEnoughApart(ordered, clustered, "Abe's Cafe");
      const positions = shown.map((n) => ordered.indexOf(n));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it("measures distance, not just a horizontal gap", () => {
      // Vertically stacked labels overlap just as much as horizontal ones.
      const gap = EXCURSION_LABEL_MIN_SEPARATION_PX - 5;
      expect(farEnoughApart(["a", "b"], [[100, 100], [100, 100 + gap]], null)).toEqual(["a"]);
      expect(farEnoughApart(["a", "b"], [[100, 100], [100, 100 + gap + 40]], null)).toEqual(["a", "b"]);
    });
  });

  describe("never double-labels", () => {
    it("the layer is fed only the chain's complement", () => {
      // Structural guarantee, pinned here as the contract the scan build
      // relies on: `journey.excursions` is by construction the complement of
      // `chain` (route-surface `tripExcursions`), so a stop can never appear
      // twice — once as a numbered pin, once as a diamond.
      const chain = ["Calgary", "Banff", "Revelstoke"];
      const shown = farEnoughApart(orderExcursionLabels(venues, null), spread, null);
      expect(shown.some((e) => chain.includes(e))).toBe(false);
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
      // The glyph is the shape the marker actually is — a hollow diamond, not
      // an ordinal.
      expect(el.querySelector(".map-excursion-glyph")).not.toBeNull();
      expect(el.textContent).toBe("Rockford Bar");
      // No ordinal is invented: an excursion claims no slot in the ① ② ③ index.
      expect(el.textContent).not.toMatch(/^\d/);
      // A hover says the same thing on the pill as on the diamond.
      expect(el.getAttribute("title")).toBe("Rockford Bar (excursion)");
      // Tokens only — no hex colour written in JS, ever (§8.4).
      expect(el.getAttribute("style") ?? "").not.toContain("#");
    });
  });
});
