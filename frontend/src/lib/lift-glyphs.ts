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

const KIND_NODES: Record<LiftGlyphKind, string[]> = {
  // Enclosed cabin: a box hung from a short arm.
  gondola: [
    '<path d="M4.5 2.5h15"/>',
    '<path d="M12 2.5v3.5"/>',
    '<rect x="6.5" y="6" width="11" height="9" rx="2.5"/>',
  ],
  // Open chair: a seat and a back, on an arm.
  "chair_lift": [
    '<path d="M4.5 2.5h15"/>',
    '<path d="M12 2.5v4"/>',
    '<path d="M7.5 6.5h9"/>',
    '<path d="M7.5 6.5v5"/>',
    '<path d="M7.5 11.5h9"/>',
  ],
  // Tow line with a hanging puck.
  "t-bar": [
    '<path d="M4.5 2.5h15"/>',
    '<path d="M12 2.5v6"/>',
    '<circle cx="12" cy="11.5" r="2.5"/>',
  ],
  // Funicular: a box on a slope.
  funicular: [
    '<path d="M4.5 2.5h15"/>',
    '<path d="M8 16.5l4-8 4 8"/>',
    '<path d="M9.5 10.5h5"/>',
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
    `<g fill="none" stroke="${stroke}" stroke-width="1.9" ` +
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