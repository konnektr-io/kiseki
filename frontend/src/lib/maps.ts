import type { Trip, TripLocation } from "./types";

/**
 * The basemap style (#18 decision 2).
 *
 * OpenFreeMap `positron`: keyless, so nothing has to be proxied and there is no
 * credential in the bundle to leak (#27), and desaturated, which is exactly the
 * "quiet basemap, loud trip" floor in DESIGN.md §8.5 — the trip's own colour
 * stays the only saturated thing on screen.
 *
 * It is community-funded infrastructure with no SLA. Swapping it is deliberately
 * a one-line change: point VITE_MAP_STYLE_URL at a self-hosted PMTiles style on
 * Garage (or a hosted vendor) and nothing else in the app moves. Per-trip map
 * styling is #40 and belongs here too.
 */
export const MAP_STYLE_URL =
  import.meta.env.VITE_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron";

/** One leg of a route as the backend hands it over (see `app/maps.py:route_legs`). */
export interface RouteLeg {
  from: string;
  to: string;
  /** false = no road route (a flight/ferry leg) — drawn dashed, not solid. */
  road: boolean;
  /** Live `duration_in_traffic` text, e.g. "1 hour 35 mins". */
  duration: string | null;
  distance: string | null;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

/** Resolve a place name/alias to a location entry (case-insensitive). */
export function findLocation(trip: Trip, name: string): TripLocation | undefined {
  const n = name.trim().toLowerCase();
  return (trip.locations ?? []).find(
    (l) => l.name.toLowerCase() === n || (l.alias ?? []).some((a) => a.toLowerCase() === n),
  );
}

/** All trip locations with coords, in marker order. */
export function locatedPlaces(trip: Trip): TripLocation[] {
  return (trip.locations ?? []).filter((l) => l.lat != null && l.lng != null);
}

/**
 * The trip's own marker number for a location — position in `trip.locations`
 * unless `marker` overrides it.
 *
 * This is the through-line between map, drive cards, directions pills and the
 * booklet (DESIGN.md §8.3), so it is derived from the data in exactly one way.
 * `useLocationMarkers` in `blocks.tsx` renders the same number as a glyph.
 */
export function markerNumber(trip: Trip, loc: TripLocation): number {
  return loc.marker ?? (trip.locations ?? []).indexOf(loc) + 1;
}

/**
 * Real driving route for a set of places, from the backend (#27).
 *
 * HERE Routing v8 still produces the geometry — MapLibre renders, it does not
 * route — but the call happens server-side (app/here.py, #15), so no credential
 * reaches the browser. Returns null when maps are unconfigured or the request
 * fails; callers degrade rather than blow up.
 */
export async function fetchRouteLegs(
  trip: Trip,
  places: string[],
  loop = false,
  signal?: AbortSignal,
): Promise<RouteLeg[] | null> {
  if (!trip.id) return null;
  const resolvable = places.filter((p) => findLocation(trip, p));
  if (resolvable.length < 2) return null;
  const url = `/api/maps/route/${trip.id}?places=${encodeURIComponent(resolvable.join(","))}${loop ? "&loop=1" : ""}`;
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { legs?: RouteLeg[] };
    return data.legs ?? null;
  } catch {
    return null;
  }
}

/**
 * MapLibre GL JS v6 requires WebGL2 — there is no WebGL1 fallback, and creating
 * a Map without it throws. Detect up front and render a placeholder instead
 * (DESIGN.md §8.2). In the PDF render the map runs under SwiftShader — see
 * backend/app/pdf.py.
 */
export function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

/** The map camera's keep-out box, in CSS px. */
export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Keep-out for the map's own chrome (kiseki-map-ux: "the map's usable viewport
 * is the part not covered by content — always pass padding matching the
 * occlusion"). Extra on the left for the zoom chips, and on the bottom for the
 * attribution, which wraps to two lines at phone width — so a marker never
 * lands underneath either.
 *
 * Right/bottom also clear the marker's own extent: pins are 28px in a 44px hit
 * target anchored at the coordinate, so a marker center needs >= ~24px from
 * the container edge to render whole (44/2 + rounding) — 32px right was enough
 * in theory and clipped in practice under rounded corners, so the padding is
 * padded.
 */
export const CHROME_PADDING: MapPadding = { top: 36, right: 44, bottom: 52, left: 64 };

/**
 * Shrink padding until it leaves a usable viewport.
 *
 * Content occlusion is real padding — a sheet at `full` covers 90% of the
 * surface — but padding wider than the container leaves `fitBounds` no box to
 * fit into and it silently gives up (or frames nothing). Squeeze the two
 * opposing sides proportionally instead, so the camera still leans away from
 * the content and always has `min` px to work with.
 */
export function clampPadding(
  padding: MapPadding,
  width: number,
  height: number,
  min = 96,
): MapPadding {
  const squeeze = (a: number, b: number, extent: number): [number, number] => {
    const room = extent - min;
    if (room <= 0) return [0, 0];
    const total = a + b;
    if (total <= room) return [a, b];
    const k = room / total;
    return [Math.floor(a * k), Math.floor(b * k)];
  };
  const [left, right] = squeeze(padding.left, padding.right, width);
  const [top, bottom] = squeeze(padding.top, padding.bottom, height);
  return { top, right, bottom, left };
}

/** `prefers-reduced-motion` — a JS-driven camera has to check it itself (§10). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
