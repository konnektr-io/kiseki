import type { Stage, TripSummary } from "./types";
import { sortShowcaseTrips } from "./marketing";

/**
 * The signed-in home's ordering and filtering (#249, slice 2).
 *
 * The home answers "why is this first?" with exactly one rule, in two parts:
 *
 * 1. **Bands are fixed** — Up next, Your trips, Following, Discover — and an empty
 *    band collapses to one line of copy instead of rendering an empty frame. Band
 *    order is a layout decision in `pages/LandingPage.tsx`, not a comparator.
 * 2. **Inside a trip list, one comparator** — `sortShowcaseTrips` (stage weight,
 *    then soonest start, then title). It types on `ShowcaseTrip`, and `TripSummary`
 *    carries every field it reads, so both bands share it rather than each owning
 *    a sort. The feed keeps the server's newest-write-first order verbatim (#199):
 *    re-sorting it client-side would second-guess the graph's own stamps.
 *
 * What this file owns: picking the Up-next trip, and the client-side search and
 * stage filters that sit above the bands. All pure, all tested.
 */

/** Up next: the live trip, else the soonest-starting non-archived trip with a date. */
export function nextUpTrip(trips: readonly TripSummary[]): TripSummary | null {
  const live = trips.find((t) => t.stage === "live");
  if (live) return live;
  let best: TripSummary | null = null;
  for (const t of trips) {
    if (t.stage === "archive" || !t.startDate) continue;
    if (!best || (best.startDate && t.startDate < best.startDate)) best = t;
  }
  return best;
}

/** "Happening now" / "Starts tomorrow" / "Starts in 12 days" / "Started Mar 2". */
export function upNextLabel(trip: TripSummary, todayIso: string): string {
  if (trip.stage === "live") return "Happening now";
  if (!trip.startDate) return "";
  if (trip.startDate === todayIso) return "Starts today";
  if (trip.startDate > todayIso) {
    const days = daysBetween(todayIso, trip.startDate);
    if (days === 1) return "Starts tomorrow";
    return `Starts in ${days} days`;
  }
  return `Started ${trip.startDate.slice(5).replace("-", "/")}`;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T12:00:00`).getTime();
  const b = new Date(`${bIso}T12:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export interface TripFilter {
  /** Free text over title + subtitle, case-insensitive. Blank matches all. */
  q: string;
  /** Stages to keep. Empty means every stage. */
  stages: readonly Stage[];
}

/** Client-side filter for the trip bands. Order-preserving: sort first, then filter. */
export function filterTrips<T extends Pick<TripSummary, "title" | "subtitle" | "stage">>(
  trips: readonly T[],
  filter: TripFilter,
): T[] {
  const q = filter.q.trim().toLowerCase();
  return trips.filter((t) => {
    if (filter.stages.length > 0 && !filter.stages.includes(t.stage as Stage)) return false;
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) || (t.subtitle ?? "").toLowerCase().includes(q)
    );
  });
}

/** The stages present in a list, in stage-weight order — the filter chips. */
export function presentStages(
  trips: readonly Pick<TripSummary, "stage">[],
): Stage[] {
  const order = sortShowcaseTrips(
    trips.map((t) => ({ dtId: "", title: "", subtitle: "", stage: t.stage })),
  ).map((t) => t.stage);
  return [...new Set(order)];
}
