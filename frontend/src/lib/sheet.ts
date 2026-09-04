/**
 * Bottom-sheet geometry (DESIGN.md §7.3) — the numbers, split out from the
 * component so they can be unit-tested and so the map can compute its camera
 * padding without importing React.
 */

export type Detent = "peek" | "half" | "full";

export const DETENTS: Detent[] = ["peek", "half", "full"];

/**
 * Fraction of the surface height each detent occupies.
 *
 * `peek` is the "what am I looking at" line — one row of text plus the drag
 * handle. `half` is the list. `full` stops at 90% so the map is always still
 * visible behind it: the sheet is the content, not a modal, and it never
 * fully covers the thing it describes.
 */
export const DETENT_FRACTION: Record<Detent, number> = {
  peek: 0.15,
  half: 0.5,
  full: 0.9,
};

/** The tallest detent — the sheet element's own height. */
export const SHEET_FRACTION = DETENT_FRACTION.full;

/**
 * How far the sheet is pushed down, as a percentage of its OWN height.
 *
 * The sheet is always laid out at its full height and translated down to
 * expose only the current detent; that keeps every transition on `transform`
 * (§10 — never animate `height`) and needs no measurement in JS.
 */
export function detentOffsetPct(detent: Detent): number {
  return ((SHEET_FRACTION - DETENT_FRACTION[detent]) / SHEET_FRACTION) * 100;
}

/** The detent whose exposed fraction is closest to `fraction`. */
export function nearestDetent(fraction: number): Detent {
  return DETENTS.reduce((best, d) =>
    Math.abs(DETENT_FRACTION[d] - fraction) < Math.abs(DETENT_FRACTION[best] - fraction) ? d : best,
  );
}

/** One detent up (`peek` → `half` → `full`); clamped at the top. */
export function nextDetent(detent: Detent): Detent {
  return DETENTS[Math.min(DETENTS.indexOf(detent) + 1, DETENTS.length - 1)];
}

/** One detent down; clamped at `peek` — the sheet never dismisses (§7.3). */
export function prevDetent(detent: Detent): Detent {
  return DETENTS[Math.max(DETENTS.indexOf(detent) - 1, 0)];
}

/**
 * Pixels of the surface the sheet covers at a detent — the map's
 * `padding.bottom`.
 *
 * Forgetting this is the #1 bug in map+sheet layouts: `fitBounds` centres on
 * the whole viewport and half the route ends up hidden under the sheet, which
 * reads as "the map is broken".
 */
export function detentOcclusionPx(detent: Detent, surfaceHeight: number): number {
  return Math.round(DETENT_FRACTION[detent] * surfaceHeight);
}
