/**
 * Derivations behind the trip route surface (#39).
 *
 * The route surface answers three questions the rest of the app only answers
 * implicitly: which places make up the journey, what state each LEG between
 * them is in, and which days happen at a given place. All of it is derived —
 * `trip.locations` stays the single source for places and marker numbers
 * (kiseki-map-ux), and nothing here is per-trip hardcoded.
 *
 * Derivation honesty (#91) governs everything below: the surface reports
 * places and days that are DERIVED, not authored, so a derivation must never
 * invent content. Three rules keep it honest:
 *
 * 1. A place is a journey STOP iff the trip re-bases there (section ref,
 *    transport endpoint, flight gateway). A place merely visited on days
 *    based elsewhere is an EXCURSION — secondary marker, never in the chain,
 *    never given legs (Rogers Pass is toured from Revelstoke, not stayed at).
 * 2. `via`/`route` prose describes the ROAD, not a visit — it never
 *    attributes a day to a place ("into Banff NP" is a park boundary).
 * 3. A leg with no transport block of its own is a chain GAP — it draws
 *    provisional, never inheriting the trip's committed stage.
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
 * The trip's stage as a leg state — the fallback when a leg HAS a transport
 * block but the block carries no status of its own.
 *
 * Trip stage alone is a bad *sole* source (it would style every leg
 * identically, the reason per-marker stage is parked on #40), but it is an
 * honest default FOR A SPEAKING BLOCK: a drive is not something you book, so
 * on a booked trip an unstatused drive card is still a booked trip's road.
 * A leg with NO block at all never reaches this fallback — see `legStage`.
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
 * Every place a block touches — explicit fields first, then the places its
 * TITLE names. Order is not meaningful; use `blockEndpoints` when direction
 * matters.
 *
 * PROSE SCOPE (#91): only the title names places here. `via`/`route` describe
 * the ROAD — "into Banff NP", "over Rogers Pass" are road facts, not visits —
 * so they are deliberately NOT scanned: a day whose only tie to a place is a
 * `via` mention does not belong to it. `blockEndpoints` still reads those
 * fields to fill a transport's missing endpoints (leg matching needs it), but
 * day attribution must not inherit that leniency.
 */
export function blockPlaces(trip: Trip, b: Block): TripLocation[] {
  const out: TripLocation[] = [];
  const push = (l: TripLocation | undefined) => {
    if (l && !out.includes(l)) out.push(l);
  };
  push(b.from ? findLocation(trip, b.from) : undefined);
  push(b.location ? findLocation(trip, b.location) : undefined);
  push(b.to ? findLocation(trip, b.to) : undefined);
  locationsInText(trip, b.title).forEach(push);
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
 * place order fills the gaps. `route`/`via` join the title here: they may
 * name an endpoint the title abbreviates. (This leniency is for LEG MATCHING
 * only — `blockPlaces`, the day-attribution path, is title-only.)
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
 * A leg's state: the transport block's own `status` when it has one, the trip
 * stage when a block speaks but carries no status, and — when NO block
 * describes the leg — provisional, full stop.
 *
 * The gap case is the #91 fix: a leg the derivation joins but nobody authored
 * (a chain artifact) must not inherit the trip's committed stage. On a booked
 * trip that drew Rogers Pass detours as SOLID BOOKED legs nobody travels.
 * Dashed and dim says "no plan here" honestly.
 */
export function legStage(
  trip: Trip,
  from: TripLocation,
  to: TripLocation,
): { stage: LegStage; block?: Block } {
  const block = legBlock(trip, from, to);
  if (block?.status === "booked" || block?.status === "done") return { stage: "booked", block };
  if (block?.status === "planned") return { stage: "planned", block };
  if (block) return { stage: stageToLegStage(trip.stage), block };
  return { stage: "provisional", block: undefined };
}

/**
 * Days a place is LOCATED on, from explicit content only: a day's blocks
 * naming it (`from`/`to`/`location` fields, or the block title) or the day
 * title naming it.
 *
 * Free-text matching stays deliberately narrow (#91): `via`/`route` are road
 * facts and never attribute a day — see `blockPlaces`.
 */
export function daysLocated(trip: Trip, name: string): number[] {
  const target = findLocation(trip, name);
  if (!target) return [];
  const days = new Set<number>();
  trip.days.forEach((day, i) => {
    if (day.blocks.some((b) => blockPlaces(trip, b).includes(target))) days.add(i);
    else if (locationsInText(trip, day.title).includes(target)) days.add(i);
  });
  return [...days].sort((a, b) => a - b);
}

/**
 * The days the trip happens AT a place — `daysLocated` plus any section that
 * lists it in `locationRefs`, CLAMPED so a chapter cannot outlive its place.
 *
 * The section range is what covers multi-night stays no individual block
 * repeats (empty heli days at Revelstoke, buffer days at Cusco). But a
 * chapter can claim days the place never had: canada-2027's old "Lake Louise
 * days 12–15" owned the "Arrive home" day, where nobody is within 7000 km of
 * the lake. So a ref's day is granted only when BOTH hold:
 *
 * - the day carries no located content for a DIFFERENT place (a transfer day
 *   already belongs to both its endpoints; a ski day at the neighbouring
 *   hill belongs to the hill), and
 * - when the place has located days of its own, the day falls within them —
 *   [first, last] located is the place's own calendar span, and a range that
 *   trails past `last` is the chapter outliving the stay.
 *
 * A place with no located days at all trusts its ref over the full range —
 * the ref is then the only evidence, and there is nothing to contradict it.
 */
export function placeDays(trip: Trip, name: string): number[] {
  const target = findLocation(trip, name);
  if (!target) return [];
  const days = new Set(daysLocated(trip, name));
  const located = [...days];
  const first = located.length ? Math.min(...located) : null;
  const last = located.length ? Math.max(...located) : null;
  (trip.sections ?? []).forEach((s) => {
    const refs = (s.locationRefs ?? []).map((r) => findLocation(trip, r));
    if (!refs.includes(target)) return;
    expandSectionDays(s.days).forEach((i) => {
      if (i < 0 || i >= trip.days.length) return;
      const elsewhere = trip.days[i].blocks.some((b) =>
        blockPlaces(trip, b).some((l) => l !== target),
      );
      if (elsewhere) return;
      if (first != null && last != null && (i < first || i > last)) return;
      days.add(i);
    });
  });
  return [...days].sort((a, b) => a - b);
}

/**
 * WHY the trip is at a place — a journey stop it re-bases at, or an excursion
 * it visits from a base elsewhere (#91; DESIGN.md §7.6: "Excursions from a
 * base render as secondary markers, never chain stops").
 *
 * A place is a stop iff the trip re-bases there: it is a section
 * `locationRefs` base, or an endpoint of a transport block, or the
 * arrival/departure gateway a flight names. A place that is only ever an
 * activity/POI `location` on days based elsewhere is an excursion — Rogers
 * Pass is a same-day touring option from Revelstoke, not a re-base, and must
 * never be spliced into the chain between two stops.
 *
 * Prose is deliberately NOT a signal: matching `via` text would re-base a
 * place on the strength of a road description ("over Rogers Pass"). A lodging
 * base relies on its section `locationRefs` (the #89 content convention) — a
 * bare `location` on a lodging block is not evidence enough on its own.
 */
export type PlaceRole = "stop" | "excursion";

export function placeRole(trip: Trip, name: string): PlaceRole {
  const target = findLocation(trip, name);
  if (!target) return "excursion";

  // A section base — "Revelstoke", "Valle Nevado & the Andes" — is a stay.
  for (const s of trip.sections ?? []) {
    if ((s.locationRefs ?? []).some((r) => findLocation(trip, r) === target)) return "stop";
  }

  // An endpoint of a transport block: something travels to/from it. Only the
  // explicit `from`/`to` fields count — a `via`-only name between two explicit
  // endpoints is the road, not the destination.
  for (const b of allBlocks(trip)) {
    if (b.kind !== "transport") continue;
    const explicit = [b.from, b.to].filter((n): n is string => Boolean(n)).map((n) => findLocation(trip, n));
    if (explicit.includes(target)) return "stop";
  }

  // The arrival/departure gateway — where the flights land and leave. Flights
  // often carry no endpoint fields (pre-#89 content), so their titles speak.
  for (const f of allBlocks(trip)) {
    if (f.kind !== "transport" || f.mode !== "flight") continue;
    if (locationsInText(trip, f.title).includes(target)) return "stop";
  }

  return "excursion";
}

/**
 * The registry scaffold (#91): when NO place has any re-base evidence, the
 * registry is the author's whole statement of intent — a scaffold trip with
 * curated places and no transports/chapters yet. Chain the registry in
 * marker order instead of exiling every place to "excursion" (which would
 * blank the route line for exactly the trips still being sketched).
 */
export function isRegistryScaffold(trip: Trip): boolean {
  return locatedPlaces(trip).every((l) => placeRole(trip, l.name) === "excursion");
}

/**
 * Does the trip come back to where it started?
 *
 * This decides whether the route gets a closing leg. Asking the data beats
 * hardcoding `loop`, which the overview's route card does: on a trip that
 * flies home from its last stop the closing leg is a line nobody travels, and
 * on the flagship map surface a fictional leg is worse than a missing one.
 *
 * The test is deliberately blunt — the first CHAIN stop is visited both near
 * the start and near the end — because that is exactly what "returns to
 * start" means and it needs no new fields. Chain, not registry: the trip
 * starts where its journey starts, and excursions are not stops (#91).
 */
export function returnsToStart(trip: Trip): boolean {
  const chain = journeyOrder(trip);
  const n = trip.days.length;
  if (chain.length < 3 || n < 4) return false;
  const visits = placeDays(trip, chain[0].name);
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
  /** The re-base stops in the order the trip visits them (see `journeyOrder`). */
  chain: TripLocation[];
  /** Consecutive pairs along `chain`, plus the closing leg on a loop. */
  legs: JourneyLeg[];
  loop: boolean;
  /**
   * Excursions — located places the trip visits without re-basing there
   * (Rogers Pass from Revelstoke, a toured pass between two drives). Never in
   * `chain`, never given legs; the surface renders them as secondary markers.
   */
  excursions: TripLocation[];
}

/**
 * The order the trip actually visits its re-base stops: earliest attributed
 * day first, registry position as the tie-break.
 *
 * `trip.locations` is the ① ② ③ registry and is usually the journey order
 * too, but not reliably — a place added to the registry later lands at the
 * end regardless of when it is visited. Chaining the registry blind then
 * draws legs nobody travels. The itinerary knows better, so the itinerary
 * decides; places with no day attributed to them keep registry order at the
 * tail (first = Infinity), where an unplaced idea belongs.
 *
 * Marker NUMBERS are untouched by this — they stay the registry index,
 * because they are the through-line to the drive cards and the booklet.
 *
 * EXCURSIONS (#91): a place that is never a re-base is excluded entirely. It
 * does not sit between two chain stops, so no leg to or from it exists and no
 * phantom through-route can be drawn through it — exclusion is structural,
 * not a styling choice.
 */
export function journeyOrder(trip: Trip): TripLocation[] {
  const stops = isRegistryScaffold(trip)
    ? locatedPlaces(trip)
    : locatedPlaces(trip).filter((l) => placeRole(trip, l.name) === "stop");
  return stops
    .map((loc, index) => ({ loc, index, first: placeDays(trip, loc.name)[0] }))
    .sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || a.index - b.index)
    .map((s) => s.loc);
}

/** The trip's excursions in marker order — the complement of `journeyOrder`. */
export function tripExcursions(trip: Trip): TripLocation[] {
  return locatedPlaces(trip).filter((l) => placeRole(trip, l.name) === "excursion");
}

/**
 * A place's days on the route surface. #91 renamed the semantics; the old
 * name stays as an alias because `RouteMapPage`-era callers and any future
 * surface-level consumers read it. Exactly `placeDays`.
 */
export function daysAtLocation(trip: Trip, name: string): number[] {
  return placeDays(trip, name);
}
/**
 * The whole journey: every located place, the re-base chain between them, and
 * the excursions beside it.
 *
 * `stops` is registry order (marker numbers); `chain` and `legs` are journey
 * order, which is what the map draws and what the list mirrors — so the list
 * reads down the route even where the marker numbers do not (§8.3: the number
 * is the index, the line is the journey). Only chain members are paired into
 * legs, so an excursion is structurally unable to gain one.
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
    excursions: tripExcursions(trip),
    legs: pairs.map(([from, to]) => ({ from, to, ...legStage(trip, from, to) })),
  };
}

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
