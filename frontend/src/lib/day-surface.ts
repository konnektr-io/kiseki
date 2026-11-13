/**
 * Helpers for the DAY level of the trip map surface (#90).
 *
 * The day's world — which places the day touches, which legs it draws, which
 * chips it stamps — is derived server-side and arrives as `day.surface`
 * (see `lib/journey.ts` and `backend/app/journey.py`, #457). What stays here is
 * what a renderer and a card need, and nothing that decides the trip's shape:
 *
 * - `activityLetter` — A, B, C… for the chips (past Z: "A2");
 * - `matchTitlePlace` — the contains-match a card uses to resolve its registry
 *   place from its title (the same matcher the server's day surface uses, but
 *   for a CARD's own anchor rather than the day's topology).
 */

import type { DayLeg, DayMarker, DaySurface, DayTrack, Trip, TripLocation } from "./types";

export type { DayLeg, DayMarker, DaySurface, DayTrack };

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The n-th (1-based) activity letter. Past Z the cycle repeats with an index
 * suffix ("A2") — a day with 27+ mapped stops is hypothetical, but the chips must
 * stay unique rather than silently collide.
 */
export function activityLetter(n: number): string {
  if (n < 1) return "A";
  const i = n - 1;
  const cycle = Math.floor(i / 26);
  return LETTERS[i % 26] + (cycle > 0 ? String(cycle + 1) : "");
}

/**
 * The title pass of a card's anchor match (#104): a place the block's title names
 * via a CONTAINS match over the registry — exact name first, then aliases (#104
 * prod: "Sunshine full day" never matched "Sunshine Village" until its alias
 * "Sunshine" existed; a title can name a place through its alias). Longest name
 * wins so "Lake Louise" beats "Louise" when both could match. Returns undefined
 * when nothing matches — it never invents a place.
 */
export function matchTitlePlace(trip: Trip, title: string | undefined): TripLocation | undefined {
  if (!title) return undefined;
  const t = title.toLowerCase();
  return (trip.locations ?? [])
    .filter((l) => {
      return (
        t.includes(l.name.toLowerCase()) ||
        (l.alias ?? []).some((a) => a.length >= 3 && t.includes(a.toLowerCase()))
      );
    })
    .sort((x, y) => y.name.length - x.name.length)[0];
}
