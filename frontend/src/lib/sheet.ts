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

/**
 * Pixels where the sheet's VISIBLE region ends — the sheet's content floor.
 *
 * The sheet is always laid out at 90% of the surface and translated DOWN, so
 * at every detent but `full` its own bottom edge sits below the fold; what the
 * user actually sees ends at the surface's bottom edge (or at the viewport's,
 * when the surface runs under the browser's own chrome). Everything the body
 * height is measured against lives in THIS frame.
 */
export function sheetFloorPx(surfaceTop: number, surfaceHeight: number, viewportHeight: number): number {
  return Math.min(surfaceTop + surfaceHeight, viewportHeight);
}

/**
 * Height of the sheet's scroll body, in px: from the body's top to the sheet's
 * visible floor.
 *
 * The body is a scroll window onto the content, so it must END exactly where
 * the sheet's visible region ends — a body sized to the sheet's own (hidden)
 * bottom lets the last rows scroll under the fold (#109), and one sized for a
 * detent the sheet is no longer at paints the revealed part blank.
 *
 * `dragPx` is the live finger offset (negative = pulled up), so at `dragPx !==
 * 0` this returns the height for where the sheet IS, not for the detent it
 * started from: dragging the sheet up must reveal more list, never a blank
 * strip. Every parameter is a LAYOUT number (no transforms), so the result is
 * correct mid-animation too.
 *
 * All the call sites are percentages of a definite height chain (surface
 * h-full → section 90% → body), so no measurement is needed beyond these.
 */
export function sheetBodyHeightPx(params: {
  surfaceTop: number;
  surfaceHeight: number;
  sheetHeight: number;
  viewportHeight: number;
  detent: Detent;
  /** Live drag offset in px; 0 when settled. */
  dragPx?: number;
  /** The body's `offsetTop` inside the sheet (its top under the drag chrome). */
  bodyOffsetTop: number;
}): number {
  const { surfaceTop, surfaceHeight, sheetHeight, viewportHeight, detent, bodyOffsetTop } = params;
  const dragPx = params.dragPx ?? 0;
  const bodyTop =
    surfaceTop +
    surfaceHeight -
    sheetHeight +
    (detentOffsetPct(detent) / 100) * sheetHeight +
    dragPx +
    bodyOffsetTop;
  // Ceil, not round: the body must always reach the floor. A rounded-down
  // half-pixel shows ~1.5 device px of map above the content on a 3x phone —
  // "a few pixels of padding" (#109).
  return Math.max(0, Math.ceil(sheetFloorPx(surfaceTop, surfaceHeight, viewportHeight) - bodyTop));
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
