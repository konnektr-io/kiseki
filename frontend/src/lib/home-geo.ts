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

/** Normalise a longitude into [-180, 180). */
export function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Unfold longitudes into a continuous frame around the LARGEST GAP, so a pin
 * set that spans the antimeridian gets an honest west→east bounding box.
 *
 * A naive `[min(lng), max(lng)]` box measures the long way round: Canada
 * (−114.06), Chile (−70.66) and Japan (141.35) read as a 255° span centred on
 * Africa, when the shortest arc containing all three is 148° — Japan eastward
 * across the Pacific to Chile. On a phone that difference is the whole bug:
 * 148° fits a 390px viewport at the zoom MapLibre allows, 255° cannot fit at
 * any zoom (the world may never be shorter than the viewport is tall).
 *
 * The math is the standard "minimal covering arc": drop the widest gap, take
 * what remains. Returned values may exceed 180 (that is the point) — normalise
 * a CAMERA centre back with `normalizeLng`, never these.
 */
export function unfoldLngs(lngs: readonly number[]): number[] {
  const norm = lngs.map(normalizeLng);
  if (norm.length <= 1) return norm;
  const sorted = [...norm].sort((a, b) => a - b);
  let widest = -1;
  let widestEnd = 0;
  for (let i = 0; i < sorted.length; i++) {
    // The wrap-around gap closes the circle.
    const next = i === sorted.length - 1 ? sorted[0] + 360 : sorted[i + 1];
    const width = next - sorted[i];
    if (width > widest) {
      widest = width;
      widestEnd = i;
    }
  }
  // The arc starts at the point AFTER the widest gap.
  const start = sorted[(widestEnd + 1) % sorted.length];
  return norm.map((lng) => (lng < start ? lng + 360 : lng));
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

/**
 * Great-circle separation in degrees between two points (haversine).
 *
 * Pure spherical math — no browser, no map. Used for the landing globe
 * (#372 slice 1): on a globe a pin's screen projection survives the horizon,
 * so screen distance alone cannot decide what clusters with what.
 */
export function angularSeparationDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return (2 * Math.asin(Math.min(1, Math.sqrt(a))) * 180) / Math.PI;
}

/**
 * Whether a pin sits on the camera's hemisphere of the landing globe (#372
 * slice 1) — separation from the camera centre of at most 90°.
 *
 * The limb itself (exactly 90°) counts as visible: a centroid near the limb
 * still clusters with the visible set rather than falling off it. Anything
 * past the horizon is far-side: `HomeMap` clusters each hemisphere
 * separately, so a pin over the horizon never joins a visible cluster even
 * when `project` lands it on top of one.
 */
export function isOnVisibleHemisphere(
  pinLat: number,
  pinLng: number,
  centerLat: number,
  centerLng: number,
): boolean {
  return angularSeparationDeg(pinLat, pinLng, centerLat, centerLng) <= 90;
}
