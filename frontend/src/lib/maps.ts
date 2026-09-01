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

/**
 * Static map proxy URL for a set of places (server adds the key + real route).
 * A single place renders as a centered pin map (hotel/restaurant thumbnails);
 * `query` geocodes the EXACT spot (hotel, not town) for the pin.
 *
 * Addressed by `trip.id` (the twin `$dtId`), not the share token: the backend
 * resolves an id in one graph read where a token costs two, and we already
 * hold the id on the loaded trip. It also means maps work on **private** trips,
 * which have no token at all — `/api/maps/static/` with an empty segment could
 * never resolve.
 */
export function staticMapUrl(trip: Trip, places: string[], loop = false, query?: string): string | null {
  const resolvable = places.filter((p) => findLocation(trip, p));
  if (resolvable.length < 1 || !trip.id) return null;
  let url = `/api/maps/static/${trip.id}?places=${encodeURIComponent(resolvable.join(","))}${loop ? "&loop=1" : ""}`;
  if (query) url += `&q=${encodeURIComponent(query)}`;
  return url;
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
 * Google Directions still produces the geometry — MapLibre renders, it does not
 * route — but the call happens server-side, so no key reaches the browser.
 * Addressed by `trip.id` for the same reasons as `staticMapUrl`. Returns null
 * when maps are unconfigured or the request fails; callers degrade rather than
 * blow up.
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
 * a Map without it throws. Detect up front and render the static map instead
 * (DESIGN.md §8.2).
 */
export function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}
