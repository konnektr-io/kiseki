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

export interface GmapsDirectionsTarget {
  /** Google place_id of the origin — sent as `origin_place_id` alongside the
   *  plain `origin` query (the query stays: the id alone is not human-readable
   *  and older clients ignore the id params). */
  originPlaceId?: string | null;
  /** Google place_id of the destination — `destination_place_id`. */
  destinationPlaceId?: string | null;
  /** Defaults to driving (the only mode drive cards render). */
  travelMode?: string;
}

/**
 * Keyless Google Maps directions deep link (same public URL spec as the
 * search form above — no key, no fetch). Frontend-only: drive cards are a web
 * surface, so `backend/app/maps_links.py` has no mirror for this one.
 */
export function gmapsDirectionsUrl(
  origin: string,
  destination: string,
  target: GmapsDirectionsTarget = {},
): string {
  const params = new URLSearchParams({ api: "1", origin, destination });
  if (target.originPlaceId) params.set("origin_place_id", target.originPlaceId);
  if (target.destinationPlaceId) params.set("destination_place_id", target.destinationPlaceId);
  params.set("travelmode", target.travelMode ?? "driving");
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
