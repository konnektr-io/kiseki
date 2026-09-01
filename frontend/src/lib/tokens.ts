/**
 * Reading design tokens from JavaScript.
 *
 * Canvas renderers (the Google Maps JS API today, MapLibre in #18) take colours
 * as plain strings — they cannot use a CSS class. Rather than let a hex literal
 * back into a component, they read the token off the DOM, which keeps the
 * single source of truth in `index.css` and makes the value per-trip for free.
 *
 * The `--map-*` properties are declared on every element (see `index.css`), so
 * they resolve against the nearest `--trip-*` value — pass an element inside
 * the trip's themed subtree, not `document.documentElement`.
 */

export interface MapColors {
  /** Route body — the trip's signature colour on the map. */
  route: string;
  /** Wide casing drawn *under* the route so it survives similar-coloured roads. */
  routeCasing: string;
  /** Marker pin fill. */
  marker: string;
  /** Marker ordinal / foreground on top of the fill. */
  markerFg: string;
}

function readVar(el: Element, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Resolve the map palette for the trip `el` sits inside.
 *
 * The fallbacks are only reached if the stylesheet hasn't loaded (jsdom, a
 * detached node) — `currentColor` degrades to something visible rather than
 * drawing an invisible route.
 */
export function mapColors(el: Element): MapColors {
  return {
    route: readVar(el, "--map-route", "currentColor"),
    routeCasing: readVar(el, "--map-route-casing", "currentColor"),
    marker: readVar(el, "--map-marker", "currentColor"),
    markerFg: readVar(el, "--map-marker-fg", "currentColor"),
  };
}
