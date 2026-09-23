/**
 * The landing globe (#372 slice 1; the only globe left as of 2026-09-23).
 *
 * ONE surface renders on the globe: the signed-in landing map
 * (`components/HomeMap`), which is where Niko asked for it (2026-09-23).
 * Everything inside a trip — the overview feature map, the itinerary scan
 * level, the day level, every card minimap — is Mercator, because a globe
 * projection costs the surface its DEM (see below). The whole print path too
 * (SwiftShader + globe shaders is a new failure mode the booklet must never
 * see).
 *
 * Terrain is the reason no trip surface gets the globe: under a globe
 * projection the DEM stops earning its place (`lib/terrain.ts` yields the 3D
 * mesh while `isGlobeProjection` is true), so a heliski week loses the relief
 * the terrain work (#38) exists to show. Trip surfaces are where elevation IS
 * the subject; the landing map is where the world is.
 *
 * Colours are tokens, never hex: the sky reads `--map-sky`/`--map-horizon`
 * off the map container (see `index.css`), the same path `lib/tokens.ts`
 * uses for the route. There is deliberately no per-trip projection knob —
 * globe is a property of the overview SURFACE, not of a trip.
 *
 * Camera note: `fitBounds` framing and the `unfoldLngs` shortest-arc logic
 * (`lib/home-geo.ts`) were re-verified against the globe rather than assumed
 * (see `globe.test.ts`): a regional chain spans well under a hemisphere, so
 * the flat-measured fit still frames, and the padding clamp still leaves a
 * usable viewport at phone and desktop widths.
 */

import { readTokenVar } from "./tokens";

/**
 * The sliver of the MapLibre map the globe helpers need — structural, so
 * tests use fakes. Params are `unknown` the way `TintableMap` in
 * `lib/maps.ts` does it: the real map's narrower parameter types stay
 * assignable, and so do the fakes.
 */
export interface GlobeCapableMap {
  setProjection(projection: unknown): unknown;
  setSky(sky: unknown): unknown;
  getProjection?(): { type?: unknown } | undefined;
}

export const GLOBE_PROJECTION_TYPE = "globe";

/**
 * The globe's sky, off the token layer.
 *
 * Fallbacks only fire when the stylesheet hasn't loaded (jsdom, a detached
 * node) — `currentColor` degrades to something visible rather than drawing
 * nothing. Callers swallow a rejected `setSky` the same way `addTerrain`
 * swallows a missing DEM: atmosphere, never content.
 */
export function globeSky(el: Element): { sky: string; horizon: string } {
  return {
    sky: readTokenVar(el, "--map-sky", "currentColor"),
    horizon: readTokenVar(el, "--map-horizon", "currentColor"),
  };
}

/** The style-spec sky object for the overview globe — token colours only. */
export function globeSkySpec(el: Element): Record<string, unknown> {
  const { sky, horizon } = globeSky(el);
  return {
    "sky-color": sky,
    "horizon-color": horizon,
    "sky-horizon-blend": 0.5,
    "horizon-fog-blend": 0.5,
  };
}

/**
 * Whether a surface renders on the globe.
 *
 * Exactly one caller passes `globe`: the signed-in landing map
 * (`HomeMap`, a constant — that surface is globe by construction, never per
 * trip). The booklet PDF and the compact card minimaps always stay Mercator
 * even if it leaks through.
 */
export function shouldUseGlobe({
  globe,
  isPdfRender,
  compact,
}: {
  globe?: boolean;
  isPdfRender: boolean;
  compact?: boolean;
}): boolean {
  return globe === true && !isPdfRender && !compact;
}

/**
 * Put the globe projection on a loaded map. Never throws: the globe is
 * atmosphere, so a map that rejects it keeps its Mercator route rather than
 * a broken surface.
 */
export function applyOverviewGlobe(map: GlobeCapableMap, el: Element): void {
  try {
    map.setProjection({ type: GLOBE_PROJECTION_TYPE });
    map.setSky(globeSkySpec(el));
  } catch {
    /* Mercator with the route beats no map at all */
  }
}

/**
 * Whether the map currently holds the globe projection — the terrain seam
 * (`lib/terrain.ts`): the 3D mesh yields while this is true and re-arms for
 * Mercator. Unknown/throwing maps read as Mercator (attach as before).
 */
export function isGlobeProjection(map: GlobeCapableMap): boolean {
  try {
    return map.getProjection?.()?.type === GLOBE_PROJECTION_TYPE;
  } catch {
    return false;
  }
}
