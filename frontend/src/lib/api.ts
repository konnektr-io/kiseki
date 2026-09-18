import { authHeaders, hasCredential } from "./auth-headers";
import type { FeedDoc, PeopleList, Role, ShowcaseTrip, Trip, TripGeo, TripSummary, TricountSnapshot, UserProfile } from "./types";

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

/**
 * The signed-out landing's examples (#249): public, discoverable trips as cards.
 *
 * Anonymous by design — the server answers this without a token — and the repo
 * carries no trip data (AGENTS.md), so the front door reads the graph the same
 * way a visitor does rather than holding a hand-maintained list beside the code.
 *
 * It NEVER throws. This is a marketing page: a graph hiccup, a 500 or a body in
 * the wrong shape means the examples band collapses to nothing, not an error
 * state in front of someone who has not signed up yet. `[]` is a valid answer.
 */
export async function fetchShowcase(): Promise<ShowcaseTrip[]> {
  try {
    const res = await fetch("/api/showcase");
    if (!res.ok) return [];
    const body = (await res.json()) as { trips?: ShowcaseTrip[] };
    return Array.isArray(body.trips) ? body.trips : [];
  } catch {
    return [];
  }
}

export async function fetchTrip(param: string, accessToken?: string): Promise<Trip> {
  // The cache key carries whether the document was read with credentials: a
  // public trip fetched anonymously comes back WITHOUT `myRole`, and serving
  // that to a later authenticated read would strip the caller's role for the
  // rest of the session (the owner-only join link keys off it).
  const key = (id: string) => `${id}|${hasCredential(accessToken) ? "auth" : "anon"}`;
  const cached = tripCache.get(key(param));
  if (cached) return cached;
  const headers: Record<string, string> = {};
  Object.assign(headers, authHeaders(accessToken));
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

/**
 * Force a fresh read of one trip, bypassing the session cache — the agent
 * edits trips server-side while the SPA keeps the document it read at page
 * load, so a surface that must show agent edits (the chat drawer finishing a
 * turn) has to drop the cached copy first. Falls back to `fetchTrip`'s error
 * contract (TripAccessError) so callers keep the 401/403 handling.
 */
export async function refetchTrip(tripId: string, accessToken?: string): Promise<Trip> {
  tripCache.delete(`${tripId}|auth`);
  tripCache.delete(`${tripId}|anon`);
  return fetchTrip(tripId, accessToken);
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
      ...authHeaders(accessToken),
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
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const body = (await res.json()) as { trips: TripSummary[] };
  return body.trips;
}

/**
 * Anchor points for the signed-in home's map canvas (#249 E2).
 *
 * Authenticated (same actor as `fetchMyTrips`): one row per LISTABLE trip,
 * each with the first located registry entry as its anchor. It NEVER throws —
 * the home treats geo as an enhancement band (like feed/showcase): a failure
 * collapses the map instead of erroring the page. Rows that fail validation
 * are dropped, never invented: a pin the server did not list must never render.
 */
export async function fetchTripGeo(accessToken: string): Promise<TripGeo[]> {
  try {
    const res = await fetch("/api/trips/geo", {
      headers: authHeaders(accessToken),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { trips?: unknown };
    if (!body || !Array.isArray(body.trips)) return [];
    const out: TripGeo[] = [];
    for (const row of body.trips) {
      const geo = asTripGeo(row);
      if (geo) out.push(geo);
    }
    return out;
  } catch {
    return [];
  }
}

/** One geo row, validated — null when the row cannot honestly become a pin. */
function asTripGeo(row: unknown): TripGeo | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.dtId !== "string" || !r.dtId) return null;
  const anchor = r.anchor as Record<string, unknown> | null;
  if (typeof anchor !== "object" || anchor === null) return null;
  const { lat, lng, name } = anchor;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (typeof name !== "string") return null;
  if (r.origin !== "mine" && r.origin !== "discover") return null;
  if (typeof r.stage !== "string" || !r.stage) return null;
  return {
    dtId: r.dtId,
    title: typeof r.title === "string" ? r.title : "",
    stage: r.stage as TripGeo["stage"],
    anchor: { lat, lng, name },
    origin: r.origin,
  };
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
  Object.assign(headers, authHeaders(accessToken));
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
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const body = (await res.json()) as { joinUrl: string };
  return body.joinUrl;
}

/** Resolve the trip behind a FOLLOW token (#197) — read + follow, never a claim. */
export async function fetchTripByFollow(followToken: string): Promise<Trip> {
  const res = await fetch(`/api/trips/by-follow/${encodeURIComponent(followToken)}`);
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  return (await res.json()) as Trip;
}

/** Follow a PUBLIC trip with no invite at all (#197).
 *
 * `visibility: public` is the invitation: no link is involved, and a private
 * trip answers 403 ("can only be followed with an invite link") rather than
 * silently granting access. Idempotent server-side. */
export async function followPublicTrip(tripId: string, accessToken: string): Promise<Trip> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/follow`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  return (await res.json()) as Trip;
}

/** Owner-only: the trip's follow link (#197), or null when none was minted. */
export async function fetchFollowLink(
  tripId: string,
  accessToken: string,
): Promise<string | null> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/follow-link`, {
    headers: authHeaders(accessToken),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const body = (await res.json()) as { followUrl: string };
  return body.followUrl;
}

/** Owner-only: mint (or rotate) the follow link (#197).
 *
 * Minting twice rotates: the previous link stops resolving immediately, and
 * the crew invite is untouched — the two links revoke separately. */
export async function createFollowLink(tripId: string, accessToken: string): Promise<string> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/follow-link`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const body = (await res.json()) as { followUrl: string };
  return body.followUrl;
}

/** Owner-only: disable the crew invite (#197) — clears the claim token.
 *
 * Crew already on the trip and existing followers keep their access; what
 * stops is new claiming (and following) through the join link. The follow
 * link keeps working. */
export async function disableCrewInvite(tripId: string, accessToken: string): Promise<void> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/join-link`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
}

/** Follow a trip via a link credential (#65) — creates a follower role.
 *
 * `kind` picks WHICH credential is held: "claim" posts it as `claimToken`
 * (join link) and "follow" as `followToken` (#197, read + follow only). The
 * server rejects a body carrying both, so this is a real choice, not a hint. */
export async function followTrip(
  token: string,
  accessToken: string,
  kind: "claim" | "follow" = "claim",
): Promise<Trip> {
  const res = await fetch("/api/claims/follow", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(accessToken),
    },
    body: JSON.stringify(kind === "follow" ? { followToken: token } : { claimToken: token }),
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
  Object.assign(headers, authHeaders(accessToken));
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

/** Owner-only: delete the whole trip (#163). The endpoint answers 204 with
 *  NO body — there is no canonical document left to return — so this is a
 *  plain fetch, not `tripWrite`. On success the session cache drops every
 *  copy of the trip (both keys, both credential modes): a back-navigation
 *  must never resurrect a deleted document from memory. */
export async function deleteTrip(tripId: string, accessToken: string): Promise<void> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new TripAccessError(res.status, await apiErrorMessage(res));
  tripCache.delete(`${tripId}|anon`);
  tripCache.delete(`${tripId}|auth`);
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

export interface AddCrewMemberBody {
  name: string;
  role: Role;
  note?: string;
  contact?: string;
  /** Attach an ACCOUNT that already exists (its Auth0 sub) instead of creating
   *  an unclaimed placeholder — the "add someone I follow" path (#198
   *  follow-up). Owner-only server-side, and only for someone the caller
   *  follows; `contact` is refused with it (their profile owns it). */
  sub?: string;
}

/** Add a crew member (editor+ for a placeholder; `sub` is owner-only on the
 *  server). Returns the canonical trip doc. */
export async function addCrewMember(
  tripId: string,
  body: AddCrewMemberBody,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "POST",
    `/api/trips/${encodeURIComponent(tripId)}/crew`,
    accessToken,
    body as unknown as JsonBody,
  );
  cacheTrip(tripId, doc);
  return doc;
}

/** Remove a crew member (owner-only on the server). A placeholder Person twin
 *  is deleted with the edge; a claimed User twin survives — only the crew
 *  entry on this trip goes. Returns the canonical trip doc. */
export async function removeCrewMember(
  tripId: string,
  personId: string,
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "DELETE",
    `/api/trips/${encodeURIComponent(tripId)}/crew/${encodeURIComponent(personId)}`,
    accessToken,
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

/* ---------------- #296 ubiquitous title/notes edits ----------------
 * Exact payloads only (the server's write models are `extra="forbid"` —
 * never round-trip the whole trip object). Each returns the canonical doc. */

/** Patch one day's title/notes (date is calendar truth — never sent). */
export async function putTripDay(
  tripId: string,
  dayId: string,
  patch: { title?: string; notes?: string },
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "PUT",
    `/api/trips/${encodeURIComponent(tripId)}/days/${encodeURIComponent(dayId)}`,
    accessToken,
    patch,
  );
  cacheTrip(tripId, doc);
  return doc;
}

/** Rename one section chapter. */
export async function putTripSection(
  tripId: string,
  sectionId: string,
  patch: { title: string },
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "PUT",
    `/api/trips/${encodeURIComponent(tripId)}/sections/${encodeURIComponent(sectionId)}`,
    accessToken,
    patch,
  );
  cacheTrip(tripId, doc);
  return doc;
}

/** Patch one practical block by list position (value object, no id — #273). */
export async function putPracticalBlock(
  tripId: string,
  index: number,
  patch: { title?: string; body?: string },
  accessToken: string,
): Promise<Trip> {
  const doc = await tripWrite(
    "PUT",
    `/api/trips/${encodeURIComponent(tripId)}/practical/blocks/${index}`,
    accessToken,
    patch,
  );
  cacheTrip(tripId, doc);
  return doc;
}

/* ---------------- #196d user profiles ----------------
 * Read: GET /api/users/{sub} (any valid token; 404 when that sub has no
 * User twin) + the followers/following drill-ins (true-total `count`,
 * max 200 entries). Writes (follow/unfollow/ensure/publicName) are
 * user-token-only on the server (M2M refused 403). `{sub}` is the bare
 * Auth0 subject — always URL-encoded when building a path. */

async function profileRequest<T>(
  method: string,
  path: string,
  accessToken: string,
  body?: JsonBody,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(accessToken),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new TripAccessError(res.status, await apiErrorMessage(res));
  return (await res.json()) as T;
}

/* ---------------- #199 activity feed ---------------- */

/**
 * The caller's own feed: their trips plus the DISCOVERABLE trips of the people
 * they follow, newest write first. Token-only — there is no anonymous or
 * `?sub=` variant — so a signed-out visitor gets a sign-in CTA, not data.
 * `before` is the previous page's `nextBefore` cursor (the server answers 422
 * on a non-ISO value).
 */
export async function fetchFeed(accessToken: string, before?: string | null): Promise<FeedDoc> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  return profileRequest<FeedDoc>("GET", `/api/feed${query}`, accessToken);
}

/** The profile document — trips already filtered server-side to the
 *  discoverable-only listing rule. Rendered verbatim. */
export async function fetchUserProfile(sub: string, accessToken: string): Promise<UserProfile> {
  return profileRequest<UserProfile>(
    "GET",
    `/api/users/${encodeURIComponent(sub)}`,
    accessToken,
  );
}

/** Followers drill-in for a profile (same 404 contract as the profile). */
export async function fetchUserFollowers(
  sub: string,
  accessToken: string,
): Promise<PeopleList> {
  return profileRequest<PeopleList>(
    "GET",
    `/api/users/${encodeURIComponent(sub)}/followers`,
    accessToken,
  );
}

/** Following drill-in for a profile. */
export async function fetchUserFollowing(
  sub: string,
  accessToken: string,
): Promise<PeopleList> {
  return profileRequest<PeopleList>(
    "GET",
    `/api/users/${encodeURIComponent(sub)}/following`,
    accessToken,
  );
}

/** Follow a person — one-directional, grants NO trip access. 400 on
 *  self-follow, 404 when the target has no twin. */
export async function followUser(
  sub: string,
  accessToken: string,
): Promise<{ sub: string; following: boolean }> {
  return profileRequest("POST", `/api/users/${encodeURIComponent(sub)}/follow`, accessToken);
}

/** Unfollow a person (idempotent — a 200 no-op when not following). */
export async function unfollowUser(
  sub: string,
  accessToken: string,
): Promise<{ sub: string; following: boolean }> {
  return profileRequest("DELETE", `/api/users/${encodeURIComponent(sub)}/follow`, accessToken);
}

/** Idempotent: provisions the caller's User twin so they are reachable at
 *  a profile before ever claiming crew on a trip. `ensured: false` when
 *  the token carries no usable email (the SPA keeps working); a graph
 *  failure is a 503, never disguised. */
export async function ensureMe(accessToken: string): Promise<{
  sub: string;
  ensured: boolean;
  name?: string;
  email?: string;
  reason?: string;
}> {
  return profileRequest("POST", "/api/me/ensure", accessToken);
}

/** Flip the caller's own `User.publicName` opt-in — the ONLY accepted
 *  field (anything else is a server-side 422). */
export async function setPublicName(
  publicName: boolean,
  accessToken: string,
): Promise<{ sub: string; ensured: boolean; publicName: boolean }> {
  return profileRequest("PUT", "/api/me", accessToken, { publicName });
}

/** The `PUT /api/me` answer: the ensure shape plus the new profile values.
 *  `avatar` rides along only when the twin carries one. */
export interface MeProfile {
  sub: string;
  ensured: boolean;
  name: string;
  displayName: string;
  email: string;
  publicName: boolean;
  avatar?: string;
}

/** Rename the caller's own profile (`displayName`, Kiseki-only — never
 *  pushed back to Auth0) and/or flip `publicName`. At least one knob must
 *  be present; anything else is a server-side 422. The photo is NOT edited
 *  here — `uploadMyAvatar` / `deleteMyAvatar` own it. */
export async function updateMyProfile(
  patch: { displayName?: string; publicName?: boolean },
  accessToken: string,
): Promise<MeProfile> {
  return profileRequest<MeProfile>("PUT", "/api/me", accessToken, patch);
}

/** Upload the caller's profile photo — a client-side square-cropped JPEG/
 *  PNG blob (see `lib/avatar-crop`). Answers the public serve URL the
 *  profile reads back. A plain `<form>` cannot send the bearer token, so
 *  this posts `FormData` with `fetch` like `downloadMyExport` does. */
export async function uploadMyAvatar(
  photo: Blob,
  accessToken: string,
): Promise<{ sub: string; avatar: string }> {
  const form = new FormData();
  form.append("file", photo, "avatar.jpg");
  const res = await fetch("/api/me/avatar", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: form,
  });
  if (!res.ok) throw new TripAccessError(res.status, await apiErrorMessage(res));
  return (await res.json()) as { sub: string; avatar: string };
}

/** Remove the caller's uploaded photo — falls back to the IdP photo when
 *  the provider has one, else the monogram. Answers `avatar: null` in the
 *  monogram case. */
export async function deleteMyAvatar(
  accessToken: string,
): Promise<{ sub: string; avatar: string | null }> {
  const res = await fetch("/api/me/avatar", {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new TripAccessError(res.status, await apiErrorMessage(res));
  return (await res.json()) as { sub: string; avatar: string | null };
}

/* ---------------- #196e account: export + erasure ----------------
 * GDPR art. 20 (export) and art. 17 (erasure). Both are user-token-only
 * on the server (M2M refused 403) and 404 when the caller has no User
 * twin. Frontend-only phase: no backend or contract change here. */

/** One trip blocking account deletion (the server names them on 409). */
export interface OwnedTripRef {
  dtId: string;
  title: string;
  slug: string;
}

/** Thrown by `deleteMyAccount` on 409: the caller still owns trips, so
 *  nothing was deleted. Carries the server's message + the blocking list
 *  (lives at `detail.ownedTrips` in the wire body). */
export class AccountDeleteBlockedError extends TripAccessError {
  ownedTrips: OwnedTripRef[];
  constructor(message: string, ownedTrips: OwnedTripRef[]) {
    super(409, message);
    this.ownedTrips = ownedTrips;
  }
}

/** Download the caller's portability document (GDPR art. 20).
 *
 *  A plain `<a href>` cannot send the `Authorization` header, so — like
 *  `downloadBooklet` — this fetches with the bearer token and saves a
 *  blob. The document is complete with no query knobs. */
export async function downloadMyExport(accessToken: string): Promise<void> {
  const res = await fetch("/api/me/export", {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new TripAccessError(res.status, await apiErrorMessage(res));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kiseki-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Erase the caller's account (GDPR art. 17). IRREVERSIBLE — the caller
 *  (AccountPanel) owns the slow confirmation, not this function.
 *
 *  Success answers `{"deleted": <summary>}` (shape `dict` — read keys
 *  defensively). 409 throws `AccountDeleteBlockedError` (nothing deleted);
 *  a second call after success 404s (already gone — not a failure to
 *  panic about). */
export async function deleteMyAccount(
  accessToken: string,
): Promise<{ deleted: Record<string, unknown> }> {
  const res = await fetch("/api/me", {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (res.ok) {
    return (await res.json()) as { deleted: Record<string, unknown> };
  }
  // The body may only be read once — capture it, then interpret.
  const text = await res.text();
  if (res.status === 409) {
    try {
      const body = JSON.parse(text) as {
        detail?: { message?: unknown; ownedTrips?: unknown };
      };
      const detail = body.detail;
      if (detail && typeof detail === "object") {
        const message =
          typeof detail.message === "string" ? detail.message : "You still own trips.";
        const raw = Array.isArray(detail.ownedTrips) ? detail.ownedTrips : [];
        const ownedTrips: OwnedTripRef[] = raw
          .filter(
            (t): t is Record<string, unknown> =>
              typeof t === "object" && t !== null,
          )
          .map((t) => ({
            dtId: typeof t.dtId === "string" ? t.dtId : "",
            title: typeof t.title === "string" ? t.title : "",
            slug: typeof t.slug === "string" ? t.slug : "",
          }))
          .filter((t) => t.dtId);
        throw new AccountDeleteBlockedError(message, ownedTrips);
      }
    } catch (e) {
      if (e instanceof AccountDeleteBlockedError) throw e;
      // Not the documented shape — fall through to the generic error below.
    }
  }
  let message = text || `Request failed (${res.status})`;
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") message = body.detail;
  } catch {
    // not JSON — keep the raw text
  }
  throw new TripAccessError(res.status, message);
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
    { headers: authHeaders(accessToken) },
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
