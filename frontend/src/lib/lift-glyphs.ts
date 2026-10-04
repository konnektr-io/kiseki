/**
 * Lift glyphs — a tiny icon per aerialway class, on the outdoor overlay.
 *
 * A lift line on its own says *something runs up that hill*. It does not say
 * whether you can take a pushchair on it, and that distinction is the whole
 * reason someone looks at a ski map in the first place. So each aerialway gets
 * a small glyph — and deliberately a *small* one: this is reference furniture
 * on a quiet basemap, not the trip's own route (DESIGN.md §8.5).
 *
 * ## Why hand-drawn rather than a sprite sheet
 *
 * The transport glyphs already in the app (`lib/leg-glyphs.ts`) register
 * data-URI SVGs through `map.addImage`, and this follows that shape exactly so
 * there is one sprite mechanism in the codebase rather than two. These are
 * **not** lucide icons: lucide has no chairlift/gondola/platter, and the
 * distinction between a platter and a button is precisely what is being drawn.
 *
 * The shapes are the conventional cartographic vocabulary (OSM
 * `aerialway=*` / MapLibre's own lift pictograms): a hanging cabin for a
 * gondola or cable car, an open two-seat frame for a chair, a tow line with a
 * small hanging puck for T-bar/platter/J-bar, and a box on a slope for a
 * funicular.
 *
 * ## Colour
 *
 * `stroke` arrives as a string from the token layer (`mapColors`) — no colour
 * literal belongs in here, same rule as every other map module.
 */

/** The aerialway classes the overlay draws, as they appear on `subtype`. */
export const LIFT_GLYPH_CLASSES = [
  "chair_lift",
  "drag_lift",
  "t-bar",
  "j-bar",
  "platter",
  "gondola",
  "cable_car",
  "funicular",
] as const;

export type LiftGlyphClass = (typeof LIFT_GLYPH_CLASSES)[number];

/**
 * `subtype` → glyph class. Aliases collapse: every kind of button lift reads as
 * a puck on a line (`t-bar`/`j-bar`/`platter`/`drag_lift`) and every enclosed
 * cabin reads as a cabin (`gondola`/`cable_car`), because at this size a
 * four-way distinction between them would be noise — and the *name* label sits
 * right beside it anyway, spelling out "Matterhorn Express".
 *
 * Returns `null` for anything that is not an aerialway.
 */
export function liftGlyphClass(subtype: string | undefined | null): LiftGlyphClass | null {
  switch (subtype) {
    case "chair_lift":
      return "chair_lift";
    // Open two-seat frame.
    case "gondola":
    case "cable_car":
      return "gondola";
    // Everything you hang onto.
    case "drag_lift":
    case "t-bar":
    case "j-bar":
    case "platter":
      return "t-bar";
    // A box on rails.
    case "funicular":
      return "funicular";
    default:
      return null;
  }
}

/** The four distinct glyphs, after aliasing. */
export const LIFT_GLYPH_KINDS = ["gondola", "chair_lift", "t-bar", "funicular"] as const;
export type LiftGlyphKind = (typeof LIFT_GLYPH_KINDS)[number];

/**
 * The four pictograms.
 *
 * ⚠️ **These are Claude's, not mine.** The first set in this file was drawn by
 * hand and was, in Niko's words, "ridiculous — random strokes", which was fair:
 * the chairlift read as an abstract bracket, not a chair. Mine also shipped
 * without anyone ever looking at it, and a unit test asserting "four distinct
 * SVGs" is no defence against a glyph that does not resemble its subject.
 *
 * So: **do not hand-draw these.** If a lift class needs a glyph, ask for one, or
 * take it from a map-icon set (Mappicon, CC0 — the pictogram vocabulary basemaps
 * use for `aerialway=*`), and check that licence before shipping it. Getting a
 * pictogram right is a drawing problem, not a code problem.
 *
 * They share one construction — a cable on the diagonal, a pylon dot, a hanger,
 * then the vehicle — which is what makes the set read as a family rather than as
 * four unrelated marks. The cable sits on the diagonal deliberately: these never
 * rotate with the line (`icon-rotation-alignment: viewport`), so a horizontal
 * cable would point at nothing.
 */
const CABLE = '<path d="M2 6 22 2"/>';
const PYLON = '<circle cx="12" cy="4" r="1.1" fill="{fg}" stroke="none"/>';

const KIND_NODES: Record<LiftGlyphKind, string[]> = {
  // An enclosed cabin with a window band — a gondola or cable car.
  gondola: [
    CABLE,
    PYLON,
    '<path d="M12 4v4"/>',
    '<rect x="5.5" y="8" width="13" height="12" rx="2.5"/>',
    '<rect x="8" y="10.5" width="8" height="4" rx="1"/>',
    '<path d="M12 10.5v4"/>',
  ],
  // A seat on an arm that curves away — an open chair, not a box.
  "chair_lift": [
    CABLE,
    PYLON,
    '<path d="M12 4v2"/>',
    '<rect x="10.5" y="6" width="3" height="4" rx="1"/>',
    '<path d="M12 10v7a3 3 0 0 1-3 3H7"/>',
  ],
  // A filled disc on a stem: a button/platter. Honest for the whole
  // drag_lift / t-bar / j-bar / platter alias group it stands for.
  "t-bar": [
    CABLE,
    PYLON,
    '<path d="M12 4v2"/>',
    '<rect x="10.5" y="6" width="3" height="4" rx="1"/>',
    '<path d="M12 10v5.5"/>',
    '<circle cx="12" cy="18.5" r="2.75" fill="{fg}" stroke="none"/>',
  ],
  // A car on a flat base — a funicular runs on rails, not on a cable.
  funicular: [
    CABLE,
    PYLON,
    '<path d="M12 4v2"/>',
    '<rect x="10.5" y="6" width="3" height="4" rx="1"/>',
    '<path d="M12 10v8M7 18h10"/>',
  ],
};

/** Sprite canvas, px — the glyph draws on the lucide 24-grid. */
export const LIFT_GLYPH_SPRITE_PX = 24;

export function liftGlyphImageId(kind: LiftGlyphKind): string {
  return `lift-glyph-${kind}`;
}

/**
 * The sprite: a soft casing disc behind the icon, so a glyph stays legible on
 * snow, forest *and* a dark piste line without needing a halo colour per layer.
 */
export function liftGlyphSvg(kind: LiftGlyphKind, stroke: string, casing: string): string {
  const inner = KIND_NODES[kind].join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LIFT_GLYPH_SPRITE_PX}" ` +
    `height="${LIFT_GLYPH_SPRITE_PX}" viewBox="0 0 ${LIFT_GLYPH_SPRITE_PX} ${LIFT_GLYPH_SPRITE_PX}">` +
    `<circle cx="12" cy="12" r="11" fill="${casing}"/>` +
    `<g fill="none" stroke="${stroke}" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`
  );
}

/** The structural surface `registerLiftGlyphs` needs (MapLibre Map satisfies). */
export interface LiftGlyphImageMap {
  hasImage(id: string): boolean | undefined;
  addImage(id: string, image: HTMLImageElement): void;
}

/**
 * Register the lift sprites (browser-only — call inside effects).
 *
 * Idempotent (`hasImage` guard). A sprite that will not load is skipped, never
 * thrown — the lift line still draws, just without its glyph. Returns the kinds
 * actually registered, so a caller can tell "no glyphs at all" from "all four".
 */
export async function registerLiftGlyphs(map: LiftGlyphImageMap, colors: { lift: string }): Promise<LiftGlyphKind[]> {
  if (typeof Image === "undefined") return [];
  const done: LiftGlyphKind[] = [];
  for (const kind of LIFT_GLYPH_KINDS) {
    const id = liftGlyphImageId(kind);
    try {
      if (map.hasImage(id)) {
        done.push(kind);
        continue;
      }
      const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        liftGlyphSvg(kind, colors.lift, "#ffffff"),
      )}`;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`lift glyph failed: ${id}`));
        img.src = uri;
      });
      map.addImage(id, img);
      done.push(kind);
    } catch {
      continue;
    }
  }
  return done;
}