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
 * exports and support access. These functions are PURE (no SDK, no DOM) and are
 * unit-tested in `analytics-privacy.test.ts`, which asserts that no raw token can
 * survive into an outbound payload.
 *
 * Scrubbing runs in the SDK's `before_send` hook — client-side, BEFORE the HTTP
 * request. It is deliberately NOT a vendor-UI display filter: those filter after
 * ingestion, by which point the secret has already been stored.
 */

/** URL-bearing default properties stripped from every event. */
export const SECRET_URL_PROPERTIES = [
  "$current_url",
  "$referrer",
  "$entry_url",
  "$exit_url",
] as const;

/** Paths whose second segment is a secret capability. */
const SECRET_PATH_ROOTS = new Set(["t", "join"]);

/**
 * `/t/bf29a027-…/itinerary?x=1` → `/t/:token/itinerary`
 * `/join/ck_abc123`             → `/join/:token`
 *
 * The query string and fragment are dropped too: they can carry tokens (and an
 * outbound referrer carries the token on to the next origin's analytics).
 */
export function normalizeSecretPath(url: string, origin = "http://localhost"): string {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return url; // not URL-shaped — leave it alone rather than mangle it
  }
  u.search = "";
  u.hash = "";
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && SECRET_PATH_ROOTS.has(parts[0])) {
    parts[1] = ":token";
  }
  u.pathname = "/" + parts.join("/");
  return u.toString();
}

/**
 * The part of an event `before_send` hands us that we care about. Structural (and
 * `properties: unknown`) so this module stays SDK-free and needs no cast to line
 * up with the SDK's own `CaptureResult`.
 */
export interface ScrubbableEvent {
  properties?: unknown;
}

/** Rewrite every secret-bearing URL property in place; returns the same event. */
export function scrubSecretTokens<T extends ScrubbableEvent>(event: T): T {
  const props = event?.properties;
  if (!props || typeof props !== "object") return event;
  const record = props as Record<string, unknown>;
  for (const key of SECRET_URL_PROPERTIES) {
    const v = record[key];
    if (typeof v === "string" && v) {
      record[key] = normalizeSecretPath(v);
    }
  }
  return event;
}

/** True when a string still contains something that looks like a live secret path. */
export function containsRawSecretPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = value.match(/(?:^|[/\s"'(])(t|join)\/([^/\s"')?#]+)/);
  return Boolean(m && m[2] !== ":token");
}
