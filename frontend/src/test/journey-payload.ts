import type { ApiDaySurface, ApiJourney, ApiJourneyLeg, ApiPlaceRailHandle } from "../lib/types";

/**
 * Test-side builders for the SERVER-DERIVED payload (#457).
 *
 * The client no longer derives the trip's shape: `trip.journey` and
 * `day.surface` arrive from `GET /api/trips/{id}` and the components render
 * them. A page test therefore has to state what the server said, exactly as a
 * real response would — these helpers only ASSEMBLE that data (no rules), so a
 * test reads as "given this journey, the page draws…".
 *
 * The rules themselves are pinned server-side: `backend/tests/test_journey.py`
 * (the named regression shapes) plus the captured goldens in
 * `backend/tests/fixtures/journey/`.
 */
export function journeyPayload(opts: {
  chain: string[];
  excursions?: string[];
  visits?: ApiJourney["visits"];
  legs?: ApiJourneyLeg[];
  loop?: boolean;
  rail?: Record<string, ApiPlaceRailHandle>;
  /** Defaults to chain + excursions in that order. */
  stops?: string[];
}): ApiJourney {
  const excursions = opts.excursions ?? [];
  return {
    stops: opts.stops ?? [...opts.chain, ...excursions],
    chain: opts.chain,
    visits: opts.visits ?? opts.chain.map((place) => ({ place, days: [] })),
    legs: opts.legs ?? [],
    loop: opts.loop ?? false,
    excursions,
    rail: opts.rail ?? {},
  };
}

/** A day surface with the given places as numbered pins and nothing else. */
export function surfaceOf(places: string[] = []): ApiDaySurface {
  return {
    markers: places.map((place) => ({ role: "place" as const, place })),
    legs: [],
    endpoints: places,
    tracks: [],
  };
}
