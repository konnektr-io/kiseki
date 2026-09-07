/**
 * Canonical Google Maps deep links (issues #15, #95).
 *
 * The deep-link form is a public Google URL spec — no API key, no fetch, no
 * photo/review hotlinking. Mirrored 1:1 by `backend/app/maps_links.py`;
 * both must produce the same URL for the same inputs (pinned by
 * `gmaps.test.ts` + `tests/test_maps_links.py`).
 *
 * Deliberately no server round-trip: the URL shape needs no secret and never
 * changes per user, so the client builds it directly (the `/api/maps/route`
 * proxy stays the only server-side maps call, #27).
 */
export interface GmapsTarget {
  /** Google place_id — preferred deep-link key when present. */
  placeId?: string | null;
  /** Precise venue query (the block's `mapsQuery`). */
  query?: string | null;
}

export function gmapsSearchUrl(name: string, target: GmapsTarget = {}): string {
  const params = new URLSearchParams({ api: "1" });
  if (target.placeId) {
    params.set("query", name);
    params.set("query_place_id", target.placeId);
  } else if (target.query) {
    params.set("query", target.query);
  } else {
    params.set("query", name);
  }
  return `https://www.google.com/maps/search/?${params.toString()}`;
}
