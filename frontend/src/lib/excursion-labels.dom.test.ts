// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as maps from "./maps";
import {
  EXCURSION_DIAMOND_MIN_ZOOM,
  EXCURSION_LABEL_DIAMOND_OFFSET_PX,
  MAP_LABEL_PIN_OFFSET_PX,
  makeMapExcursionLabelElement,
  orderExcursionLabels,
} from "./maps";

/**
 * Excursion (diamond) labels (#388 follow-up; revised #413, #415).
 *
 * Niko's reports, in order:
 *  - 2026-10-03: the diamonds navigate correctly but say nothing about what they
 *    ARE, so the scan reads as numbered pins and anonymous lozenges. Label them,
 *    quietly, under the numbered spine.
 *  - 2026-10-04: "only some labels seem to shown ... It seems completely random."
 *    Cause was a hard four-name cap plus a 92px drop-filter.
 *  - 2026-10-04, after #413/#414 shipped: **"now the labels are all over the
 *    place ... Now they're in the sea"**, and then the design question settled it:
 *    the NUMBERED labels are "just fine", so why place excursion labels
 *    differently? **"I don't need the collision avoidance."**
 *
 * So #415 withdraws the placement machinery entirely. #413 nudged colliding names
 * down a ladder; #414 scaled that ladder with the 92px spacing and added a
 * widening loop; the net effect could displace a name up to 64 x 92px ≈ 5888px —
 * seven viewports — to dodge another name. A label that far from its diamond is
 * not a label for that place.
 *
 * The rule now is the one that was already working: **an excursion label is placed
 * exactly like a numbered stop label** — anchored to its own marker at a fixed
 * offset, with no measurement and no collision handling. If two overlap, they
 * overlap. That is what the numbered labels have always done and Niko says it is
 * "just fine".
 */
describe("excursion diamond labels (#388 follow-up, revised #413 and #415)", () => {
  const venues = ["Rockford Bar", "The Village Idiot", "Abe's Cafe", "Minyuk Coffee", "Selkirk Cafe"];

  describe("orderExcursionLabels", () => {
    it("offers every visible diamond as a candidate — no arbitrary cap", () => {
      // The #398 defect: five venues, four names, and which four won was decided
      // by `trip.locations` order.
      expect(orderExcursionLabels(venues, null)).toHaveLength(venues.length);
    });

    it("pulls the tapped diamond to the front", () => {
      expect(orderExcursionLabels(venues, "Minyuk Coffee")[0]).toBe("Minyuk Coffee");
    });

    it("ignores a selection that is not one of its diamonds", () => {
      // A selected chain stop must not conjure a diamond label out of thin air.
      expect(orderExcursionLabels(venues, "Calgary")).toEqual(venues);
    });
  });

  describe("placement — identical to the numbered labels, by construction (#415)", () => {
    it("has NO collision-avoidance machinery left in lib/maps.ts", () => {
      // The strongest form of this test: assert the code that caused the bug is
      // GONE, not merely unused. A helper that still exists can be re-wired, and
      // a measurement-based placement that a well-meaning edit re-enables is
      // exactly how the labels ended up in the sea.
      // (Enforced at the source level in route-surface.test.ts, which reads the
      // component's text; here we assert the exported surface has no such API.)
      const api = maps as unknown as Record<string, unknown>;
      for (const gone of [
        "placeExcursionLabels",
        "farEnoughApart",
        "LabelPlacement",
        "EXCURSION_LABEL_ROWS_PX",
        "EXCURSION_LABEL_SLOT_OFFSETS_PX",
        "EXCURSION_LABEL_MAX_OFFSET_PX",
      ]) {
        expect(api[gone]).toBeUndefined();
      }
    });

    it("anchors below its own diamond at a fixed offset", () => {
      // Same shape as `MAP_LABEL_PIN_OFFSET_PX` for the numbered pins: one
      // constant, one anchor, no geometry.
      expect(typeof EXCURSION_LABEL_DIAMOND_OFFSET_PX).toBe("number");
      expect(EXCURSION_LABEL_DIAMOND_OFFSET_PX).toBeGreaterThan(0);
      expect(EXCURSION_LABEL_DIAMOND_OFFSET_PX).toBeLessThan(MAP_LABEL_PIN_OFFSET_PX + 40);
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

  describe("the pill", () => {
    it("reads as a diamond, never as a second numbered place", () => {
      const el = makeMapExcursionLabelElement("Rockford Bar");
      expect(el.classList.contains("map-place-label")).toBe(true);
      expect(el.classList.contains("is-excursion")).toBe(true);
      expect(el.classList.contains("is-chip")).toBe(false);
      expect(el.getAttribute("aria-hidden")).toBe("true");
    });

    it("carries no collision state class", () => {
      // `is-nudged`/`is-offset` only existed to style a displaced label. With no
      // displacement there is nothing to mark.
      const el = makeMapExcursionLabelElement("Rockford Bar");
      expect(el.classList.contains("is-nudged")).toBe(false);
      expect(el.classList.contains("is-offset")).toBe(false);
    });
  });
});