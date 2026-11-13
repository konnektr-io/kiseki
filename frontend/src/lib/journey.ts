/**
 * The trip's shape, read from the SERVER (#457).
 *
 * The chain derivation — which places the trip visits, in which order, which leg
 * connects each pair (#91/#361/#433/#435/#438/#454) — used to live in
 * `lib/route-surface.ts`, 1000+ lines of business rules that only a browser could
 * run. It now lives in `backend/app/journey.py`, is served with every trip read,
 * and this module is the renderer's side of that contract: it HYDRATES the wire
 * payload into the shapes the components already speak, and derives nothing.
 *
 * Why hydrate at all instead of changing every component: keeping
 * `Journey`/`DaySurface` as the component-facing types means a renderer change
 * (a new marker, a new layer) stays a renderer change, and the payload stays
 * compact (names and ids, not four copies of every `TripLocation` and every
 * leg's whole `Block`).
 *
 * No payload means NO SHAPE: every reader degrades to an empty journey rather
 * than falling back to a seconds implementation in the client. That is the
 * point of the move — one implementation, and the browser is not it.
 */

import { findLocation } from "./maps";
import type {
  ApiDaySurface,
  ApiJourney,
  Block,
  DayMarker,
  DaySurface,
  Journey,
  JourneyLeg,
  JourneyVisit,
  PlaceRailHandle,
  PlaceRole,
  Trip,
  TripLocation,
} from "./types";

const EMPTY_JOURNEY: ApiJourney = {
  stops: [],
  chain: [],
  visits: [],
  legs: [],
  loop: false,
  excursions: [],
  rail: {},
};

export type { PlaceRailHandle, PlaceRole, Journey, JourneyLeg, JourneyVisit } from "./types";

/** The payload's journey, or an empty one when the document predates #457. */
export function apiJourney(trip: Trip): ApiJourney {
  return trip.journey ?? EMPTY_JOURNEY;
}

/**
 * Name/alias → location, first registry entry wins.
 *
 * The same rule `findLocation` applies (a name OR any alias, case-insensitive,
 * first match in registry order), indexed once so hydration is O(n) rather than
 * O(n·places) on a 60-place trip.
 */
function registryIndex(trip: Trip): Map<string, TripLocation> {
  const index = new Map<string, TripLocation>();
  for (const loc of trip.locations ?? []) {
    for (const key of [loc.name, ...(loc.alias ?? [])]) {
      const k = key.trim().toLowerCase();
      if (k && !index.has(k)) index.set(k, loc);
    }
  }
  return index;
}

function blocksById(trip: Trip): Map<string, Block> {
  const index = new Map<string, Block>();
  const add = (blocks: Block[] | undefined) => {
    for (const b of blocks ?? []) if (b.id && !index.has(b.id)) index.set(b.id, b);
  };
  for (const day of trip.days ?? []) add(day.blocks);
  for (const section of trip.sections ?? []) add(section.blocks);
  return index;
}

function hydrateLegs(
  legs: ApiJourney["legs"],
  index: Map<string, TripLocation>,
  blocks: Map<string, Block>,
): JourneyLeg[] {
  const out: JourneyLeg[] = [];
  for (const leg of legs) {
    const from = index.get(leg.from.trim().toLowerCase());
    const to = index.get(leg.to.trim().toLowerCase());
    // A leg whose endpoint is not in the registry cannot be drawn; the server
    // never emits one (it derives from the same registry), so this is a guard.
    if (!from || !to) continue;
    out.push({
      from,
      to,
      stage: leg.stage,
      mode: leg.mode,
      gap: leg.gap,
      block: leg.blockId ? blocks.get(leg.blockId) : undefined,
    });
  }
  return out;
}

/**
 * The whole journey — `trip.journey` hydrated into `TripLocation` objects.
 *
 * `stops` is registry (marker) order, `chain`/`visits`/`legs` are visit order.
 * Nothing here decides membership: an excursion cannot gain a leg because the
 * server never emitted one for it.
 */
export function tripJourney(trip: Trip): Journey {
  const api = apiJourney(trip);
  if (!api.stops.length && !api.chain.length) {
    return { stops: [], chain: [], visits: [], legs: [], loop: false, excursions: [] };
  }
  const index = registryIndex(trip);
  const blocks = blocksById(trip);
  const resolve = (name: string): TripLocation | undefined =>
    index.get(name.trim().toLowerCase()) ?? findLocation(trip, name);

  const visits: JourneyVisit[] = [];
  for (const visit of api.visits) {
    const place = resolve(visit.place);
    if (place) visits.push({ place, days: visit.days });
  }
  const chain: TripLocation[] = [];
  for (const name of api.chain) {
    const place = resolve(name);
    if (place) chain.push(place);
  }
  const stops: TripLocation[] = [];
  for (const name of api.stops) {
    const place = resolve(name);
    if (place) stops.push(place);
  }
  const excursions: TripLocation[] = [];
  for (const name of api.excursions) {
    const place = resolve(name);
    if (place) excursions.push(place);
  }
  return {
    stops,
    chain,
    visits,
    legs: hydrateLegs(api.legs, index, blocks),
    loop: api.loop,
    excursions,
  };
}

/** The visit sequence's places — what the map and the booklet draw. */
export function journeyOrder(trip: Trip): TripLocation[] {
  return tripJourney(trip).chain;
}

/**
 * The `modes` parameter for the route endpoint, straight from the payload.
 *
 * `"gap"` for a pair nobody authored (#433: the backend skips HERE and answers
 * `road: false`, the client arcs it), the classified mode otherwise, and an
 * empty slot when the block says nothing — the caller's road default.
 */
export function journeyModes(journey: Journey): (string | undefined)[] {
  return journey.legs.map((leg) => ((leg.gap ?? !leg.block) ? "gap" : (leg.mode ?? undefined)));
}

/** Is this place a re-base stop, or a place the trip visits from one? */
export function placeRole(trip: Trip, name: string): PlaceRole {
  const api = apiJourney(trip);
  const excursions = new Set(api.excursions.map((n) => n.trim().toLowerCase()));
  return excursions.has(name.trim().toLowerCase()) ? "excursion" : "stop";
}

/** Where a scan-level place selection lands in the itinerary rail (#457). */
export function placeRailHandle(trip: Trip, name: string): PlaceRailHandle | null {
  const api = apiJourney(trip);
  const rail = api.rail ?? {};
  // The payload is keyed by REGISTRY name; the caller may hold an alias.
  const direct = rail[name];
  if (direct) return direct;
  const target = findLocation(trip, name);
  if (!target) return null;
  return rail[target.name] ?? null;
}

/**
 * One day's world — `trip.days[i].surface` hydrated.
 *
 * The letter map is rebuilt from the activity markers (each carries the block
 * ids it stamps): the payload does not ship the same mapping twice.
 */
export function daySurface(trip: Trip, dayIdx: number): DaySurface | null {
  const api: ApiDaySurface | undefined = trip.days?.[dayIdx]?.surface;
  if (!api) return null;
  const index = registryIndex(trip);
  const blocks = blocksById(trip);
  const resolve = (name: string): TripLocation | undefined =>
    index.get(name.trim().toLowerCase()) ?? findLocation(trip, name);

  const markers: DayMarker[] = [];
  const letters = new Map<string, string>();
  for (const marker of api.markers) {
    const place = resolve(marker.place);
    if (!place) continue;
    if (marker.role === "place") {
      markers.push({ role: "place", place });
      continue;
    }
    markers.push({ role: "activity", place, letter: marker.letter, blockIds: marker.blockIds });
    for (const id of marker.blockIds) letters.set(id, marker.letter);
  }

  const legs = [];
  for (const leg of api.legs) {
    const from = resolve(leg.from);
    const to = resolve(leg.to);
    const block = blocks.get(leg.blockId);
    if (!from || !to || !block) continue;
    legs.push({ from, to, block, stage: leg.stage, mode: (leg.mode ?? undefined) as never });
  }

  const endpoints: TripLocation[] = [];
  for (const name of api.endpoints) {
    const place = resolve(name);
    if (place) endpoints.push(place);
  }
  return { markers, legs, endpoints, letters, tracks: api.tracks };
}
