import type { Stage, TripGeo } from "./types";
import { MAP_LABEL_MAX, MAP_LABEL_PIN_OFFSET_PX } from "./maps";

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

/**
 * Which trip pins get a visible title label (#372 slice 2) — the landing
 * map's half of the `selectMapLabels` display discipline, over pins instead
 * of place names. Pure, so the rule is pinned by test and the canvas
 * (`components/HomeMap`) only paints the answer.
 *
 * **No zoom gate, deliberately — and this is not an oversight.** The trip-map
 * `MAP_LABEL_ZOOM_FLOOR` (2) exists to stop clutter on maps carrying dozens of
 * pins; this surface holds ≤10 trips under a hard cap of 8, so the CAP is its
 * clutter control and a zoom gate buys nothing. Worse, a gate here is actively
 * wrong: the landing map is the app's only GLOBE, and MapLibre's zoom is
 * unbounded BELOW zero on a globe (the sphere may be smaller than the
 * viewport), unlike flat Mercator where the transform floors it around 0.6.
 * Measured on a 390×844 phone against live data: the settled camera lands at
 * **zoom −2.28** and labels vanished; the same page at 1440×900 settles at
 * +3.38 and keeps them. A floor of 0 therefore hid every label on exactly the
 * device this feature was asked for. Do not reintroduce one; if a future
 * surface needs a floor, gate on collision from the cluster pass instead.
 *
 * - At most MAX labels (the shared `MAP_LABEL_MAX` cap — one rule, not two).
 * - The selected trip is always labelled: moved first, never capped out.
 * - Clustered pins take NO label — a count badge is its own reading, and a
 *   label beside a badge would read as a second index. A selected pin inside
 *   a cluster stays quiet for the same reason; the badge is its reading.
 * - Pins with a blank title take no label: an empty pill is floating chrome,
 *   and the anchor name already rides the pin's `aria-label`.
 *
 * The geometry half of "labels never cover" lives in the canvas: the pill is
 * `pointer-events-none` below its pin (the `MAP_LABEL_PIN_OFFSET_PX` offset),
 * and the zoom chips are DOM chrome above the canvas.
 */
export function selectHomeLabels(
  pins: readonly HomeMapPin[],
  clusteredDtIds: ReadonlySet<string> | readonly string[],
  selectedDtId: string | null,
  max = MAP_LABEL_MAX,
): HomeMapPin[] {
  if (pins.length === 0) return [];
  const clustered = clusteredDtIds instanceof Set ? clusteredDtIds : new Set(clusteredDtIds);
  const candidates = pins.filter((p) => !clustered.has(p.dtId) && p.title.trim() !== "");
  if (selectedDtId) {
    const i = candidates.findIndex((p) => p.dtId === selectedDtId);
    if (i > 0) {
      const [picked] = candidates.splice(i, 1);
      candidates.unshift(picked);
    }
  }
  return candidates.slice(0, max);
}

/**
 * Pill geometry for the home title labels (#375) — pure, pinned by test,
 * painted by `components/HomeMap`.
 *
 * The display rule (`selectHomeLabels`: cap, selected-first, clusters quiet)
 * cannot see what the pills look like on screen: a 42-char title makes a
 * ~250px pill on a 390px phone, so edge pins clip at the map border
 * (`overflow-hidden` cuts them) and near neighbours overlap even though the
 * pins themselves clustered fine. Three geometry answers, in priority order
 * (the input order — selected first — is the placement order, never re-sorted):
 *
 * 1. **Width cap** (`HOME_LABEL_MAX_WIDTH_PX`): the pill never exceeds it;
 *    longer titles ellipsise (CSS) with the full text on `title`.
 * 2. **Edge clamp**: a pill whose pin projects inside the box is shifted
 *    (marker x-offset) so it stays inside; a pill that would run past the
 *    bottom flips above its pin (anchor `bottom`). Pins projecting outside
 *    the box keep the default placement — their pill is off-screen with them,
 *    and dragging a label into view for an invisible pin would lie.
 * 3. **Overlap**: a pill colliding with an already-placed one is dropped
 *    (the pin stays). The cap shrinks most collisions away; this catches the
 *    rest — two pins 60px apart whose capped pills are 160px wide.
 *
 * Widths are estimates (`estimateHomeLabelWidthPx`), not measurements: the
 * layout runs before the markers exist, and an estimate keeps the rule pure.
 * The estimate is conservative (at-or-above the real pill), so a kept pill
 * never overlaps worse than computed — at most a dropped pill that would
 * have fit by a few px.
 */
export const HOME_LABEL_MAX_WIDTH_PX = 160;
/** Approx pill height at `text-[11px]` + vertical padding — box math only. */
export const HOME_LABEL_HEIGHT_PX = 24;
/** Keep-out from the container edge — a pill never touches the border. */
export const HOME_LABEL_EDGE_PX = 4;

/** Conservative pill width for a title: ~6.5px per glyph + pill chrome, capped. */
export function estimateHomeLabelWidthPx(title: string): number {
  return Math.min(HOME_LABEL_MAX_WIDTH_PX, 32 + Math.ceil(title.length * 6.5));
}

/** A pin's projected screen point, in CSS px from the container's top-left. */
export interface HomeLabelScreenPt {
  x: number;
  y: number;
}

/** Where a home pill goes: which side of its pin, and how far it shifts. */
export interface HomeLabelPlacement {
  dtId: string;
  /** `top` = pill below the pin (the default); `bottom` = flipped above it. */
  anchor: "top" | "bottom";
  /** Marker x-offset in px — the edge clamp. Positive shifts right. */
  offsetX: number;
}

interface PlacedBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boxesOverlap(a: PlacedBox, b: PlacedBox, gap: number): boolean {
  return (
    a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap
  );
}

export function placeHomeLabels(
  labels: readonly HomeMapPin[],
  positions: ReadonlyMap<string, HomeLabelScreenPt>,
  containerW: number,
  containerH: number,
): HomeLabelPlacement[] {
  const out: HomeLabelPlacement[] = [];
  if (labels.length === 0) return out;
  // No box, no geometry — keep every label at its default placement rather
  // than clamping against a 0×0 container (which would stack all pills at
  // the corner and drop all but one).
  if (!(containerW > 0) || !(containerH > 0)) {
    return labels.map((p) => ({ dtId: p.dtId, anchor: "top" as const, offsetX: 0 }));
  }
  const placed: PlacedBox[] = [];
  for (const pin of labels) {
    const pos = positions.get(pin.dtId);
    if (!pos || pos.x < 0 || pos.x > containerW || pos.y < 0 || pos.y > containerH) {
      out.push({ dtId: pin.dtId, anchor: "top", offsetX: 0 });
      continue;
    }
    const w = estimateHomeLabelWidthPx(pin.title);
    const half = w / 2;
    // Clamp the pill's centre so the box stays inside the edges. On a box
    // narrower than the pill, centre it — a centred overflow reads better
    // than a pill pinned to one border.
    const lo = HOME_LABEL_EDGE_PX + half;
    const hi = containerW - HOME_LABEL_EDGE_PX - half;
    const cx = lo > hi ? containerW / 2 : Math.min(hi, Math.max(lo, pos.x));
    // Below the pin by default; flip above it when the pill would run past
    // the bottom and there is room on top.
    const belowTop = pos.y + MAP_LABEL_PIN_OFFSET_PX;
    const fitsBelow = belowTop + HOME_LABEL_HEIGHT_PX <= containerH - HOME_LABEL_EDGE_PX;
    const fitsAbove =
      pos.y - MAP_LABEL_PIN_OFFSET_PX - HOME_LABEL_HEIGHT_PX >= HOME_LABEL_EDGE_PX;
    const anchor: "top" | "bottom" = fitsBelow || !fitsAbove ? "top" : "bottom";
    const top =
      anchor === "top"
        ? Math.min(belowTop, containerH - HOME_LABEL_EDGE_PX - HOME_LABEL_HEIGHT_PX)
        : pos.y - MAP_LABEL_PIN_OFFSET_PX - HOME_LABEL_HEIGHT_PX;
    const box: PlacedBox = { left: cx - half, top, right: cx + half, bottom: top + HOME_LABEL_HEIGHT_PX };
    if (placed.some((p) => boxesOverlap(p, box, HOME_LABEL_EDGE_PX))) continue;
    placed.push(box);
    out.push({ dtId: pin.dtId, anchor, offsetX: Math.round(cx - pos.x) });
  }
  return out;
}
