import type { Trip } from "./types";

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

export async function fetchTrip(param: string, accessToken?: string): Promise<Trip> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`/api/trips/${encodeURIComponent(param)}`, { headers });
  if (!res.ok) {
    throw new TripAccessError(res.status, await res.text());
  }
  return (await res.json()) as Trip;
}

/** Resolve the trip behind a claim token (join link) — the 'invite' view. */
export async function fetchTripByClaim(claimToken: string): Promise<Trip> {
  const res = await fetch(`/api/trips/by-claim/${encodeURIComponent(claimToken)}`);
  if (!res.ok) {
    throw new TripAccessError(res.status, await res.text());
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
    throw new TripAccessError(res.status, await res.text());
  }
  return (await res.json()) as Trip;
}

/** Owner-only: the trip's join link (claimToken is never in trip documents). */
export async function fetchJoinLink(tripId: string, accessToken: string): Promise<string> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/join-link`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await res.text());
  }
  const body = (await res.json()) as { joinUrl: string };
  return body.joinUrl;
}

export const bookletUrl = (token: string) => `/api/trips/${encodeURIComponent(token)}/booklet.pdf`;
