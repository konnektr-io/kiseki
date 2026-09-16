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

export interface TrackProperties {
  distanceM: number;
  ascentM: number;
  startTime?: string | null;
  endTime?: string | null;
  durationS?: number | null;
  pointCount: number;
  url?: string;
}

export interface TrackFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: TrackProperties;
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
 * The parse route for a block `track` value — `/media/<trip>/<file>.gpx` →
 * `/api/tracks/<trip>/<file>.gpx`. Null for anything that is not a readable
 * trip track (bare names, external URLs, non-gpx files): those never fetch.
 */
export function trackDataUrl(track: string | undefined | null): string | null {
  if (typeof track !== "string" || !track.startsWith("/media/")) return null;
  const rest = track.slice("/media/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const file = rest.slice(slash + 1);
  if (!file || file.includes("/") || !file.toLowerCase().endsWith(".gpx")) return null;
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
  const pts = coordinates.map(([lng, lat]) => {
    const x = offX + (lng - minLng) * kx * scale;
    // SVG y grows downward — the northernmost point sits at the top.
    const y = offY + (maxLat - lat) * scale;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return `M${pts[0]}L${pts.slice(1).join("L")}`;
}
