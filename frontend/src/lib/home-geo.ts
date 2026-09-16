import type { Stage, TripGeo } from "./types";

/**
 * The signed-in home's map pins (#249, slice 3).
 *
 * The bands answer "what", the map answers "where" — so the map needs exactly
 * one point per trip, and this file owns everything about those points that
 * can be said without a browser: which rows become pins, what stage a pin
 * draws, how pins group when they collide, and the id that ties a pin to its
 * band row. All pure, all tested. The canvas itself (`components/HomeMap`)
 * only projects and paints.
 */

/** One pin on the home map — the E2 row, validated, nothing invented. */
export interface HomeMapPin {
  dtId: string;
  title: string;
  stage: Stage;
  lat: number;
  lng: number;
  name: string;
  origin: TripGeo["origin"];
}

/** The stages the pin vocabulary knows — anything else reads as provisional. */
const KNOWN_STAGES: readonly Stage[] = [
  "idea",
  "options",
  "shortlist",
  "planned",
  "booked",
  "live",
  "archive",
];

/**
 * A pin's stage, coerced. The graph may hand over a stage the app does not
 * know (a newer server, a typo in a fixture) — `pinClassForStage` has no
 * default arm, so an unknown stage would draw NO pin at all. Provisional is
 * the honest fallback: an unrecognised plan must look uncommitted, never
 * booked.
 */
export function pinStage(stage: string): Stage {
  return (KNOWN_STAGES as readonly string[]).includes(stage) ? (stage as Stage) : "idea";
}

/** The E2 rows as pins, in server order. Malformed rows are dropped. */
export function homePinsFromGeo(rows: readonly TripGeo[]): HomeMapPin[] {
  const out: HomeMapPin[] = [];
  for (const row of rows) {
    if (!row || typeof row.dtId !== "string" || !row.dtId) continue;
    const anchor = row.anchor;
    if (!anchor || !Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) continue;
    if (row.origin !== "mine" && row.origin !== "discover") continue;
    out.push({
      dtId: row.dtId,
      title: typeof row.title === "string" ? row.title : "",
      stage: pinStage(row.stage),
      lat: anchor.lat,
      lng: anchor.lng,
      name: typeof anchor.name === "string" ? anchor.name : "",
      origin: row.origin,
    });
  }
  return out;
}

/** The band row a pin belongs to — the pin↔row tie in both directions. */
export function homeRowId(dtId: string): string {
  return `home-trip-${dtId}`;
}

/** One pin's screen position, ready to cluster. */
export interface ProjectedPin {
  dtId: string;
  x: number;
  y: number;
}

/** A cluster of pins too close to tap apart — drawn as one count badge. */
export interface PinCluster {
  key: string;
  memberDtIds: string[];
  x: number;
  y: number;
}

export type ClusteredPin = { kind: "pin"; pin: ProjectedPin } | { kind: "cluster"; cluster: PinCluster };

/**
 * Group pins that collide on screen (the same clustering vocabulary as the
 * trip maps: a count, not a range — DESIGN.md §8.3).
 *
 * Greedy and deterministic: in input order, each unclaimed pin seeds a group
 * with everything unclaimed within `radiusPx` of it. A lone pin is never a
 * "cluster of one" — callers draw it as its own pin.
 */
export function clusterPins(points: readonly ProjectedPin[], radiusPx: number): ClusteredPin[] {
  const claimed = new Set<string>();
  const out: ClusteredPin[] = [];
  for (const seed of points) {
    if (claimed.has(seed.dtId)) continue;
    claimed.add(seed.dtId);
    const members = [seed];
    for (const other of points) {
      if (claimed.has(other.dtId)) continue;
      if (Math.hypot(other.x - seed.x, other.y - seed.y) <= radiusPx) {
        claimed.add(other.dtId);
        members.push(other);
      }
    }
    if (members.length === 1) {
      out.push({ kind: "pin", pin: seed });
    } else {
      const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
      const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
      out.push({
        kind: "cluster",
        cluster: {
          key: [...members.map((m) => m.dtId)].sort().join("+"),
          memberDtIds: members.map((m) => m.dtId),
          x: cx,
          y: cy,
        },
      });
    }
  }
  return out;
}
