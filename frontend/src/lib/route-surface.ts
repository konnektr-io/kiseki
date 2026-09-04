/**
 * Derivations behind the trip route surface (#39).
 *
 * The route surface answers three questions the rest of the app only answers
 * implicitly: which places make up the journey, what state each LEG between
 * them is in, and which days happen at a given place. All of it is derived —
 * `trip.locations` stays the single source for places and marker numbers
 * (kiseki-map-ux), and nothing here is per-trip hardcoded.
 */

import { findLocation, locatedPlaces } from "./maps";
import { expandSectionDays } from "./sections";
import type { Block, Stage, Trip, TripLocation } from "./types";

/**
 * A leg's own state, which is what the map draws (DESIGN.md §5.3): dashed and
 * dim for a plan that isn't real yet, solid for one that is.
 */
export type LegStage = "provisional" | "planned" | "booked";

const PROVISIONAL: Stage[] = ["idea", "options", "shortlist"];

/**
 * The trip's stage as a leg state — the fallback when a leg has no transport
 * block of its own to speak for it.
 *
 * Trip stage alone is a bad *sole* source (it would style every leg
 * identically, the reason per-marker stage is parked on #40), but it is an
 * honest DEFAULT: on an `idea` trip a leg nobody has booked anything for
 * genuinely is provisional. A block's own status always wins — see `legStage`.
 */
export function stageToLegStage(stage: Stage): LegStage {
  if (PROVISIONAL.includes(stage)) return "provisional";
  return stage === "planned" ? "planned" : "booked";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every trip location named in a free-text field (a block title, `route`,
 * `via`, a day title).
 *
 * Needed because the content model does not require `from`/`to` on a transport
 * block — plenty of real drives carry only `to` and a title like
 * "Drive Banff → Revelstoke". Matching is word-bounded, and a hit nested
 * inside a longer hit is dropped: "Sapporo Kokusai" is its own location and
 * must not also resolve to New Chitose via its "Sapporo" alias.
 */
export function locationsInText(trip: Trip, text: string | undefined): TripLocation[] {
  if (!text) return [];
  const hits: { loc: TripLocation; start: number; len: number }[] = [];
  for (const loc of trip.locations ?? []) {
    for (const term of [loc.name, ...(loc.alias ?? [])]) {
      if (!term.trim()) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(term)})(?=$|[^\\p{L}\\p{N}])`, "giu");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const start = m.index + m[1].length;
        hits.push({ loc, start, len: term.length });
        // Resume at the end of the term, not the end of the match, so
        // "A → B" finds B even when the separator was consumed as a boundary.
        re.lastIndex = start + term.length;
      }
    }
  }
  const kept = hits.filter(
    (h) =>
      !hits.some(
        (o) => o !== h && o.start <= h.start && o.start + o.len >= h.start + h.len && o.len > h.len,
      ),
  );
  kept.sort((a, b) => a.start - b.start);
  const out: TripLocation[] = [];
  for (const h of kept) if (!out.includes(h.loc)) out.push(h.loc);
  return out;
}

/**
 * Every place a block touches — explicit fields first, then anything named in
 * its prose. Order is not meaningful; use `blockEndpoints` when direction
 * matters.
 */
export function blockPlaces(trip: Trip, b: Block): TripLocation[] {
  const out: TripLocation[] = [];
  const push = (l: TripLocation | undefined) => {
    if (l && !out.includes(l)) out.push(l);
  };
  push(b.from ? findLocation(trip, b.from) : undefined);
  push(b.location ? findLocation(trip, b.location) : undefined);
  push(b.to ? findLocation(trip, b.to) : undefined);
  locationsInText(trip, [b.title, b.route, b.via].filter(Boolean).join(" · ")).forEach(push);
  return out;
}

/** Day blocks and section-level (unscheduled) blocks — the whole pool. */
function allBlocks(trip: Trip): Block[] {
  return [
    ...trip.days.flatMap((d) => d.blocks),
    ...(trip.sections ?? []).flatMap((s) => s.blocks ?? []),
  ];
}

/**
 * A transport block's two ends, in order.
 *
 * `from` is frequently absent in real content — a drive is authored as
 * `to: "Revelstoke"` with the title carrying the rest — so the title's own
 * place order fills the gaps.
 */
export function blockEndpoints(
  trip: Trip,
  b: Block,
): { from?: TripLocation; to?: TripLocation } {
  const named = locationsInText(trip, [b.title, b.route, b.via].filter(Boolean).join(" · "));
  const from = (b.from ? findLocation(trip, b.from) : undefined) ?? named[0];
  const explicitTo = b.to ? findLocation(trip, b.to) : undefined;
  const to = explicitTo ?? (named.length > 1 ? named[named.length - 1] : undefined);
  return { from, to: to && to !== from ? to : undefined };
}

/**
 * The transport block that describes the leg between two places, if any.
 *
 * Matched on ENDPOINTS, not on "names both places". A drive titled
 * "Drive Banff → Revelstoke — over the pass" mentions Rogers Pass too, and a
 * touches-both match hands the same card to the Revelstoke → Rogers Pass leg
 * as well: two rows, same text, and a leg claiming a status it was never
 * given. Direction-insensitive, because a leg is drawn once.
 */
export function legBlock(trip: Trip, from: TripLocation, to: TripLocation): Block | undefined {
  if (from === to) return undefined;
  return allBlocks(trip).find((b) => {
    if (b.kind !== "transport") return false;
    const e = blockEndpoints(trip, b);
    if (!e.from || !e.to) return false;
    return (e.from === from && e.to === to) || (e.from === to && e.to === from);
  });
}

/**
 * A leg's state: the transport block's own `status` when it has one, otherwise
 * the trip's stage (see `stageToLegStage`).
 */
export function legStage(
  trip: Trip,
  from: TripLocation,
  to: TripLocation,
): { stage: LegStage; block?: Block } {
  const block = legBlock(trip, from, to);
  if (block?.status === "booked" || block?.status === "done") return { stage: "booked", block };
  if (block?.status === "planned") return { stage: "planned", block };
  return { stage: stageToLegStage(trip.stage), block };
}

/**
 * The (0-based) day indices that happen at a place.
 *
 * Three signals, unioned: a day's blocks pointing at it, a day title naming
 * it, and any section that lists it in `locationRefs` (which covers the
 * multi-night stays where no individual block repeats the place name).
 */
export function daysAtLocation(trip: Trip, name: string): number[] {
  const target = findLocation(trip, name);
  if (!target) return [];
  const days = new Set<number>();
  trip.days.forEach((day, i) => {
    if (day.blocks.some((b) => blockPlaces(trip, b).includes(target))) days.add(i);
    else if (locationsInText(trip, day.title).includes(target)) days.add(i);
  });
  (trip.sections ?? []).forEach((s) => {
    const refs = (s.locationRefs ?? []).map((r) => findLocation(trip, r));
    if (!refs.includes(target)) return;
    expandSectionDays(s.days).forEach((i) => {
      if (i >= 0 && i < trip.days.length) days.add(i);
    });
  });
  return [...days].sort((a, b) => a - b);
}

/**
 * Does the trip come back to where it started?
 *
 * This decides whether the route gets a closing leg. Asking the data beats
 * hardcoding `loop`, which the overview's route card does: on a trip that
 * flies home from its last stop the closing leg is a line nobody travels, and
 * on the flagship map surface a fictional leg is worse than a missing one.
 *
 * The test is deliberately blunt — the first place is visited both near the
 * start and near the end — because that is exactly what "returns to start"
 * means and it needs no new fields.
 */
export function returnsToStart(trip: Trip): boolean {
  const stops = locatedPlaces(trip);
  const n = trip.days.length;
  if (stops.length < 3 || n < 4) return false;
  const visits = daysAtLocation(trip, stops[0].name);
  return visits.some((i) => i <= 1) && visits.some((i) => i >= n - 2);
}

export interface JourneyLeg {
  from: TripLocation;
  to: TripLocation;
  stage: LegStage;
  /** The transport block this leg's state came from, when there is one. */
  block?: Block;
}

export interface Journey {
  /** Every located place, in marker order — the trip's index (§8.3). */
  stops: TripLocation[];
  /** The same places in the order the trip visits them (see `journeyOrder`). */
  chain: TripLocation[];
  /** Consecutive pairs along `chain`, plus the closing leg on a loop. */
  legs: JourneyLeg[];
  loop: boolean;
}

/**
 * The order the trip actually visits its places: earliest attributed day
 * first, registry position as the tie-break.
 *
 * `trip.locations` is the ① ② ③ registry and is usually the journey order
 * too, but not reliably — a place added to the registry later lands at the
 * end regardless of when it is visited (canada-2027's Rogers Pass is an
 * excursion between two mid-trip stops and sits last). Chaining the registry
 * blind then draws two legs nobody travels. The itinerary knows better, so
 * the itinerary decides; places with no day attributed to them keep registry
 * order at the tail, where an unplaced idea belongs.
 *
 * Marker NUMBERS are untouched by this — they stay the registry index,
 * because they are the through-line to the drive cards and the booklet.
 */
export function journeyOrder(trip: Trip): TripLocation[] {
  const stops = locatedPlaces(trip);
  return stops
    .map((loc, index) => ({ loc, index, first: daysAtLocation(trip, loc.name)[0] }))
    .sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || a.index - b.index)
    .map((s) => s.loc);
}

/**
 * The whole journey: every located place plus the legs between them.
 *
 * `stops` is registry order (marker numbers); `chain` and `legs` are journey
 * order, which is what the map draws and what the list mirrors — so the list
 * reads down the route even where the marker numbers do not (§8.3: the number
 * is the index, the line is the journey).
 */
export function tripJourney(trip: Trip): Journey {
  const stops = locatedPlaces(trip);
  const chain = journeyOrder(trip);
  const loop = returnsToStart(trip);
  const pairs: [TripLocation, TripLocation][] = [];
  for (let i = 0; i + 1 < chain.length; i++) pairs.push([chain[i], chain[i + 1]]);
  if (loop && chain.length > 2) pairs.push([chain[chain.length - 1], chain[0]]);
  return {
    stops,
    chain,
    loop,
    legs: pairs.map(([from, to]) => ({ from, to, ...legStage(trip, from, to) })),
  };
}

/**
 * A day-index list as a label: "Day 4", "Days 3\u201310", "Days 1\u20133, 13, 15".
 *
 * NOT `sectionRange` from `lib/sections`: that one expands a two-element list
 * as an inclusive [first, last] RANGE, which is the section storage
 * convention. Here the list is literal \u2014 a place visited on days 1 and 15 is
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
  const parts = runs.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}\u2013${b + 1}`));
  const single = runs.length === 1 && runs[0][0] === runs[0][1];
  return `${single ? "Day" : "Days"} ${parts.join(", ")}`;
}

export const LEG_STAGE_LABELS: Record<LegStage, string> = {
  provisional: "Provisional",
  planned: "Planned",
  booked: "Booked",
};

/**
 * Great-circle points between two coordinates.
 *
 * Used for the fallback geometry when the backend has no route to give (maps
 * unconfigured, or a flight/ferry leg with no road). A straight screen-space
 * line between distant places is cartographically wrong — Santiago to Lima is
 * a curve on a Mercator projection, and drawing it flat reads as a mistake.
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
