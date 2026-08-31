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

export const bookletUrl = (token: string) => `/api/trips/${encodeURIComponent(token)}/booklet.pdf`;
