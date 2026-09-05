import type { Block } from "./types";

/** How a transport block travels (`Block.mode`). */
export type TransportMode = NonNullable<Block["mode"]>;

/** Airport IATA codes seen in trip titles/descriptions — the flight heuristic's
 *  evidence list. Moved here from components/blocks.tsx so the day-page card
 *  and the summary glyphs classify from ONE place (issue #88). */
export const AIRPORT_CODES = /\b(BRU|FRA|YYC|LHR|SCL|CUZ|LIM|CTS|HND|NRT|KIX|AMS|CDG|MAD)\b/;

/**
 * The one transport classifier — shared by the day page's TransportBlock card
 * and the itinerary/folded-card/booklet glyphs, so a block carries the same
 * transport identity on every surface:
 *
 *  1. an explicit `mode` always wins (authoring intent);
 *  2. drive evidence (distance/duration/route/via) → drive;
 *  3. flight evidence (bookingCode / airport codes / flight words) → flight;
 *  4. otherwise `undefined` — the caller keeps its default (car glyph / drive
 *     card), so content that predates explicit `mode` classifies exactly as
 *     before. No silent "fixing".
 */
export function classifyTransportMode(
  b: Pick<
    Block,
    "mode" | "bookingCode" | "title" | "description" | "distance" | "duration" | "route" | "via"
  >,
): TransportMode | undefined {
  if (b.mode) return b.mode;
  // drive evidence — e.g. "850 km · 9 h" belongs to a road, even if the title
  // loosely says "transfer"
  if (b.distance || b.duration || b.route || b.via) return "drive";
  const isFlight =
    !!b.bookingCode ||
    AIRPORT_CODES.test(`${b.title ?? ""} ${b.description ?? ""}`) ||
    /(flight|depart|arriv)/i.test(`${b.title ?? ""}`);
  return isFlight ? "flight" : undefined;
}