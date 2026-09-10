import posthog from "posthog-js";
import type { BeforeSendFn } from "posthog-js";
import { normalizeSecretPath, scrubSecretTokens } from "./analytics-privacy";
import { currentConsent } from "./analytics-consent";

/**
 * PostHog project token + host (issue #21).
 *
 * The project token is a PUBLIC client-side ingest key — it ships in the browser
 * bundle by definition, exactly like the Auth0 domain/client id in `lib/auth.ts`,
 * and it grants no read access to the project. It is therefore baked in as the
 * default so a deploy needs no extra build plumbing; `VITE_POSTHOG_*` overrides
 * exist for local dev against another project. Rotating it = editing the constant.
 *
 * EU cloud: PostHog is configured for EU data residency (spec §8 GDPR posture).
 */
export const POSTHOG_KEY_DEFAULT = "phc_o83DzE5ak6qkeJiz7DqrstuZHtMvoVZ82px5fiDPfrKx";
export const POSTHOG_HOST_DEFAULT = "https://eu.i.posthog.com";

const posthogKey = import.meta.env.VITE_POSTHOG_KEY ?? POSTHOG_KEY_DEFAULT;
const posthogHost = import.meta.env.VITE_POSTHOG_HOST ?? POSTHOG_HOST_DEFAULT;

/**
 * True when a token is configured AND the visitor has granted consent. That is
 * what keeps local dev, forks, and un-consented visitors from shipping events —
 * and why every capture helper below is a no-op until then.
 */
export const isPostHogConfigured = Boolean(posthogKey && posthogHost);

/* ------------------------------------------------------------------ the hook
 * `before_send` runs client-side, BEFORE the event is sent, so a share token
 * never reaches PostHog. The scrubbing logic itself lives in
 * `analytics-privacy.ts` (pure + unit-tested) — this file only wires it up. */
export const beforeSend: BeforeSendFn = (cr) => (cr ? scrubSecretTokens(cr) : cr);

const SHARED_CONFIG = {
  api_host: posthogHost,
  defaults: "2026-05-30",

  // --- Privacy posture (issue #21) -----------------------------------------
  // Opt-in analytics behind the cookie banner (Niko: copy graph-explorer's).
  // The SDK itself only initializes after consent, so a declined visitor never
  // produces a single request. Within that: cookieless storage (no cookie, no
  // local/session storage), server-side daily-salted identity hash. Replay and
  // heatmaps are OFF everywhere: replay records the URL bar and the DOM —
  // private travel plans, crew names, booking codes. Global rather than
  // route-gated so no routing mistake can leak one.
  cookieless_mode: "always",
  disable_session_recording: true,
  capture_heatmaps: false,
  // We send pageviews ourselves (`capturePageview`) so the URL always passes
  // through the scrubber and can carry the trip id.
  capture_pageview: false,
  capture_pageleave: false,
  // Autocapture ships element text/attributes — trip *content* must never
  // reach the vendor (#21: navigation events only).
  autocapture: false,
  capture_dead_clicks: false,
  capture_performance: false,
  // Flags/surveys are unused, and /flags is a per-load request on a mobile
  // connection in a car park.
  advanced_disable_flags: true,
  disable_surveys: true,
  before_send: beforeSend,

  capture_exceptions: {
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,
  },
} satisfies Parameters<typeof posthog.init>[1];

/**
 * The trip the user is currently inside, set by `AnalyticsPageviews`. Buffered
 * until the SDK exists: after consent initializes PostHog, the buffered value
 * is applied so custom events immediately carry `trip_id` (#21: per-trip
 * metrics keyed on the trip `$dtId`, never on a token).
 */
let analyticsTripId: string | undefined;

export function setAnalyticsTrip(tripId?: string): void {
  analyticsTripId = tripId;
}

/** The visitor's identity, buffered the same way until consent lands. */
let pendingIdentity: { sub: string; name?: string } | null = null;

/**
 * Initialize PostHog — called ONLY from the consent gate (`CookieConsent` /
 * `main.tsx` restore path) after the visitor accepted, and on reload when the
 * stored choice is still "granted". The trip context is applied immediately so
 * the restored pageview carries the right trip.
 */
export function initAnalytics(): void {
  if (!isPostHogConfigured || posthog.__loaded) return;
  posthog.init(posthogKey, SHARED_CONFIG);
  if (analyticsTripId) {
    // The pageview for the current (pre-consent) navigation is captured here —
    // AnalyticsPageviews has already run and would otherwise never re-fire.
    capturePageview({ tripId: analyticsTripId });
  }
  if (pendingIdentity) {
    identifyUser(pendingIdentity.sub, pendingIdentity.name ? { name: pendingIdentity.name } : undefined);
    pendingIdentity = null;
  }
}

/**
 * `$pageview` with a scrubbed URL. Per-trip metrics are keyed on the trip's
 * opaque id (`$dtId`) passed as a property — never on anything derived from a
 * claim token.
 */
export function capturePageview(opts?: { tripId?: string }): void {
  if (!isPostHogConfigured || !posthog.__loaded) return;
  const props: Record<string, unknown> = {
    $current_url: normalizeSecretPath(window.location.href),
  };
  const tripId = opts?.tripId ?? analyticsTripId;
  if (tripId) props.trip_id = tripId;
  posthog.capture("$pageview", props);
}

/** A custom event; a no-op when PostHog is unconfigured or unconsented. An
 *  explicit `trip_id` in `props` wins over the ambient trip context. */
export function capture(name: string, props?: Record<string, unknown>): void {
  if (!isPostHogConfigured || !posthog.__loaded) return;
  const merged = analyticsTripId ? { trip_id: analyticsTripId, ...props } : props;
  posthog.capture(name, merged);
}

/** Identify the signed-in user by their Auth0 `sub` (never name/email as the key).
 *  Buffered pre-consent; applied once the visitor accepts. */
export function identifyUser(sub: string, props?: Record<string, unknown>): void {
  if (!isPostHogConfigured || !posthog.__loaded) {
    pendingIdentity = { sub, name: typeof props?.name === "string" ? props.name : undefined };
    return;
  }
  posthog.identify(sub, props);
}

/** Clear identity on sign-out so the next user on this browser is not merged. */
export function resetIdentity(): void {
  if (!isPostHogConfigured || !posthog.__loaded) return;
  posthog.reset();
}

/** True when the visitor has NOT answered the banner yet (drives its render). */
export function consentPending(): boolean {
  return currentConsent() === null;
}

/** True when the stored choice is "granted" — the consent-gate restore path. */
export function consentGranted(): boolean {
  return currentConsent() === "granted";
}

export { posthog };
