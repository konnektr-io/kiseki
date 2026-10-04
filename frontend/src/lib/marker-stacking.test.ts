import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Read the stylesheet off disk rather than through a `?raw` import: Vite's raw
// plugin is not guaranteed in the vitest environment, and a test that silently
// reads an EMPTY string would match nothing and pass for the wrong reason — the
// exact trap the assertions below are checking for.
const indexCss = readFileSync(
  fileURLToPath(new URL("../index.css", import.meta.url)),
  "utf8",
);
import { CLUSTER_PX } from "../lib/marker-cluster";

/** The same stylesheet with every comment removed, so a selector assertion
 *  cannot be satisfied (or tripped) by prose documenting the selector. */
const rulesOnly = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The marker stacking ladder (#388 → #398).
 *
 * For years the stacking order of this surface's markers WAS the order the
 * component happened to add them in: MapLibre appends every marker element to
 * one container, all `position: absolute` with `z-index: auto`. #388 was that
 * order being wrong — venue diamonds added after the stop pins stole their taps
 * at journey zoom.
 *
 * #398 made DOM order unusable as the mechanism: cluster membership depends on
 * the CAMERA, so a badge has to be created and destroyed as the traveler zooms,
 * and "add it in the right slot" stopped being something the level build could
 * do. The ladder is now explicit in CSS. This test pins it at the level it can
 * actually be verified from — the stylesheet's own text — because a computed
 * z-index needs a browser, and a browser check that only proves the CURRENT
 * selectors match would not notice someone deleting a rule.
 */
describe("marker stacking ladder (#388 → #398)", () => {
  /** The z-index a selector group resolves to in the stylesheet. The argument
   *  is the selector's first member; a comma-list counts as a match, which is
   *  how the ladder actually groups the badge with the lone diamond. */
  const zIndexFor = (first: string): string | undefined => {
    const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`${escaped}[^}]*?\\{[^}]*?z-index:\\s*(-?\\d+)`, "s").exec(indexCss);
    return rule?.[1];
  };

  it("ranks a cluster badge below a numbered stop pin", () => {
    // The #388 report, as a rule: a venue marker must never win the tap at a
    // stop. A badge now STANDS for several venues, so getting this backwards
    // would hide the trip's own spine behind one count.
    const badge = Number(zIndexFor(".route-cluster:where(.maplibregl-marker)"));
    const stop = Number(zIndexFor(".route-pin:where(.maplibregl-marker):not(.route-pin-excursion)"));
    expect(Number.isNaN(badge) || Number.isNaN(stop)).toBe(false);
    expect(badge).toBeLessThan(stop);
  });

  it("ranks a numbered stop pin below an activity chip", () => {
    // The pre-existing ladder from `markerPaintRank`: chip 2 sits on top
    // because it opens a block and keeps the top target it always had.
    const stop = Number(zIndexFor(".route-pin:where(.maplibregl-marker):not(.route-pin-excursion)"));
    const chip = Number(zIndexFor(".route-chip:where(.maplibregl-marker)"));
    expect(Number.isNaN(stop) || Number.isNaN(chip)).toBe(false);
    expect(stop).toBeLessThan(chip);
  });

  it("matches the ranks markerPaintRank already declares", () => {
    // One ladder, two homes: `markerPaintRank` (lib/route-surface.ts) says
    // cluster/diamond 0 < stop pin 1 < chip 2. If the CSS and the pure function
    // ever disagree, the map and the tests would each be confidently wrong.
    const ranks = { badge: 0, stop: 1, chip: 2 };
    expect(Number(zIndexFor(".route-cluster:where(.maplibregl-marker)"))).toBe(ranks.badge);
    expect(Number(zIndexFor(".route-pin:where(.maplibregl-marker):not(.route-pin-excursion)"))).toBe(ranks.stop);
    expect(Number(zIndexFor(".route-chip:where(.maplibregl-marker)"))).toBe(ranks.chip);
  });

  it("gives an excursion diamond the SAME rank as a cluster badge", () => {
    // A lone diamond and the badge that replaces it occupy the same slot: both
    // are secondary to the stops, and a venue marker that outranked a stop would
    // be #388 all over again.
    const badge = Number(zIndexFor(".route-cluster:where(.maplibregl-marker)"));
    const diamond = Number(zIndexFor(".route-pin-excursion:where(.maplibregl-marker)"));
    expect(Number.isNaN(badge) || Number.isNaN(diamond)).toBe(false);
    expect(diamond).toBe(badge);
  });

  it("takes a hidden diamond out of the pointer path, not just the paint", () => {
    // A diamond inside a badge must not intercept a tap meant for the pin
    // underneath it. `visibility`/`display` do that; `opacity: 0` does not — the
    // element still swallows the click, which is the same class of bug as #388.
    expect(indexCss).toMatch(/\.route-cluster\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  it("uses COMPOUND selectors — a marker element is not a child of a marker", () => {
    // The trap this whole file exists to catch. `new Marker({ element })` puts
    // `maplibregl-marker` on the SAME node as our own button, so
    // `.maplibregl-marker .route-cluster` (descendant) matches nothing: the
    // ladder was in the stylesheet, in the built bundle, and dead — measured
    // `zIndex === "auto"` on a real badge while the CSS looked correct. Assert
    // the shape so a "tidier" descendant selector cannot come back.
    for (const sel of [".route-cluster", ".route-pin-excursion", ".route-chip"]) {
      expect(rulesOnly).toMatch(
        new RegExp(`${sel}:where\\(\\.maplibregl-marker\\)`),
      );
    }
    // Assert over RULES, not the file: this stylesheet documents the wrong
    // selector in prose, which is the one place the substring may appear.
    expect(rulesOnly).not.toMatch(/\.maplibregl-marker \.route-(cluster|pin|chip)/);
  });

  it("clusters at the marker's own 44px hit target", () => {
    // The rule and the hit target are one sentence: markers a thumb cannot
    // separate cluster. If CLUSTER_PX drifts from the 44px design floor, either
    // venues a finger can tap get merged, or the town a traveler is looking at
    // gets swallowed.
    expect(CLUSTER_PX).toBe(44);
  });
});
