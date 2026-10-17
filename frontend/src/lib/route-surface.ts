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
 * 1. A place is a journey STOP iff the trip STAYS there: a section
 *    `locationRefs` base, or a movement endpoint it is still at the next day
 *    (`placeRole`). A place merely visited on days based elsewhere — a day
 *    trip, a venue — is an EXCURSION: secondary marker, never in the chain,
 *    never given legs (Rogers Pass is toured from Revelstoke, not stayed at;
 *    the Cebollapampa trailhead is driven to and back from on one day).
 * 2. `via`/`route` prose describes the ROAD, not a visit — it never
 *    attributes a day to a place ("into Banff NP" is a park boundary).
 * 3. A leg with no transport block of its own is a chain GAP — it draws
 *    provisional, never inheriting the trip's committed stage, and it is
 *    never road-routed (#433): the geometry for a gap is the great-circle
 *    arc, because a road is a route nobody authored.
 */

import { findLocation, locatedPlaces } from "./maps";
import { expandSectionDays } from "./sections";
import { classifyTransportMode } from "./transport";
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
 * Gateway proximity for flight/ferry matching (#361 slice 4): a chain leg
 * A→B matches a flight/ferry block whose endpoints resolve within this many
 * kilometres of A and B. Airports sit outside the cities they serve
 * (Luchthaven Santiago ≈ 20 km from Santiago, Luchthaven Cusco ≈ 5 km from
 * Cusco), so exact-registry matching never fires for them and the leg falls
 * back to a car route with no mode — the Chile-Peru dashed-coast-line defect.
 */
export const GATEWAY_MATCH_KM = 50;

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

function withinGatewayKm(a: TripLocation, b: TripLocation): boolean {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  return haversineKm(a.lat, a.lng, b.lat, b.lng) <= GATEWAY_MATCH_KM;
}

/**
 * Do a block's resolved endpoints sit at the leg's ends, gateway-close?
 *
 * Flight/ferry ONLY — drive/train/undeclared matching stays exact-registry
 * (the #91/Rogers-Pass rule is load-bearing and is NOT reopened: road prose
 * must never claim a leg). Direction-insensitive, like the exact match.
 *
 * A block with an unresolvable endpoint (explicit `from`/`to` naming nothing
 * in the registry and no title fallback — e.g. BRU→SCL, where Brussels is not
 * a trip place) matches nothing: there is no origin to draw from, and that is
 * correct behaviour, not a second bug.
 */
export function gatewayMatch(
  from: TripLocation,
  to: TripLocation,
  eFrom: TripLocation,
  eTo: TripLocation,
): boolean {
  return (
    (withinGatewayKm(from, eFrom) && withinGatewayKm(to, eTo)) ||
    (withinGatewayKm(from, eTo) && withinGatewayKm(to, eFrom))
  );
}

/**
 * The transport block that describes the leg between two places, if any.
 *
 * Matched on ENDPOINTS, not on "names both places". A drive titled
 * "Drive Banff → Revelstoke — over the pass" mentions Rogers Pass too, and a
 * touches-both match hands the same card to the Revelstoke → Rogers Pass leg
 * as well: two rows, same text, and a leg claiming a status it was never
 * given. A leg is drawn once, so a REVERSED block still matches — but only
 * after every direction-respecting pass has missed (#433).
 *
 * Match order, strongest evidence first:
 *
 * 1. exact-registry, as authored (`block.from` IS the leg's `from`);
 * 2. flight/ferry gateway, as authored (airport endpoints within
 *    GATEWAY_MATCH_KM of the leg's ends, #361 slice 4);
 * 3. exact-registry, reversed;
 * 4. flight/ferry gateway, reversed.
 *
 * Why direction outranks the exact registry (#433): a multi-base trip that
 * returns to its start authors the outbound AND the return movement, so a
 * reversed block is the common case. The Peru repro authored the night bus
 * `Huaraz → Luchthaven Lima` for day 5 and the day-1 flight
 * `Luchthaven Lima → Luchthaven Huaraz`; the chain leg ran
 * `Luchthaven Lima → Huaraz`, the direction-insensitive exact pass grabbed
 * the bus, and the leg the traveller FLIES drew as a 282 km drive carrying
 * the night-bus card. A block whose direction contradicts the leg is weaker
 * evidence than one that agrees with it, whichever pass finds it — and the
 * gateway pass is how an airport-paired flight reaches a city leg at all.
 *
 * Exact-registry still wins over proximity WITHIN a direction (the #361
 * rule: an airport flight must not hijack a city-to-city drive leg).
 */
export function legBlock(trip: Trip, from: TripLocation, to: TripLocation): Block | undefined {
  if (from === to) return undefined;
  const transports = allBlocks(trip).filter((b) => b.kind === "transport");
  const ends = (b: Block) => blockEndpoints(trip, b);
  const isGatewayMode = (b: Block) => b.mode === "flight" || b.mode === "ferry";
  /** Leg ends on the block's own ends, gateway-close (flight/ferry only). */
  const gateway = (b: Block, sameDirection: boolean) => {
    if (!isGatewayMode(b)) return false;
    const e = ends(b);
    if (!e.from || !e.to) return false;
    return sameDirection
      ? withinGatewayKm(from, e.from) && withinGatewayKm(to, e.to)
      : withinGatewayKm(from, e.to) && withinGatewayKm(to, e.from);
  };
  const exact = (b: Block, sameDirection: boolean) => {
    const e = ends(b);
    return sameDirection ? e.from === from && e.to === to : e.from === to && e.to === from;
  };

  // Strongest first: the leg's own direction, exact registry before gateways
  // (a #361 airport flight must not hijack a city drive), then the same two
  // passes reversed (#433).
  return (
    transports.find((b) => exact(b, true)) ??
    transports.find((b) => gateway(b, true)) ??
    transports.find((b) => exact(b, false)) ??
    transports.find((b) => gateway(b, false))
  );
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
  // `skipped` commits nothing — a plan that did not happen leaves the leg to
  // the trip-stage fallback, like an unstatused block (#385).
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
 * Where a scan-level PLACE selection lands in the itinerary rail — the ONE
 * answer the sheet's "…is highlighted below" line and the scroll both read
 * (they can never disagree about what just happened).
 *
 * A chapter that names the place in `locationRefs` renders a pill for it
 * (`SectionLocations` is the list's finest handle): scrolling to that pill puts
 * the chapter in view, and the pill's refs are returned because the reference
 * may be an ALIAS — `locationRefs: ["Hillcrest"]` renders a pill labelled
 * `Hillcrest` while a tap on the map selects the registry entry `Revelstoke`,
 * and a name-only lookup then finds nothing to scroll to.
 *
 * A venue — the restaurant a day eats at, the hotel it sleeps in — is a
 * registry place NO chapter refs and, being an excursion, it carries no
 * numbered pin either (#91): its only handle in the itinerary is the day it
 * happens on, so that is where the selection scrolls (`placeDays`, first day).
 *
 * `null` = no handle at all in the list (a registry entry no day mentions and
 * no chapter refs): ring only, and the sheet must not promise more.
 */
export type PlaceRailHandle = { kind: "pill"; refs: string[] } | { kind: "day"; dayIdx: number };

export function placeRailHandle(trip: Trip, name: string): PlaceRailHandle | null {
  const target = findLocation(trip, name);
  if (!target) return null;
  const refs: string[] = [];
  for (const s of trip.sections ?? []) {
    for (const r of s.locationRefs ?? []) {
      if (findLocation(trip, r) === target) refs.push(r);
    }
  }
  if (refs.length) return { kind: "pill", refs };
  const days = placeDays(trip, name);
  if (!days.length) return null;
  const [first] = days;
  // The list must actually RENDER that day: with chapters it draws only the
  // days a section covers (`expandSectionDays`), without them every day gets a
  // flat row. A day card that does not exist is not a handle — promising it
  // would put the same broken sentence back in the sheet.
  const sections = trip.sections ?? [];
  const rendered = sections.length
    ? sections.some((s) => expandSectionDays(s.days).includes(first))
    : trip.days.length > 0;
  return rendered ? { kind: "day", dayIdx: first } : null;
}

/**
 * WHY the trip is at a place — a journey stop it re-bases at, or an excursion
 * it visits from a base elsewhere (#91; DESIGN.md §7.6: "Excursions from a
 * base render as secondary markers, never chain stops").
 *
 * A place is a STOP when the trip is ANCHORED there — evidence that it stays:
 *
 * - a section `locationRefs` base ("this chapter is based here"), or
 * - a movement endpoint (`from`/`to` of a transport block) with MORE THAN ONE
 *   attributed day: it arrives and is still there the next day.
 *
 * A place that is only an ENDPOINT of a SINGLE day's movement is a DAY TRIP,
 * not a re-base (#435): the trailhead you drive to and back from, the lake you
 * hike to, the airport you land at and leave the same day. Counting any
 * transport endpoint as a stop put those in the chain as if the trip moved
 * base, so `Cebollapampa` and `Laguna 69` — both day trips from Huaraz on Peru
 * 2027 — cut the Cordillera off from Lima and the authored
 * `Nachtbus Huaraz → Lima` card had no leg to claim: the map drew a 665 km road
 * from the lake to Lima. They are excursions now, while the gateway pass in
 * `legBlock` still matches an airport-paired flight to a city leg (#361 slice 4)
 * — the arrival/departure gateway does not have to be a chain stop to be
 * matched.
 *
 * A place CIRCLED by a longer stay is a day trip however else it is evidenced
 * (#435): `Laguna 69` is named in a chapter's `locationRefs` (a chip row lists
 * day trips too — the Peru content round dropped `Heilige Vallei` and `Palccoyo`
 * from refs for exactly this reason), yet the trip goes there on day 4 of a
 * Huaraz stay that runs 1–5 and sleeps elsewhere. An endpoint with more than one
 * day survives that test, and so does any place carrying the trip through the
 * night.
 *
 * Deliberately NOT signals: "has a lodging card" (a lodging block's `location`
 * is the HOTEL — anchoring on it promoted every hotel venue in canada-2027's
 * registry to a chain stop and the chain ran
 * `Banff → Peaks Hotel & Suites → Banff → …`) and a day count on its own (a
 * hotel you sleep in for three nights has three days). #91 stands: a venue is
 * not a base.
 *
 * Prose is deliberately NOT a signal: matching `via` text would re-base a
 * place on the strength of a road description ("over Rogers Pass").
 */
export type PlaceRole = "stop" | "excursion";

/** Is this place an endpoint of an authored movement (`from`/`to` of a transport block)? */
function isTransportEndpoint(trip: Trip, target: TripLocation): boolean {
  return allBlocks(trip).some((b) => {
    if (b.kind !== "transport") return false;
    return [b.from, b.to].some((n) => !!n && findLocation(trip, n) === target);
  });
}

function isSectionBase(trip: Trip, target: TripLocation): boolean {
  return (trip.sections ?? []).some((s) =>
    (s.locationRefs ?? []).some((r) => findLocation(trip, r) === target),
  );
}

/**
 * Does the trip STAY here? A chapter base, or a movement endpoint it is still
 * at the next day.
 *
 * Deliberately NOT "has a lodging card": a lodging block's `location` is the
 * HOTEL, so anchoring on it promotes every hotel venue in the registry to a
 * chain stop — measured on canada-2027, whose chain became
 * `Banff → Peaks Hotel & Suites → Banff → Coast Hillcrest Hotel → …`. Nor a day
 * count on its own, for the same reason (a hotel you sleep in three nights has
 * three days). #91's rule stands: a venue is not a base.
 */
function anchorsStay(trip: Trip, target: TripLocation): boolean {
  if (isSectionBase(trip, target)) return true;
  return isTransportEndpoint(trip, target) && placeDays(trip, target.name).length > 1;
}

/**
 * Is this stay CIRCLED by a longer one — a day trip however else it is
 * evidenced (#435)?
 *
 * `Laguna 69` is named in a chapter's `locationRefs` (a chip row lists day
 * trips too — the Peru content round dropped `Heilige Vallei` and `Palccoyo`
 * from refs for exactly this), yet the trip goes there on day 4 of a Huaraz
 * stay that runs 1–5 and sleeps elsewhere. A movement endpoint with more than
 * one day survives — it carries the trip through the night.
 */
function isCircledStay(trip: Trip, target: TripLocation): boolean {
  const days = placeDays(trip, target.name);
  if (!days.length) return false;
  if (isTransportEndpoint(trip, target) && days.length > 1) return false;
  const first = days[0];
  const last = days[days.length - 1];
  return locatedPlaces(trip).some((other) => {
    if (other === target || !anchorsStay(trip, other)) return false;
    const od = placeDays(trip, other.name);
    return od.length > 0 && od[0] < first && od[od.length - 1] > last;
  });
}

export function placeRole(trip: Trip, name: string): PlaceRole {
  const target = findLocation(trip, name);
  if (!target) return "excursion";
  if (!anchorsStay(trip, target)) return "excursion";
  if (isCircledStay(trip, target)) return "excursion";
  return "stop";
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
 * Paint order for a level's markers (#388 — venue diamonds buried the stop pins
 * they stand on).
 *
 * MapLibre appends every marker element to the same canvas container and all of
 * them are `position: absolute` with `z-index: auto`, so the DOM order the
 * component built IS the stacking order and the LATER element wins a tap at a
 * shared spot. The venue round appended 23 excursion diamonds AFTER the five
 * chain stops they stand on (Revelstoke alone has six venues within ~4 px), so
 * the map's own numbered pins became untappable: at journey zoom a tap on
 * ③ Revelstoke selected The Village Idiot Bar & Grill (Niko, 2026-09-23).
 *
 * Ranked lowest first — a marker sorted by this paints under the next:
 *
 * - `0` — an excursion diamond: secondary by design (§7.6) and never allowed to
 *   cover the trip's own structure.
 * - `1` — a numbered stop pin: the ① ② ③ index is the map's spine.
 * - `2` — a day's activity chip: it opens a block, so it keeps the top spot it
 *   already had by being added last.
 *
 * Equal ranks keep their input order (`sort` is stable), so a level's own marker
 * order still reads.
 */
export function markerPaintRank(
  trip: Trip,
  marker: { role: "place" | "activity"; place: TripLocation },
): number {
  if (marker.role === "activity") return 2;
  return placeRole(trip, marker.place.name) === "excursion" ? 0 : 1;
}

/**
 * Does the trip come back to where it started?
 *
 * With the visit chain (#433) this is no longer a heuristic — it is a fact
 * about the derived visits: the LAST stay is at the place the trip started
 * at. The old test ("the first chain stop is visited both near the start and
 * near the end") existed only because a unique-place chain could not express
 * the return; it also mis-read trips whose start place merely had a late
 * airport day.
 *
 * Unplaced stops (no attributed day) are ignored: they trail the chain as
 * ideas and cannot decide where the trip ended.
 */
export function returnsToStart(trip: Trip): boolean {
  const placed = journeyVisits(trip).filter((v) => v.days.length);
  if (placed.length < 3) return false;
  return placed[0].place === placed[placed.length - 1].place;
}

export interface JourneyLeg {
  from: TripLocation;
  to: TripLocation;
  stage: LegStage;
  /** The transport block this leg's state came from, when there is one. */
  block?: Block;
}

/**
 * One stay at a re-base place (#433).
 *
 * A place is not a position in the journey — a base the trip RETURNS to
 * (Lima: arrival on days 0–1, the night-bus arrival on 5–6, the departure on
 * 14–16) is three visits, and only a visit sequence can chain
 * `Huaraz → Lima → Cusco`. `days` is the contiguous run of days attributed to
 * the place for THIS stay, so the surface can say which stay a leg belongs to;
 * it is empty for a stop with no attributed day (an unplaced idea, tail of the
 * chain).
 */
export interface JourneyVisit {
  place: TripLocation;
  /** 0-based day indices of this stay, ascending. Empty = no day attributed. */
  days: number[];
}

/** Split an ascending day list into its contiguous runs. */
function contiguousRuns(days: number[]): number[][] {
  const runs: number[][] = [];
  for (const d of days) {
    const run = runs[runs.length - 1];
    if (run && d === run[run.length - 1] + 1) run.push(d);
    else runs.push([d]);
  }
  return runs;
}

export interface Journey {
  /** Every located place, in marker order — the trip's index (§8.3). */
  stops: TripLocation[];
  /**
   * The re-base stops in visit order — one entry per STAY, so a place the trip
   * returns to appears once per stay (see `journeyVisits`).
   */
  chain: TripLocation[];
  /** Consecutive pairs of VISITS. A return is a visit, so there is no
   *  synthetic closing leg: the chain carries the way home. */
  legs: JourneyLeg[];
  /** The last stay is at the place the trip started at (`returnsToStart`). */
  loop: boolean;
  /** The same sequence, with each stay's days — the derivation behind `chain`. */
  visits: JourneyVisit[];
  /**
   * Excursions — located places the trip visits without re-basing there
   * (Rogers Pass from Revelstoke, a toured pass between two drives). Never in
   * `chain`, never given legs; the surface renders them as secondary markers.
   */
  excursions: TripLocation[];
}

/** The stops that may appear in the chain: every located place on a scaffold
 *  trip, only the re-base stops otherwise (#91). */
function chainStops(trip: Trip): TripLocation[] {
  return isRegistryScaffold(trip)
    ? locatedPlaces(trip)
    : locatedPlaces(trip).filter((l) => placeRole(trip, l.name) === "stop");
}

/**
 * The journey as a sequence of VISITS (#433): one entry per stay at a re-base
 * place, earliest stay first.
 *
 * Why visits rather than places: `journeyOrder` used to emit each re-base
 * stop ONCE, ordered by its first attributed day. A multi-base trip that
 * returns to its start city (arrive Lima, night bus back to Lima, fly home
 * from Lima) then had Lima in exactly one slot, so nothing sat between the
 * Cordillera and the Cusco cluster and the movement
 * `Huaraz → (night bus) Lima → (flight) Cusco` could not be chained at all —
 * the hop was drawn as a road route across the country (#433). A place is
 * not a position in an itinerary; a STAY is.
 *
 * The stays come from `placeDays` (the surface's one answer for "which days
 * is the trip at this place"), split into CONTIGUOUS runs. No day-count knob:
 * a stay ends when the trip is located somewhere else, and two runs of the
 * same place are merged only when nothing sits between them — an excursion
 * day at a venue (a ski day at a neighbouring hill, a pass toured from the
 * base) must not split one stay in two.
 *
 * Ordering is by first day, registry position as the tie-break. Places with no
 * attributed day keep registry order at the tail, where an unplaced idea
 * belongs. Marker NUMBERS are untouched by any of this — they stay the
 * registry index, the through-line to the drive cards and the booklet.
 *
 * EXCURSIONS (#91): a place that is never a re-base is excluded entirely. It
 * does not sit between two chain stops, so no leg to or from it exists and no
 * phantom through-route can be drawn through it — exclusion is structural,
 * not a styling choice.
 */
export function journeyVisits(trip: Trip): JourneyVisit[] {
  const stops = chainStops(trip);
  const indexOf = new Map(stops.map((loc, i) => [loc, i] as const));
  const daysByPlace = new Map(stops.map((loc) => [loc, placeDays(trip, loc.name)] as const));

  const placed: { place: TripLocation; days: number[]; index: number }[] = [];
  for (const place of stops) {
    for (const run of contiguousRuns(daysByPlace.get(place) ?? [])) {
      placed.push({ place, days: run, index: indexOf.get(place) ?? 0 });
    }
  }
  placed.sort((a, b) => a.days[0] - b.days[0] || a.index - b.index);
  orderSharedFirstDay(trip, placed);

  const visits: JourneyVisit[] = [];
  for (const v of placed) {
    const last = visits[visits.length - 1];
    if (last && last.place === v.place) last.days = [...last.days, ...v.days];
    else visits.push({ place: v.place, days: [...v.days] });
  }

  // Ideas with no attributed day: registry order, after every real stay.
  for (const place of stops) {
    if (!(daysByPlace.get(place) ?? []).length) visits.push({ place, days: [] });
  }
  return visits;
}

/**
 * Which of two places comes first on a day that names both — decided by the
 * day's own transport blocks, when one connects the pair.
 *
 * A transfer day belongs to BOTH its endpoints (`placeDays`), so an arrival
 * day can start two stays at once: "Land in Cusco — drive into the Sacred
 * Valley" puts Cusco (day 7) and the valley (days 7–9) at the same first day,
 * and registry order then had to guess. It guessed wrong: the valley came
 * before Cusco, so the chain claimed a Cusco → Machu Picchu leg that nobody
 * travels and lost the authored Cusco → valley drive into a reversed match.
 * The block that describes the day already knows the direction, so it decides.
 */
function orderSharedFirstDay(
  trip: Trip,
  placed: { place: TripLocation; days: number[]; index: number }[],
): void {
  const dayOrder = (day: number, a: TripLocation, b: TripLocation): number | null => {
    for (const block of trip.days[day]?.blocks ?? []) {
      if (block.kind !== "transport") continue;
      const e = blockEndpoints(trip, block);
      if (e.from === a && e.to === b) return -1;
      if (e.from === b && e.to === a) return 1;
    }
    return null;
  };
  // Insertion sort inside each same-first-day run: the comparator is only
  // meaningful pairwise (a block connects two places, not a group), so a
  // stable, local sort beats a global comparator that could contradict itself.
  for (let i = 1; i < placed.length; i++) {
    let j = i;
    while (j > 0) {
      const prev = placed[j - 1];
      const cur = placed[j];
      if (prev.days[0] !== cur.days[0]) break;
      const order = dayOrder(cur.days[0], prev.place, cur.place);
      if (order == null || order < 0) break;
      placed[j - 1] = cur;
      placed[j] = prev;
      j--;
    }
  }
}

/**
 * The order the trip actually visits its re-base stops — the visit sequence's
 * places, so a place the trip returns to appears once per stay (#433). Kept as
 * the plain place list because that is what the map and the booklet ask the
 * route endpoint for; `journeyVisits` is the same sequence with the days.
 */
export function journeyOrder(trip: Trip): TripLocation[] {
  return journeyVisits(trip).map((v) => v.place);
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
 * `stops` is registry order (marker numbers); `chain` and `legs` are visit
 * order, which is what the map draws and what the list mirrors — so the list
 * reads down the route even where the marker numbers do not (§8.3: the number
 * is the index, the line is the journey). Only chain members are paired into
 * legs, so an excursion is structurally unable to gain one.
 *
 * A RETURN is a visit (#433): the chain ends at the place the trip comes back
 * to, so `legs` simply pairs consecutive visits and there is no synthetic
 * closing pair any more — the way home is a leg with its own block (a drive
 * card, a flight), not a line the derivation invented.
 */
export function tripJourney(trip: Trip): Journey {
  const stops = locatedPlaces(trip);
  const visits = journeyVisits(trip);
  const chain = visits.map((v) => v.place);
  const pairs: [TripLocation, TripLocation][] = [];
  for (let i = 0; i + 1 < visits.length; i++) pairs.push([chain[i], chain[i + 1]]);
  return {
    stops,
    chain,
    visits,
    loop: returnsToStart(trip),
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
 * The `modes` value that marks a leg as a chain GAP — a pair with no transport
 * block of its own (#433).
 *
 * A transport mode describes travel the author COMMITTED to; a gap has none,
 * and an empty CSV slot cannot say so (an unclassified transport block sends
 * an empty slot too, and that leg must stay a road). So the gap gets its own
 * word: the backend answers it `road: false` without asking HERE at all, and
 * the client draws the great-circle arc, dashed and dim.
 *
 * Supersedes #407's "undeclared → historical car default" for the chain: a
 * chain gap is a pair NOBODY authored, and a road across the country is an
 * assertion the trip never made (Lima → Cusco came back as a 797 km drive on
 * a leg the traveller flies). An absent `modes` parameter keeps the road
 * default — the endpoint is unchanged for every caller that declares nothing.
 */
export const LEG_GAP_MODE = "gap";

/**
 * The declared transport mode per leg of a place chain — the value the
 * backend's `modes` parameter wants (same order as the pairs `places` produce).
 *
 * The mode comes from THE classifier every other surface uses
 * (`classifyTransportMode`, #88): an explicit `Block.mode` wins, drive evidence
 * (distance/duration/route/via) next, flight evidence (booking code, IATA
 * codes, flight words) after that, and `undefined` when the card says nothing —
 * the caller's road default. Reading `Block.mode` alone made the chain the only
 * surface that could not see a flight: `Fly Cusco → Lima (1h15)` with no `mode`
 * field drew as a car route here while the day map drew the same card as a
 * plane (the Chile+Peru trip, #433).
 *
 * `LEG_GAP_MODE` is reserved for a pair with NO transport block at all, so the
 * backend draws an honest provisional arc instead of inventing a road (#433).
 * Unresolvable pairs ride along as `undefined` so positions stay aligned.
 *
 * No `loop` parameter any more (#433): the chain is a VISIT sequence and a
 * return is a real visit, so the pairs are exactly consecutive places — there
 * is no synthetic closing pair for the caller to ask for.
 */
export function legModes(trip: Trip, places: string[]): (string | undefined)[] {
  const names = places.map((p) => findLocation(trip, p));
  const pairs: [TripLocation | undefined, TripLocation | undefined][] = names
    .slice(0, -1)
    .map((loc, i) => [loc, names[i + 1]]);
  return pairs.map(([a, b]) => {
    if (!a || !b) return undefined;
    const block = legBlock(trip, a, b);
    if (!block) return LEG_GAP_MODE;
    return classifyTransportMode(block);
  });
}

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

/**
 * Drawable coordinates for a fetched route leg — the ONE shared helper both
 * map surfaces use (#357 slice 3A, the §8.4 promise).
 *
 * A `road: true` leg draws the backend's geometry (real roads). A
 * `road: false` leg (flight/ferry) draws the great-circle arc between its
 * endpoints — never the straight screen-space line the backend ships (a
 * Europe→Tokyo flight drawn flat reads as a mistake). The `road` flag is
 * authoritative; geometry never decides.
 */
export function resolveLegCoordinates(leg: {
  road: boolean;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}): [number, number][] {
  const coords = leg.geometry.coordinates;
  if (leg.road || coords.length < 2) return coords;
  return greatCircle(coords[0], coords[coords.length - 1]);
}
