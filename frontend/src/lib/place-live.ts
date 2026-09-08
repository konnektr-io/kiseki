import { useEffect, useState } from "react";

/**
 * Live Google place overlay (#95) — rating, review snippets, photo metadata.
 *
 * The browser never talks to Google: everything goes through the backend
 * proxies (`/api/places/details/{place_id}`, `/api/places/photo`) so the
 * Places key stays server-side (same trust pattern as the HERE proxies).
 * Nothing Google-derived is ever stored — the payload lives in this React
 * state and in the backend's short-TTL display caches only (#15/#95).
 */

export interface PlaceLiveReview {
  text?: string;
  authorName?: string;
  authorUri?: string;
  relativePublishTimeDescription?: string;
  googleMapsUri?: string;
}

export interface PlaceLivePhoto {
  name?: string;
  widthPx?: number;
  heightPx?: number;
  authorAttributions?: { displayName?: string }[];
}

export interface PlaceLiveDetails {
  available: boolean;
  placeId: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  reviews?: PlaceLiveReview[];
  photos?: PlaceLivePhoto[];
}

/** Proxy URL for one Google place photo (ref = the photo resource name the
 *  details payload carries; the backend validates the shape and resolves the
 *  ephemeral keyless media URL — never a keyed URL in the browser). */
export function placePhotoUrl(ref: string): string {
  return `/api/places/photo?ref=${encodeURIComponent(ref)}`;
}

/**
 * Fetch-on-mount overlay details for a stored place_id. Null while loading
 * and when Google has nothing (graceful absence — the card renders exactly
 * as before).
 *
 * Never fetched for print: the booklet PDF renders under emulated print
 * media (pdf.py sets `emulate_media(print)` before the page loads), and a
 * browser Ctrl+P flips the same media query. The overlay is web-only; the
 * `no-print` wrapper in PlaceFacts is the second belt.
 */
export function usePlaceLive(placeId: string | null | undefined): PlaceLiveDetails | null {
  const [details, setDetails] = useState<PlaceLiveDetails | null>(null);
  const id = placeId ?? null;
  useEffect(() => {
    if (!id) return;
    if (typeof window !== "undefined" && window.matchMedia("print").matches) return;
    let alive = true;
    setDetails(null);
    fetch(`/api/places/details/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d) => {
        if (alive && d?.available) setDetails(d as PlaceLiveDetails);
      })
      .catch(() => {
        /* overlay stays absent — the card is complete without it */
      });
    return () => {
      alive = false;
    };
  }, [id]);
  return details;
}
