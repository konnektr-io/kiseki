import type { Trip, TripSummary } from "./types";

/**
 * Trip $dtIds are opaque UUIDs (dashed); share tokens are NOT. The SPA routes
 * both through /t/<param>: a UUID goes to the PROTECTED endpoint (JWT + ACL),
 * anything else is a secret share link → the public endpoint.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isTripId = (param: string) => UUID_RE.test(param);

export class TripAccessError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Extract a readable message from an API error body ({"detail": "..."}). */
async function apiErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // not JSON — fall through to the raw text
  }
  return text || `Request failed (${res.status})`;
}

export async function fetchTrip(param: string, accessToken?: string): Promise<Trip> {
  const cached = tripCache.get(param);
  if (cached) return cached;
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`/api/trips/${encodeURIComponent(param)}`, { headers });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const trip = (await res.json()) as Trip;
  // Keep the trip in memory for the rest of the session: navigating between
  // the token route and the id route (and back from the landing) must not
  // re-fetch the same document. A full page load clears it naturally.
  tripCache.set(param, trip);
  tripCache.set(trip.id, trip);
  return trip;
}

/** Session-scoped trip documents (immutable during a visit). */
const tripCache = new Map<string, Trip>();

export function clearTripCache(): void {
  tripCache.clear();
}

/** Resolve the trip behind a claim token (join link) — the 'invite' view. */
export async function fetchTripByClaim(claimToken: string): Promise<Trip> {
  const res = await fetch(`/api/trips/by-claim/${encodeURIComponent(claimToken)}`);
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  return (await res.json()) as Trip;
}

/** Claim a crew identity on the trip behind a claim token (issue #6). */
export async function claimIdentity(
  claimToken: string,
  personId: string,
  accessToken: string,
): Promise<Trip> {
  const res = await fetch("/api/claims", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ claimToken, personId }),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  return (await res.json()) as Trip;
}

/** The caller's trips (issue #7 — logged-in landing). */
export async function fetchMyTrips(accessToken: string): Promise<TripSummary[]> {
  const res = await fetch("/api/trips", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const body = (await res.json()) as { trips: TripSummary[] };
  return body.trips;
}

/** Download the crew-only PDF booklet (issue #13): the endpoint is the
 *  protected id route, so the access token rides in the Authorization header
 *  and the file is saved via a blob (a plain <a href> can't send headers). */
export async function downloadBooklet(
  tripId: string,
  accessToken: string,
  filename: string,
): Promise<void> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/booklet.pdf`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Owner-only: the trip's join link (claimToken is never in trip documents). */
export async function fetchJoinLink(tripId: string, accessToken: string): Promise<string> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/join-link`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const body = (await res.json()) as { joinUrl: string };
  return body.joinUrl;
}

export const bookletUrl = (token: string) => `/api/trips/${encodeURIComponent(token)}/booklet.pdf`;
