/**
 * Rendering helpers for the route surface (#39, #457).
 *
 * The DERIVATION moved to the server: which places the trip visits, in which
 * order, which leg connects each pair and what state each leg is in now comes
 * from `trip.journey` (see `lib/journey.ts` and `backend/app/journey.py`). What
 * is left here is presentation only:
 *
 * - `dayRangeLabel` — a day list as prose ("Days 1–3, 13, 15");
 * - `LEG_STAGE_LABELS` / `LEG_GAP_MODE` — the leg vocabulary the map and the
 *   route endpoint speak;
 * - `markerPaintRank` — the stacking order of pins and chips (#388);
 * - `greatCircle` / `resolveLegCoordinates` — the geometry of a non-road leg.
 *
 * Nothing here decides what the trip IS, so nothing here needs a golden test
 * against the old TypeScript: the rules are pinned server-side, in
 * `backend/tests/test_journey.py` and its captured fixtures.
 */

import type { Journey, JourneyLeg, JourneyVisit, LegStage, PlaceRailHandle, PlaceRole } from "./types";

export type { Journey, JourneyLeg, JourneyVisit, LegStage, PlaceRailHandle, PlaceRole };

/**
 * A day-index list as a label: "Day 4", "Days 3–10", "Days 1–3, 13, 15".
 *
 * NOT `sectionRange` from `lib/sections`: that one expands a two-element list
 * as an inclusive [first, last] RANGE, which is the section storage
 * convention. Here the list is literal — a place visited on days 1 and 15 is
 * not a place visited for fifteen days.
 */
export function dayRangeLabel(days: number[]): string | null {
  if (!days.length) return null;
  const sorted = [...days].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else if (!last || d !== last[1]) runs.push([d, d]);
  }
  const parts = runs.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`));
  const single = runs.length === 1 && runs[0][0] === runs[0][1];
  return `${single ? "Day" : "Days"} ${parts.join(", ")}`;
}

export const LEG_STAGE_LABELS: Record<LegStage, string> = {
  provisional: "Provisional",
  planned: "Planned",
  booked: "Booked",
};

/**
 * The `modes` value that marks a leg as a chain GAP (#433).
 *
 * A transport mode describes travel the author COMMITTED to; a gap has none, and
 * an empty CSV slot cannot say so (an unclassified block sends an empty slot too,
 * and that leg must stay a road). The backend answers a gap `road: false` without
 * asking HERE at all, and the client draws the great-circle arc, dashed and dim.
 */
export const LEG_GAP_MODE = "gap";

/**
 * Paint order for a level's markers (#388 — venue diamonds buried the stop pins
 * they stand on).
 *
 * MapLibre appends every marker element to the same canvas container and all of
 * them are `position: absolute` with `z-index: auto`, so the DOM order the
 * component built IS the stacking order and the LATER element wins a tap at a
 * shared spot. Ranked lowest first:
 *
 * - `0` — an excursion diamond: secondary by design (§7.6), never allowed to
 *   cover the trip's own structure;
 * - `1` — a numbered stop pin: the ① ② ③ index is the map's spine;
 * - `2` — a day's activity chip: it opens a block, so it keeps the top spot.
 *
 * Equal ranks keep their input order (`sort` is stable).
 */
export function markerPaintRank(
  marker: { role: "place" | "activity"; place: { name: string } },
  isExcursion: (place: { name: string }) => boolean,
): number {
  if (marker.role === "activity") return 2;
  return isExcursion(marker.place) ? 0 : 1;
}

/**
 * Great-circle points between two coordinates.
 *
 * Used for the fallback geometry when the backend has no route to give (maps
 * unconfigured, or a flight/ferry leg with no road). A straight screen-space
 * line between distant places is cartographically wrong — Santiago to Lima is a
 * curve on a Mercator projection, and drawing it flat reads as a mistake.
 */
export function greatCircle(
  a: [number, number],
  b: [number, number],
  steps = 48,
): [number, number][] {
  const rad = Math.PI / 180;
  const [lng1, lat1] = [a[0] * rad, a[1] * rad];
  const [lng2, lat2] = [b[0] * rad, b[1] * rad];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2,
      ),
    );
  if (!d || !Number.isFinite(d)) return [a, b];
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
    const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    out.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.sqrt(x * x + y * y)) / rad]);
  }
  return out;
}

/**
 * Drawable coordinates for a fetched route leg — the ONE shared helper both map
 * surfaces use (#357 slice 3A, the §8.4 promise).
 *
 * A `road: true` leg draws the backend's geometry (real roads). A `road: false`
 * leg (flight/ferry) draws the great-circle arc between its endpoints — never the
 * straight screen-space line the backend ships. The `road` flag is authoritative;
 * geometry never decides.
 */
export function resolveLegCoordinates(leg: {
  road: boolean;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}): [number, number][] {
  const coords = leg.geometry.coordinates;
  if (leg.road || coords.length < 2) return coords;
  return greatCircle(coords[0], coords[coords.length - 1]);
}
