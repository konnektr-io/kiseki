import { useEffect, useState } from "react";

/**
 * Live drive time for transport (drive) cards — HERE-backed, key server-side.
 *
 * The browser never talks to HERE: it GETs `/api/maps/directions` with a
 * lat/lng pair (the frontend already holds registry coordinates via
 * `findLocation`), and the backend serves HERE Routing v8 summary text behind
 * a short-TTL cache. On any failure the endpoint answers
 * `{"available": false}` (HTTP 200), so the card silently keeps its static
 * `duration`/`distance` — no UI noise, no retry loop.
 *
 * Print guard: the booklet renders through the same BlockView via headless
 * Chromium (which executes effects), so the hook never fetches under the
 * print media — the PDF keeps the static authored values byte-identical.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DirectionsResult {
  available: boolean;
  durationText?: string;
  distanceText?: string;
}

const UNAVAILABLE: DirectionsResult = { available: false };

/** In-module cache per rounded (from,to) pair — scrolling days remounts cards. */
const cache = new Map<string, DirectionsResult>();

export function clearDirectionsCache(): void {
  cache.clear();
}

function cacheKey(a: LatLng, b: LatLng): string {
  const r = (n: number) => n.toFixed(5);
  return `${r(a.lat)},${r(a.lng)}→${r(b.lat)},${r(b.lng)}`;
}

export function buildDirectionsUrl(a: LatLng, b: LatLng): string {
  const params = new URLSearchParams({
    fromLat: String(a.lat),
    fromLng: String(a.lng),
    toLat: String(b.lat),
    toLng: String(b.lng),
  });
  return `/api/maps/directions?${params.toString()}`;
}

/** Parse the endpoint body — anything unexpected is "unavailable", never a throw. */
export function parseDirectionsBody(body: unknown): DirectionsResult {
  if (!body || typeof body !== "object") return UNAVAILABLE;
  const b = body as Record<string, unknown>;
  if (b.available !== true) return UNAVAILABLE;
  const out: DirectionsResult = { available: true };
  if (typeof b.durationText === "string" && b.durationText) out.durationText = b.durationText;
  if (typeof b.distanceText === "string" && b.distanceText) out.distanceText = b.distanceText;
  return out;
}

/** Plain async fetch (no React) — unit-testable with a mocked global fetch. */
export async function fetchDirections(a: LatLng, b: LatLng, signal?: AbortSignal): Promise<DirectionsResult> {
  const key = cacheKey(a, b);
  const hit = cache.get(key);
  if (hit) return hit;
  let res: Response;
  try {
    res = await fetch(buildDirectionsUrl(a, b), { signal });
  } catch {
    return UNAVAILABLE;
  }
  if (!res.ok) return UNAVAILABLE;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return UNAVAILABLE;
  }
  const parsed = parseDirectionsBody(body);
  // Cache successes (and explicit available:false) — not transport errors,
  // so a flaky network retries on next mount instead of pinning a miss.
  cache.set(key, parsed);
  return parsed;
}

/** True while the page renders for print (booklet PDF) — no live fetch there. */
function isPrintRender(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("print").matches
  );
}

/**
 * Live directions for a drive card. Returns `null` until resolved (caller
 * keeps showing the static values), then the endpoint result — which may be
 * `{available: false}`, meaning "keep the static values, quietly".
 * Never fetches without both endpoints, and aborts in-flight on unmount.
 */
export function useLiveDirections(from?: LatLng | null, to?: LatLng | null): DirectionsResult | null {
  const [result, setResult] = useState<DirectionsResult | null>(null);
  const fromLat = from?.lat;
  const fromLng = from?.lng;
  const toLat = to?.lat;
  const toLng = to?.lng;
  useEffect(() => {
    if (
      fromLat == null ||
      fromLng == null ||
      toLat == null ||
      toLng == null ||
      !Number.isFinite(fromLat) ||
      !Number.isFinite(fromLng) ||
      !Number.isFinite(toLat) ||
      !Number.isFinite(toLng) ||
      isPrintRender()
    ) {
      return;
    }
    const a: LatLng = { lat: fromLat, lng: fromLng };
    const b: LatLng = { lat: toLat, lng: toLng };
    const key = cacheKey(a, b);
    const hit = cache.get(key);
    if (hit) {
      setResult(hit);
      return;
    }
    const ctrl = new AbortController();
    let live = true;
    void fetchDirections(a, b, ctrl.signal).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [fromLat, fromLng, toLat, toLng]);
  return result;
}
