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
 * Transport: every transport block with BOTH endpoints on the registry
 * draws a leg between them. Drive/train (and unclassified — the historical
 * car default, #88) legs draw as route polylines; flight and ferry legs draw
 * as a dashed straight (great-circle) line and must never be road-routed —
 * each leg carries the block's declared `mode` so the renderer can skip the
 * road query for them, exactly as the scan level's `legModes` does. A block
 * with only one resolved endpoint (an off-registry gateway like BRU) marks
 * just that end; the card's plane/ship chip still carries the mode (#90).
 * A leg's state comes from its own block (`status`), falling back to the
 * trip stage exactly as `legStage` does for chain legs.
 */

import { findLocation } from "./maps";
import { blockEndpoints, stageToLegStage, type LegStage } from "./route-surface";
import { classifyTransportMode, type TransportMode } from "./transport";
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
  /** The block's declared mode — flight/ferry legs skip the road query and
   *  draw as a dashed straight (great-circle) line, never a car route. */
  mode?: TransportMode;
}

/** A recorded track on the day (#193) — the block that carries it and the
 *  canonical /media URL the parse route derives from. */
export interface DayTrack {
  blockId: string;
  url: string;
}

export interface DaySurface {
  /** Numbered pins + letter chips, in day order (pins appear where first touched). */
  markers: DayMarker[];
  /** Legs to draw — road legs as route polylines, flight/ferry legs as
   *  dashed straight lines between their resolved endpoints. */
  legs: DayLeg[];
  /** Places a transport block travels between — keep their pins visible even
   *  on a pure travel day with no letter chips at all. */
  endpoints: TripLocation[];
  /** blockId → letter, for stamping the cards. */
  letters: Map<string, string>;
  /** Recorded tracks (#193): an explicit `track` field on the block, in day
   *  order. Derivation reads the field only — it never invents a line. */
  tracks: DayTrack[];
}

/** A transport block's leg state — the block speaks for itself, with the same
 *  trip-stage fallback `legStage` applies to a speaking chain leg. */
export function blockLegStage(trip: Trip, b: Block): LegStage {
  if (b.status === "booked" || b.status === "done") return "booked";
  if (b.status === "planned") return "planned";
  return stageToLegStage(trip.stage);
}

/**
 * The title pass of the anchor match (#104): a place the block's title names
 * via a CONTAINS match over the registry — exact name first, then aliases
 * (#104 prod: "Sunshine full day" never matched "Sunshine Village" until its
 * alias "Sunshine" existed; a title can name a place through its alias).
 * Longest name wins so "Lake Louise" beats "Louise" when both could match.
 * Returns undefined when nothing matches — it never invents a place.
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
  const tracks: DayTrack[] = [];
  /** Place identity → its activity marker (to share the letter). */
  const chipByPlace = new Map<TripLocation, Extract<DayMarker, { role: "activity" }>>();
  let chipCount = 0;

  const pinAt = (loc: TripLocation) => {
    if (!markers.some((m) => m.role === "place" && m.place === loc)) {
      markers.push({ role: "place", place: loc });
    }
  };

  for (const b of ordered) {
    // A recorded track rides its activity block (#193) — collected for the
    // day map's line layers and its fit, whatever else the block resolves to.
    if (b.track && b.id) tracks.push({ blockId: b.id, url: b.track });
    if (b.kind === "transport") {
      const { from, to } = blockEndpoints(trip, b);
      const resolved = [from, to].filter(
        (p): p is TripLocation => !!p && p.lat != null && p.lng != null,
      );
      if (resolved.length) {
        const mode = classifyTransportMode(b);
        // A leg needs both ends on the registry with coordinates. An
        // UNCLASSIFIED transport block travels like the historical default —
        // a car (#88): it draws the same leg a chain drive would. Flight and
        // ferry blocks join the legs too, carrying their mode so the renderer
        // skips the road query and draws a dashed straight line between the
        // resolved endpoints instead of a car route (#90 follow-up).
        if (
          from &&
          to &&
          from.lat != null &&
          from.lng != null &&
          to.lat != null &&
          to.lng != null
        ) {
          legs.push({ from, to, block: b, stage: blockLegStage(trip, b), mode });
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
    // own fields/title name (the title pass is the shared `matchTitlePlace`
    // matcher — block cards resolve their registry place the same way).
    const anchor =
      (b.location ? findLocation(trip, b.location) : undefined) ??
      (b.from ? findLocation(trip, b.from) : undefined) ??
      (b.to ? findLocation(trip, b.to) : undefined) ??
      matchTitlePlace(trip, b.title);
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

  return { markers, legs, endpoints, letters, tracks };
}

/** Block id → letter for a day (the card-stamping map, straight from `daySurface`). */
export function dayLetters(surface: DaySurface): Map<string, string> {
  return surface.letters;
}
