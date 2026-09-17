/**
 * The signed-in user's own photo for header chrome (follow-up to #320).
 *
 * The top-right account chip used to render the Auth0 session picture only,
 * so an uploaded Kiseki profile photo never appeared there. This module
 * resolves the Kiseki twin avatar once per login session and falls back to
 * the Auth0 picture — callers render `kiseki ?? auth0 ?? initials`.
 *
 * Session cache: one profile read per `sub` no matter how often the header
 * remounts across navigation. Failures resolve `null` (silent fallback —
 * the header must never break or redirect over a photo). After an
 * upload/remove, the profile page writes the fresh value through
 * `setMyAvatar` so the header follows without a reload.
 */
import { fetchUserProfile } from "./api";

const cache = new Map<string, Promise<string | null>>();

/** Kiseki avatar URL for `sub`, or `null` when there is none / it failed. */
export function myAvatar(
  sub: string,
  getAccessTokenSilently: () => Promise<string>,
): Promise<string | null> {
  let pending = cache.get(sub);
  if (!pending) {
    pending = getAccessTokenSilently()
      .then((at) => fetchUserProfile(sub, at))
      .then((doc) => doc.avatar ?? null)
      .catch(() => null);
    cache.set(sub, pending);
  }
  return pending;
}

/** Overwrite the cached value (upload/remove) — next read is the new photo. */
export function setMyAvatar(sub: string, avatar: string | null): void {
  cache.set(sub, Promise.resolve(avatar));
}

/** Test seam: drop the session cache between cases. */
export function clearMyAvatarCache(): void {
  cache.clear();
}
