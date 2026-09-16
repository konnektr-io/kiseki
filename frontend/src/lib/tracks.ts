/**
 * Recorded GPS tracks (#279, slice of #193) — the client side of
 * `GET /api/tracks/<trip>/<file>`.
 *
 * An activity block carries the BARE `.gpx` filename as `track`; the API
 * canonicalizes it to `/media/<trip>/<file>` on read (like every other media
 * field). The polyline + summary live behind the parse route, derived from
 * that URL here so no component hardcodes the mapping. Fetching is plain
 * `fetch` — a track is data, and every surface (day map, card, booklet trace)
 * reads the same shape.
 */

export interface TrackLeg {
  type: "ride" | "lift";
  /** Inclusive indices into `geometry.coordinates` — `slice(start, end + 1)`. */
  startIndex: number;
  endIndex: number;
  distanceM: number;
  ascentM: number;
  durationS?: number | null;
}

export interface TrackProperties {
  distanceM: number;
  ascentM: number;
  startTime?: string | null;
  endTime?: string | null;
  durationS?: number | null;
  pointCount: number;
  /**
   * Ride/lift split (#290). `distanceM` stays the FULL trace total (lifts
   * included); `rideDistanceM` is the riding-only figure the rider logs —
   * the day card shows both rather than picking one. Absent on a track
   * parsed before #290 or with no legs to classify.
   */
  rideDistanceM?: number;
  liftDistanceM?: number;
  liftVerticalM?: number;
  legs?: TrackLeg[];
  url?: string;
}

export interface TrackFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: TrackProperties;
}

/** One drawable piece of a recorded track (#290): a ride or a lift leg. */
export interface TrackSegment {
  type: "ride" | "lift";
  coordinates: [number, number][];
}

/**
 * Every recorded track on the trip (#193), in day order — the whole-trip
 * surfaces (overview / booklet route map) draw these alongside the legs.
 * Reads the explicit `track` field only, days then section ideation blocks.
 */
export function tripTracks(trip: {
  days?: { blocks?: { track?: string; order?: number }[] }[];
  sections?: { blocks?: { track?: string }[] }[];
}): string[] {
  const out: string[] = [];
  for (const day of trip.days ?? []) {
    for (const b of [...(day.blocks ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (b.track) out.push(b.track);
    }
  }
  for (const s of trip.sections ?? []) {
    for (const b of s.blocks ?? []) {
      if (b.track) out.push(b.track);
    }
  }
  return out;
}

/**
 * The parse route for a block `track` value — `/media/<trip>/<file>` →
 * `/api/tracks/<trip>/<file>`. Null for anything that is not a readable trip
 * track (bare names, external URLs, non-track files): those never fetch.
 * `.gpx` and `.fit` are both served by the parse route (#279 / #290).
 */
export function trackDataUrl(track: string | undefined | null): string | null {
  if (typeof track !== "string" || !track.startsWith("/media/")) return null;
  const rest = track.slice("/media/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const file = rest.slice(slash + 1);
  const lower = file.toLowerCase();
  if (!file || file.includes("/") || !(lower.endsWith(".gpx") || lower.endsWith(".fit"))) {
    return null;
  }
  const trip = rest.slice(0, slash);
  if (!trip) return null;
  return `/api/tracks/${trip}/${file}`;
}

/** Fetch one parsed track. Rejects on HTTP error or abort — callers degrade
 *  to the download link rather than an empty card. */
export async function fetchTrack(dataUrl: string, signal?: AbortSignal): Promise<TrackFeature> {
  const res = await fetch(dataUrl, { signal });
  if (!res.ok) throw new Error(`Track fetch failed (${res.status}): ${dataUrl}`);
  const body = (await res.json()) as TrackFeature;
  if (body?.geometry?.type !== "LineString" || !Array.isArray(body.geometry.coordinates)) {
    throw new Error(`Not a track: ${dataUrl}`);
  }
  return body;
}

/** "850 m" under a kilometre, "12.4 km" above — tabular-nums wherever shown. */
export function formatTrackDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Recorded time the booklet way ("1 h 35"), plain minutes when short. */
export function formatTrackDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

/** Ascent always carries its sign — "+840 m" reads as climbing, not length. */
export function formatTrackAscent(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  return `+${Math.round(meters).toLocaleString("en-US")} m`;
}

/**
 * The booklet's static trace: the polyline as an SVG path `d` in a
 * `width × height` box with `pad` padding. Equirectangular with a cos(lat)
 * correction so a traverse does not stretch east–west; null when there is no
 * line to draw. Pure — the card and any future surface share it.
 */
export function trackTracePath(
  coordinates: [number, number][],
  width: number,
  height: number,
  pad: number,
): string | null {
  const project = trackProjector(coordinates, width, height, pad);
  if (!project) return null;
  const pts = coordinates.map(project);
  return `M${pts[0]}L${pts.slice(1).join("L")}`;
}

/**
 * One shared projection for a whole trace (#290): legs are drawn as separate
 * paths, so they must agree on a single fit — projecting each leg on its own
 * would scale every leg to the box and scatter the day across the card.
 * Returns a `[lng, lat] → "x y"` mapper, or null for a one-point line.
 */
export function trackProjector(
  coordinates: [number, number][],
  width: number,
  height: number,
  pad: number,
): ((c: [number, number]) => string) | null {
  if (coordinates.length < 2) return null;
  const lats = coordinates.map((c) => c[1]);
  const lngs = coordinates.map((c) => c[0]);
  const meanLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const kx = Math.cos((meanLat * Math.PI) / 180) || 1;
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-9);
  const spanY = Math.max(maxLat - minLat, 1e-9);
  const innerW = Math.max(width - pad * 2, 1);
  const innerH = Math.max(height - pad * 2, 1);
  // Fit the whole trace: one scale for both axes, centred on the spare side.
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const offX = pad + (innerW - spanX * scale) / 2;
  const offY = pad + (innerH - spanY * scale) / 2;
  return ([lng, lat]) => {
    const x = offX + (lng - minLng) * kx * scale;
    // SVG y grows downward — the northernmost point sits at the top.
    const y = offY + (maxLat - lat) * scale;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  };
}

/**
 * A track's bytes as drawable segments (#290): one per classified leg, so the
 * day map can dash the lifts and keep the runs solid. A track with no legs
 * (pre-#290 payload, or a file with nothing to classify) is ONE ride segment —
 * the pre-existing single-line behaviour.
 */
export function trackSegments(feature: TrackFeature): TrackSegment[] {
  const coords = feature.geometry.coordinates;
  const legs = feature.properties.legs;
  if (!legs?.length) {
    return coords.length >= 2 ? [{ type: "ride", coordinates: coords }] : [];
  }
  const out: TrackSegment[] = [];
  for (const leg of legs) {
    const start = Math.max(0, leg.startIndex);
    const end = Math.min(coords.length - 1, leg.endIndex);
    if (end - start < 1) continue;
    out.push({
      type: leg.type === "lift" ? "lift" : "ride",
      coordinates: coords.slice(start, end + 1),
    });
  }
  return out.length ? out : [{ type: "ride", coordinates: coords }];
}

/**
 * The trace drawn leg by leg (#290) — ride solid, lift dashed — sharing one
 * projection. The card's static SVG trace and anything else static use this.
 */
export function trackLegPaths(
  feature: TrackFeature,
  width: number,
  height: number,
  pad: number,
): { type: "ride" | "lift"; d: string }[] {
  const coords = feature.geometry.coordinates;
  const project = trackProjector(coords, width, height, pad);
  if (!project) return [];
  return trackSegments(feature)
    .map((segment) => {
      const pts = segment.coordinates.map(project);
      if (pts.length < 2) return null;
      return { type: segment.type, d: `M${pts[0]}L${pts.slice(1).join("L")}` };
    })
    .filter((p): p is { type: "ride" | "lift"; d: string } => p != null);
}

/**
 * The #290 headline split for a track card: riding-only distance beside the
 * full trace distance. Null when the payload carries no legs (nothing to
 * compare — the card then shows the plain total).
 */
export function trackRideSplit(
  props: TrackProperties | undefined | null,
): { rideM: number; totalM: number; liftM: number; liftVerticalM: number } | null {
  if (!props || typeof props.rideDistanceM !== "number") return null;
  if (!props.legs?.length) return null;
  return {
    rideM: props.rideDistanceM,
    totalM: props.distanceM,
    liftM: props.liftDistanceM ?? Math.max(props.distanceM - props.rideDistanceM, 0),
    liftVerticalM: props.liftVerticalM ?? 0,
  };
}
