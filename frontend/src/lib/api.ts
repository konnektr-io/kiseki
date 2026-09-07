import type { Role, Trip, TripSummary, TricountSnapshot } from "./types";

/**
 * Single trip route since #64: /api/trips/{tripId} (visibility-gated).
 * Trip $dtIds are opaque dashed UUIDs. Public trips are readable
 * anonymously; private trips require a valid token + follower+ crew role (#65).
 */
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
  // The cache key carries whether the document was read with credentials: a
  // public trip fetched anonymously comes back WITHOUT `myRole`, and serving
  // that to a later authenticated read would strip the caller's role for the
  // rest of the session (the owner-only join link keys off it).
  const key = (id: string) => `${id}|${accessToken ? "auth" : "anon"}`;
  const cached = tripCache.get(key(param));
  if (cached) return cached;
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`/api/trips/${encodeURIComponent(param)}`, { headers });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const trip = (await res.json()) as Trip;
  // Keep the trip in memory for the rest of the session: navigating between
  // trip pages (and back from the landing) must not re-fetch the same
  // document. A full page load clears it naturally.
  tripCache.set(key(param), trip);
  tripCache.set(key(trip.id), trip);
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

/** Download the trip PDF booklet (#13): visibility-gated — public trips allow
 *  anonymous download, private trips require a bearer token. Uses a blob so
 *  the Authorization header can be sent (plain &lt;a href&gt; cannot). */
export async function downloadBooklet(
  tripId: string,
  accessToken: string | undefined,
  filename: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/booklet.pdf`, {
    headers,
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

/** Follow a trip via its claimToken (#65) — creates a follower role. */
export async function followTrip(claimToken: string, accessToken: string): Promise<Trip> {
  const res = await fetch("/api/claims/follow", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ claimToken }),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  return (await res.json()) as Trip;
}

export const bookletUrl = (tripId: string) => `/api/trips/${encodeURIComponent(tripId)}/booklet.pdf`;

/* ---------------- #46 write-path client (role-gated; editor+) ----------------
 * Every write endpoint returns the canonical trip document. Callers layer the
 * optimistic-update + rollback loop (lib/useTripWrite) on top; these functions
 * only ship bytes and refresh the session cache. */

type JsonBody = Record<string, unknown>;

async function tripWrite<T = Trip>(
  method: string,
  path: string,
  accessToken: string,
  body?: JsonBody,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new TripAccessError(res.status, await apiErrorMessage(res));
  return (await res.json()) as T;
}

/** A successful write retires the anonymous copies and refreshes the authed
 *  ones under both the param key and the doc id key, so back-navigation and
 *  remounts see the fresh document. */
function cacheTrip(tripId: string, doc: Trip): void {
  tripCache.delete(`${tripId}|anon`);
  tripCache.delete(`${doc.id}|anon`);
  tripCache.set(`${tripId}|auth`, doc);
  tripCache.set(`${doc.id}|auth`, doc);
}

export async function putTrip(
  tripId: string,
  patch: JsonBody,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite("PUT", `/api/trips/${encodeURIComponent(tripId)}`, accessToken, patch);
  cacheTrip(tripId, doc);
  return doc;
}

export async function toggleTodoItem(
  tripId: string,
  index: number,
  done: boolean,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "POST",
    `/api/trips/${encodeURIComponent(tripId)}/practical/todos/${index}/toggle`,
    accessToken,
    { done },
  );
  cacheTrip(tripId, doc);
  return doc;
}

export interface CrewPatch {
  role?: Role;
  note?: string | null;
}

/** Patch a crew member's trip-scoped fields (role/note — role owner-only on
 *  the server, note editor+). Returns the canonical trip doc. */
export async function patchCrewMember(
  tripId: string,
  personId: string,
  patch: CrewPatch,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "PATCH",
    `/api/trips/${encodeURIComponent(tripId)}/crew/${encodeURIComponent(personId)}`,
    accessToken,
    patch as JsonBody,
  );
  cacheTrip(tripId, doc);
  return doc;
}

export async function putTripBlock(
  tripId: string,
  blockId: string,
  fields: JsonBody,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "PUT",
    `/api/trips/${encodeURIComponent(tripId)}/blocks/${encodeURIComponent(blockId)}`,
    accessToken,
    fields,
  );
  cacheTrip(tripId, doc);
  return doc;
}

export async function deleteTripBlock(
  tripId: string,
  blockId: string,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "DELETE",
    `/api/trips/${encodeURIComponent(tripId)}/blocks/${encodeURIComponent(blockId)}`,
    accessToken,
  );
  cacheTrip(tripId, doc);
  return doc;
}

export interface BlockContainerRef {
  type: "day" | "section";
  id: string;
}

/** Promote/demote a block between a section (unscheduled pool) and a day
 *  (§7.5 — "schedule this"). Server appends unless `index` is given. */
export async function moveTripBlock(
  tripId: string,
  blockId: string,
  container: BlockContainerRef,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "POST",
    `/api/trips/${encodeURIComponent(tripId)}/blocks/${encodeURIComponent(blockId)}/move`,
    accessToken,
    { container },
  );
  cacheTrip(tripId, doc);
  return doc;
}

export async function putContainerOrder(
  tripId: string,
  containerId: string,
  blockIds: string[],
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "PUT",
    `/api/trips/${encodeURIComponent(tripId)}/containers/${encodeURIComponent(containerId)}/block-order`,
    accessToken,
    { block_ids: blockIds },
  );
  cacheTrip(tripId, doc);
  return doc;
}

/* ---------------- #111 Tricount (crew-only) ---------------- */

/** Live (TTL-cached) expense snapshot from the trip's connected Tricount
 *  registry. Requires viewer+ (crew); the panel never renders for others. */
export async function fetchTricountSnapshot(
  tripId: string,
  accessToken: string,
  refresh = false,
): Promise<TricountSnapshot> {
  const res = await fetch(
    `/api/trips/${encodeURIComponent(tripId)}/practical/tricount${refresh ? "?refresh=true" : ""}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  return (await res.json()) as TricountSnapshot;
}

/** Owner-only: connect the trip to a Tricount registry (sharing URL or bare
 *  key). Returns the canonical trip doc; the panel keys off
 *  `practical.tricount`. */
export async function connectTricount(
  tripId: string,
  registryKey: string,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "POST",
    `/api/trips/${encodeURIComponent(tripId)}/practical/tricount/connect`,
    accessToken,
    { registryKey },
  );
  cacheTrip(tripId, doc);
  return doc;
}

/** Owner-only: remove the Tricount connection (idempotent). */
export async function disconnectTricount(
  tripId: string,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "DELETE",
    `/api/trips/${encodeURIComponent(tripId)}/practical/tricount`,
    accessToken,
  );
  cacheTrip(tripId, doc);
  return doc;
}
