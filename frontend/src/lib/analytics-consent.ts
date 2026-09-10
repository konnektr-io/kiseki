/**
 * Analytics consent storage (issue #21).
 *
 * PostHog initialization is OPT-IN: the cookie banner ("Anonymous analytics")
 * writes the visitor's choice here, and `lib/posthog.ts` initializes the SDK
 * only when the choice is "granted". Until then every capture helper is a no-op
 * and no request ever reaches PostHog — the probe asserts that zero events ship
 * without consent.
 *
 * The choice itself is a STRICTLY-NECESSARY cookie (ePrivacy exempts storage
 * that records a consent decision — it is not tracking), which is why it may be
 * written before any consent exists. Same pattern as graph-explorer's
 * `cookie-consent.tsx` (Niko: copy that banner), minus the misleading copy: our
 * analytics is cookieless, so the banner says so instead of "we use cookies".
 */

export type ConsentChoice = "granted" | "denied";

/** Cookie name — deliberately not `cookieConsent` (shared name collisions). */
export const CONSENT_COOKIE = "kiseki_consent";

/** A year, then ask again (preferences can change; PostHog config may too). */
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Parse a serialized cookie jar for our consent decision. Pure — unit-tested. */
export function parseConsent(cookieHeader: string): ConsentChoice | null {
  for (const part of (cookieHeader || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === CONSENT_COOKIE) {
      return value === "granted" || value === "denied" ? value : null;
    }
  }
  return null;
}

/** Serialize the Set-Cookie body for a choice. Pure — unit-tested. */
export function consentCookieValue(choice: ConsentChoice): string {
  return `${CONSENT_COOKIE}=${choice}; max-age=${ONE_YEAR}; path=/; SameSite=Lax`;
}

/** The visitor's stored choice, or null when they have not been asked. */
export function currentConsent(): ConsentChoice | null {
  try {
    return parseConsent(document.cookie);
  } catch {
    return null; // storage blocked — treat as undecided, never as granted
  }
}

/** Persist the choice and return the cookie string written (for tests/spy). */
export function storeConsent(choice: ConsentChoice): string {
  const cookie = consentCookieValue(choice);
  try {
    document.cookie = cookie;
  } catch {
    // Storage blocked (private mode, hardening extensions): the in-memory
    // choice still applies for this page load via setAnalyticsConsent.
  }
  return cookie;
}
