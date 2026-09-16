import type { Stage, TripSummary, Visibility } from "./types";
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
 * stage/month/place/origin/visibility facets that sit above the bands. All pure, all tested.
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
  /**
   * Free text. Matches the title, the subtitle AND the trip's map anchor place
   * — one box, because "where" is part of what you are looking for and a second
   * input for it was just another thing on screen.
   */
  q: string;
  /** Stages to keep. Empty means every stage. */
  stages: readonly Stage[];
  /** Months (0 = January) of `startDate` to keep. Empty means every month. */
  months?: readonly number[];
  /** Provenance to keep: "mine" (a crew role) vs others' trips. Empty means all. */
  origins?: readonly TripOrigin[];
  /** Visibility to keep. Empty means both. */
  visibility?: readonly Visibility[];
}

/** Where a filterable trip comes from: the viewer's own crew role, a followed
 *  person's write, or the discoverable shelf. */
export type TripOrigin = "mine" | "following" | "discover";

/** Seasons are northern-hemisphere meteorological by convention (trips are
 *  global, so a season has to mean something fixed): spring = Mar–May. */
export type Season = "spring" | "summer" | "autumn" | "winter";

export const SEASON_MONTHS: Record<Season, readonly number[]> = {
  spring: [2, 3, 4],
  summer: [5, 6, 7],
  autumn: [8, 9, 10],
  winter: [11, 0, 1],
};

/** `startDate` → 0-based month, or null when the trip has no usable date. */
export function monthOfTrip(startDate: string | null | undefined): number | null {
  if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(startDate)) return null;
  const month = Number(startDate.slice(5, 7));
  return month >= 1 && month <= 12 ? month - 1 : null;
}

/**
 * The minimum a band item carries for filtering. Both `TripSummary` and
 * `ShowcaseTrip` qualify; callers annotate band items with `origin` (whose
 * trip it is) and `anchorName` (the E2 anchor) before filtering.
 */
export interface FilterableTrip {
  dtId: string;
  title: string;
  subtitle?: string | null;
  stage: Stage;
  startDate?: string | null;
  visibility?: Visibility;
  origin?: TripOrigin;
  anchorName?: string | null;
}

/**
 * Client-side filter for the trip bands. Order-preserving: sort first, then
 * filter — the comparator answers "why is this first?", the filter only
 * removes. Facets beyond `q`/`stages` read optional item fields; an item that
 * does not carry a field an active facet needs cannot prove it matches, so it
 * is excluded (the feed keeps its own text-only rule in `LandingPage`).
 */
export function filterTrips<T extends FilterableTrip>(
  trips: readonly T[],
  filter: TripFilter,
): T[] {
  const q = filter.q.trim().toLowerCase();
  const months = filter.months ?? [];
  const origins = filter.origins ?? [];
  const visibility = filter.visibility ?? [];
  return trips.filter((t) => {
    if (filter.stages.length > 0 && !filter.stages.includes(t.stage as Stage)) return false;
    if (months.length > 0) {
      const m = monthOfTrip(t.startDate);
      if (m === null || !months.includes(m)) return false;
    }
    if (origins.length > 0 && (t.origin === undefined || !origins.includes(t.origin))) return false;
    if (visibility.length > 0 && (t.visibility === undefined || !visibility.includes(t.visibility)))
      return false;
    if (!q) return true;
    // One box searches the words AND the place: "Japan" should find the trip
    // whose anchor is New Chitose, without a second input for it.
    const hay = `${t.title} ${t.subtitle ?? ""} ${t.anchorName ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
}

/**
 * The seasons present in a list, in calendar order — the season chips. Only
 * seasons that can return something are offered, so no chip is a dead click.
 */
export function presentSeasons(
  trips: readonly Pick<FilterableTrip, "startDate">[],
): Season[] {
  const months = new Set(
    trips.map((t) => monthOfTrip(t.startDate)).filter((m): m is number => m !== null),
  );
  const order: Season[] = ["spring", "summer", "autumn", "winter"];
  return order.filter((season) => SEASON_MONTHS[season].some((m) => months.has(m)));
}

/** The visibilities present in a list — the visibility chips. */
export function presentVisibilities(
  trips: readonly Pick<FilterableTrip, "visibility">[],
): Visibility[] {
  const seen = new Set(trips.map((t) => t.visibility).filter(Boolean) as Visibility[]);
  return (["public", "private"] as Visibility[]).filter((v) => seen.has(v));
}

/**
 * How many FACETS are narrowing the list — the Filters button's badge. The
 * free-text box is not a facet: you can see what you typed, so counting it
 * would only make the badge contradict the panel.
 */
export function activeFacetCount(filter: TripFilter): number {
  return (
    filter.stages.length +
    (filter.months ?? []).length +
    (filter.origins ?? []).length +
    (filter.visibility ?? []).length
  );
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
