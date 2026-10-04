/**
 * Lift glyphs — a tiny icon per aerialway class, on the outdoor overlay.
 *
 * A lift line on its own says *something runs up that hill*. It does not say
 * whether you can take a pushchair on it, and that distinction is the whole
 * reason someone looks at a ski map in the first place. So each aerialway gets
 * a small glyph — and deliberately a *small* one: this is reference furniture
 * on a quiet basemap, not the trip's own route (DESIGN.md §8.5).
 *
 * ## Where these shapes come from
 *
 * ⚠️ **Drawn by Niko, not by me.** I hand-drew the first set and it was, in his
 * words, "ridiculous — random strokes that look nothing like it"; the chairlift
 * read as an abstract bracket. I then had a second go at drawing them and got
 * three of six wrong, because I was inferring each icon's identity from its path
 * data instead of asking. Getting a pictogram right is a drawing problem, not a
 * code problem, and it is not one to solve by inventing.
 *
 * **Do not hand-draw these.** If a class needs a glyph, ask for one or take it
 * from a map-icon set (Mappicon, CC0 — the `aerialway=*` vocabulary basemaps
 * use), and read that licence before shipping it.
 *
 * They share one construction — a cable on the diagonal, a pylon dot, a hanger,
 * then the vehicle — which is what makes the set read as a family rather than as
 * unrelated marks. The cable sits on the diagonal deliberately: these never
 * rotate with the line (`icon-rotation-alignment: viewport`), so a horizontal
 * cable would point at nothing. The funicular is the deliberate exception: it
 * runs on a track, so its support line is the slope it climbs.
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
 * The glyphs drawn, one per distinct vehicle Niko supplied. Six, because the
 * three surface lifts really do look different on a real ski map: a T-bar is a
 * crossbar behind your legs, a J-bar a hooked bar, a platter a disc you straddle.
 * Collapsing them into one puck — which I did first — throws away exactly the
 * distinction the glyph exists to carry.
 *
 * The funicular carries a slope instead of the shared cable, so the family has
 * one intentional exception rather than none.
 */
export const LIFT_GLYPH_KINDS = [
  "gondola",
  "chair_lift",
  "t-bar",
  "j-bar",
  "platter",
  "funicular",
] as const;
export type LiftGlyphKind = (typeof LIFT_GLYPH_KINDS)[number];

/**
 * `subtype` → the glyph KIND to draw.
 *
 * Named for its return, not its input: the argument is a Maptoolkit `subtype`,
 * the result is one of `LIFT_GLYPH_KINDS`. (The two unions overlap but are not
 * equal — `drag_lift` has no glyph of its own — and the earlier name invited
 * exactly that confusion at the call site.)
 *
 * `gondola`/`cable_car` share a glyph (an enclosed cabin is an enclosed cabin),
 * and `drag_lift` borrows the platter's — a drag lift is a rope loop you push
 * around, which is not far off a disc, and no seventh icon was supplied. Both
 * collapses are recorded rather than hidden, and the lift's NAME sits beside the
 * glyph anyway ("Matterhorn Express").
 */
export function liftGlyphKindFor(subtype: string | undefined | null): LiftGlyphKind | null {
  switch (subtype) {
    case "chair_lift":
      return "chair_lift";
    case "gondola":
    case "cable_car":
      return "gondola";
    case "t-bar":
      return "t-bar";
    case "j-bar":
      return "j-bar";
    case "platter":
      return "platter";
    // A rope loop, borrowed from the platter — the closest drawn shape.
    case "drag_lift":
      return "platter";
    case "funicular":
      return "funicular";
    default:
      return null;
  }
}

/** The shared cable + pylon the five suspended lifts are built from. */
const CABLE = '<path d="M2 6 22 2"/>';
const PYLON = '<circle cx="12" cy="4" r="1.1" fill="{fg}" stroke="none"/>';

const KIND_NODES: Record<LiftGlyphKind, string[]> = {
  // An enclosed cabin with a window band.
  gondola: [
    CABLE,
    PYLON,
    '<path d="M12 4v4"/>',
    '<rect x="5.5" y="8" width="13" height="12" rx="2.5"/>',
    '<rect x="8" y="10.5" width="8" height="4" rx="1"/>',
    '<path d="M12 10.5v4"/>',
  ],
  // An open chair: grip, hanger, seat and back.
  "chair_lift": [
    CABLE,
    PYLON,
    '<path d="M12 4v4H8v8h8"/>',
    '<path d="M16 16v3h2"/>',
  ],
  // A crossbar behind the legs, on a stem.
  "t-bar": [
    CABLE,
    PYLON,
    '<path d="M12 4v2"/>',
    '<rect x="10.5" y="6" width="3" height="4" rx="1"/>',
    '<path d="M12 10v8M7 18h10"/>',
  ],
  // A seat on an arm that curves away — the hooked bar of a J-bar.
  "j-bar": [
    CABLE,
    PYLON,
    '<path d="M12 4v2"/>',
    '<rect x="10.5" y="6" width="3" height="4" rx="1"/>',
    '<path d="M12 10v7a3 3 0 0 1-3 3H7"/>',
  ],
  // A filled disc on a stem — the platter you straddle.
  platter: [
    CABLE,
    PYLON,
    '<path d="M12 4v2"/>',
    '<rect x="10.5" y="6" width="3" height="4" rx="1"/>',
    '<path d="M12 10v5.5"/>',
    '<circle cx="12" cy="18.5" r="2.75" fill="{fg}" stroke="none"/>',
  ],
  // A car on a steep track with two wheels: a funicular runs on rails, not on a
  // cable, so the slope it climbs is the signal — and that is what separates it
  // from a gondola cabin at a glance.
  funicular: [
    '<path d="M2 21 22 9"/>',
    '<path d="M6 16.6 18 9.4V6.4h-6V10H6z"/>',
    '<circle cx="8" cy="16.4" r="1.1" fill="{fg}" stroke="none"/>',
    '<circle cx="16" cy="11.6" r="1.1" fill="{fg}" stroke="none"/>',
  ],
};

/** Sprite canvas, px — the glyph draws on a 24-unit grid. */
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
 * actually registered, so a caller can tell "no glyphs at all" from "all of them".
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