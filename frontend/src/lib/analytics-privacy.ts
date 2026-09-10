/**
 * Analytics privacy guards (issue #21).
 *
 * Kiseki trip URLs carry SECRETS:
 *   /t/<id>            — the trip's opaque id. Since #64 the trip id is what a
 *                        public trip is readable by, so it *is* a capability:
 *                        it must not land in a third-party dashboard.
 *   /join/<claimToken> — grants a crew identity (strictly secret).
 *
 * Every analytics SDK records the page URL by default, so a naive install
 * silently exports each trip's link to a SaaS, where it lands in dashboards,
 * exports and support access.
 *
 * SCOPE MATTERS — and getting it wrong is the subtle part. A key-by-key guard on
 * `$current_url` is NOT enough: posthog-js derives several other URL-bearing
 * properties from the same address, independently. A live probe caught the raw
 * path surviving in:
 *     $pathname            /t/<id>/itinerary
 *     $initial_current_url (inside $set_once)   http://…/t/<id>/itinerary
 *     $initial_pathname    (inside $set_once)   /t/<id>/itinerary
 *     $referrer / $initial_referrer             carries the token onward
 * So the scrubber walks EVERY string in the event's property bags and rewrites
 * any value that carries a secret path, rather than trusting a key list. New
 * SDK properties therefore stay covered by construction.
 *
 * These functions are PURE (no SDK, no DOM) and unit-tested in
 * `analytics-privacy.test.ts`. Scrubbing runs in the SDK's `before_send` hook —
 * client-side, BEFORE the HTTP request, not as a vendor-UI display filter which
 * would filter after ingestion, when the secret is already stored.
 */

/** Properties that are URLs even when they carry no secret — they get their
 *  query string/fragment dropped (an e2e probe flag should not be ingested). */
export const SECRET_URL_PROPERTIES = [
  "$current_url",
  "$referrer",
  "$entry_url",
  "$exit_url",
  "$initial_current_url",
  "$initial_referrer",
] as const;

/** Path roots whose second segment is a secret capability. */
const SECRET_PATH_ROOTS = ["t", "join"];

/** Matches an absolute URL (`https://…`, `//host/…`) so output shape is preserved. */
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * Normalize a URL *or* a bare path, preserving which of the two it was:
 *
 *   https://x.io/t/<id>/itinerary?y=1  →  https://x.io/t/:token/itinerary
 *   /t/<id>/itinerary                  →  /t/:token/itinerary
 *   /join/<claimToken>                 →  /join/:token
 *
 * Shape preservation is not cosmetic: `$pathname` is a PATH to PostHog, so
 * returning an absolute URL there would corrupt its path breakdown.
 */
export function normalizeSecretPath(value: string, origin = "http://localhost"): string {
  let u: URL;
  try {
    u = new URL(value, origin);
  } catch {
    return value; // not URL-shaped — leave it alone rather than mangle it
  }
  // The query string and fragment can carry secrets too (and a referrer carries
  // one onward to the next origin's analytics), so they never ship.
  u.search = "";
  u.hash = "";
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && SECRET_PATH_ROOTS.includes(parts[0])) {
    parts[1] = ":token";
  }
  u.pathname = "/" + parts.join("/");
  return ABSOLUTE_URL_RE.test(value) ? u.toString() : u.pathname;
}

/**
 * The part of an event `before_send` hands us that we care about. Structural (and
 * `properties: unknown`) so this module stays SDK-free and needs no cast to line
 * up with the SDK's own `CaptureResult`.
 */
export interface ScrubbableEvent {
  properties?: unknown;
  $set?: unknown;
  $set_once?: unknown;
}

/** Rewrite every secret-bearing value in the event in place; returns the event. */
export function scrubSecretTokens<T extends ScrubbableEvent>(event: T): T {
  if (!event || typeof event !== "object") return event;
  scrubBag(event.properties);
  scrubBag(event.$set);
  scrubBag(event.$set_once);
  return event;
}

/** Walk one property bag, scrubbing strings (recursing into nested objects). */
function scrubBag(bag: unknown, depth = 0): void {
  if (!bag || typeof bag !== "object" || depth > 4) return;
  const record = bag as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value) {
      if (containsRawSecretPath(value) || isUrlProperty(key)) {
        record[key] = normalizeSecretPath(value);
      }
    } else if (value && typeof value === "object") {
      scrubBag(value, depth + 1);
    }
  }
}

function isUrlProperty(key: string): boolean {
  return (SECRET_URL_PROPERTIES as readonly string[]).includes(key);
}

/** True when a string still carries something that looks like a live secret path. */
export function containsRawSecretPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  for (const root of SECRET_PATH_ROOTS) {
    // The secret segment is whatever follows `/t/` or `/join/` — matched at the
    // start of a path or after a separator, and never the `:token` placeholder.
    const re = new RegExp(`(?:^|[/\\s"'=(])${root}/([^/\\s"')?#]+)`);
    const m = value.match(re);
    if (m && m[1] !== ":token") return true;
  }
  return false;
}
