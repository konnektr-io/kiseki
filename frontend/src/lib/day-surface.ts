/**
 * The DAY level of the trip map surface (#90, DESIGN.md §7.6/§8.3).
 *
 * The scan level (whole trip) derives from `lib/route-surface.ts`; this module
 * derives ONE DAY's world from that day's blocks alone — same derivation
 * honesty rules (#91): the map reports only what the content states, never an
 * invented place.
 *
 * Two marker roles share the day map (§8.3):
 * - **numbered place pins** — the stay/gateway places the day touches. These
 *   are the SAME pins the scan level draws (the ① ② ③ registry is the
 *   through-line), so no second numbering system ever appears.
 * - **letter chips (A, B, C…)** — activities/stays/meals that HAPPEN at a
 *   place, in day (block) order. A visibly different glyph (square chip vs
 *   round pin); the matching letter is stamped on the block card, and card ↔
 *   chip are interactive both ways.
 *
 * Transport: drive/train legs draw as polylines between the block's resolved
 * endpoints. Flights and ferries draw NOTHING — endpoint pins only; the card's
 * plane/ship chip carries the mode (#90: "flights as endpoint markers only —
 * no arc"). A drive leg's state comes from its own block (`status`), falling
 * back to the trip stage exactly as `legStage` does for chain legs.
 */

import { findLocation } from "./maps";
import { blockEndpoints, stageToLegStage, type LegStage } from "./route-surface";
import { classifyTransportMode } from "./transport";
import type { Block, Trip, TripLocation } from "./types";

/** Blocks that happen AT a place and therefore earn a letter chip. Transport
 *  blocks draw legs instead; todo/note/gallery/link/booking/custom have no
 *  place of their own and get nothing. */
const LETTER_KINDS = new Set(["activity", "lodging", "meal"]);

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The n-th (1-based) activity letter. Past Z the cycle repeats with an index
 * suffix ("A2") — a day with 27+ mapped stops is hypothetical, but the chips
 * must stay unique rather than silently collide.
 */
export function activityLetter(n: number): string {
  if (n < 1) return "A";
  const i = n - 1;
  const cycle = Math.floor(i / 26);
  return LETTERS[i % 26] + (cycle > 0 ? String(cycle + 1) : "");
}

export type DayMarker =
  | { role: "place"; place: TripLocation }
  /** One chip per mapped place — blocks sharing a place share the letter. */
  | { role: "activity"; place: TripLocation; letter: string; blockIds: string[] };

export interface DayLeg {
  from: TripLocation;
  to: TripLocation;
  block: Block;
  stage: LegStage;
}

export interface DaySurface {
  /** Numbered pins + letter chips, in day order (pins appear where first touched). */
  markers: DayMarker[];
  /** Drive/train legs to draw; flights/ferries stay out (endpoints only). */
  legs: DayLeg[];
  /** Places a transport block travels between — keep their pins visible even
   *  on a pure travel day with no letter chips at all. */
  endpoints: TripLocation[];
  /** blockId → letter, for stamping the cards. */
  letters: Map<string, string>;
}

/** A transport block's leg state — the block speaks for itself, with the same
 *  trip-stage fallback `legStage` applies to a speaking chain leg. */
export function blockLegStage(trip: Trip, b: Block): LegStage {
  if (b.status === "booked" || b.status === "done") return "booked";
  if (b.status === "planned") return "planned";
  return stageToLegStage(trip.stage);
}

/**
 * The day's world, derived. Every mapped thing traces to an explicit field or
 * a title-named registry place — `via`/`route` prose is road fact, not a
 * visit (#91), so it never produces a marker here either (`blockEndpoints`
 * reads it for LEG MATCHING, which is the leniency the chain surface already
 * ships; a day leg is a matched leg).
 */
export function daySurface(trip: Trip, dayIdx: number): DaySurface | null {
  const day = trip.days[dayIdx];
  if (!day) return null;

  // Day order = block order (the graph returns blocks in $dtId order — the
  // explicit `order` field is the content order everywhere else, so it is the
  // chip order here too).
  const ordered = [...day.blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const markers: DayMarker[] = [];
  const legs: DayLeg[] = [];
  const endpoints: TripLocation[] = [];
  const letters = new Map<string, string>();
  /** Place identity → its activity marker (to share the letter). */
  const chipByPlace = new Map<TripLocation, Extract<DayMarker, { role: "activity" }>>();
  let chipCount = 0;

  const pinAt = (loc: TripLocation) => {
    if (!markers.some((m) => m.role === "place" && m.place === loc)) {
      markers.push({ role: "place", place: loc });
    }
  };

  for (const b of ordered) {
    if (b.kind === "transport") {
      const { from, to } = blockEndpoints(trip, b);
      const resolved = [from, to].filter(
        (p): p is TripLocation => !!p && p.lat != null && p.lng != null,
      );
      if (resolved.length) {
        const mode = classifyTransportMode(b);
        // A leg needs both ends on the registry. An UNCLASSIFIED transport
        // block travels like the historical default — a car (#88): it draws
        // the same leg a chain drive would. Only an explicit flight/ferry is
        // endpoint-only, never an arc (#90).
        const roadLike = mode === undefined || mode === "drive" || mode === "train";
        if (
          roadLike &&
          from &&
          to &&
          from.lat != null &&
          to.lat != null
        ) {
          legs.push({ from, to, block: b, stage: blockLegStage(trip, b) });
        }
        // One-sided tolerance: a flight gateway (BRU → YYC with Brussels off
        // the registry) still marks the end it DID resolve (#90 endpoint
        // markers), rather than vanishing with its unknown twin.
        for (const p of resolved) {
          pinAt(p);
          if (!endpoints.includes(p)) endpoints.push(p);
        }
      }
      continue;
    }

    if (!LETTER_KINDS.has(b.kind) || !b.id) continue;
    // Anchor place: the explicit `location` field, then a place the block's
    // own fields/title name. A block with no resolvable place is not on the
    // map — no invented marker.
    const anchor =
      (b.location ? findLocation(trip, b.location) : undefined) ??
      (b.from ? findLocation(trip, b.from) : undefined) ??
      (b.to ? findLocation(trip, b.to) : undefined) ??
      (b.title
        ? (trip.locations ?? []).find((l) => b.title!.toLowerCase().includes(l.name.toLowerCase()))
        : undefined);
    if (!anchor || anchor.lat == null || anchor.lng == null) continue;

    const existing = chipByPlace.get(anchor);
    if (existing) {
      // A second block at the same place shares the letter — one chip per
      // point on the map, and both cards answer it.
      existing.blockIds.push(b.id);
      letters.set(b.id, existing.letter);
      continue;
    }
    // The chip IS the place's marker — no bare numbered pin stacked under it
    // (the chip would cover the pin's number and both would fight for the
    // point). `pinAt` is for places only transport touches.
    chipCount += 1;
    const letter = activityLetter(chipCount);
    const marker: Extract<DayMarker, { role: "activity" }> = {
      role: "activity",
      place: anchor,
      letter,
      blockIds: [b.id],
    };
    chipByPlace.set(anchor, marker);
    markers.push(marker);
    letters.set(b.id, letter);
  }

  return { markers, legs, endpoints, letters };
}

/** Block id → letter for a day (the card-stamping map, straight from `daySurface`). */
export function dayLetters(surface: DaySurface): Map<string, string> {
  return surface.letters;
}
