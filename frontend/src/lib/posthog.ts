import posthog from "posthog-js";
import type { BeforeSendFn } from "posthog-js";
import { normalizeSecretPath, scrubSecretTokens } from "./analytics-privacy";

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
 * Analytics is OFF unless a token is present. That is what keeps local dev,
 * preview builds and any fork from shipping events into the real project — and
 * it is why every capture helper below is a no-op when this is false.
 */
export const isPostHogConfigured = Boolean(posthogKey && posthogHost);

/* ------------------------------------------------------------------ the hook
 * `before_send` runs client-side, BEFORE the event is sent, so a share token
 * never reaches PostHog. The scrubbing logic itself lives in
 * `analytics-privacy.ts` (pure + unit-tested) — this file only wires it up. */
export const beforeSend: BeforeSendFn = (cr) => (cr ? scrubSecretTokens(cr) : cr);

if (isPostHogConfigured) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    defaults: "2026-05-30",

    // --- Privacy posture (issue #21) ---------------------------------------
    // Cookieless: no cookie, no localStorage, no sessionStorage, so no consent
    // banner is required under ePrivacy. Distinct IDs are a server-side hash
    // (team_id, daily_salt, ip, ua, hostname) and the IP is dropped before
    // enrichment. Accepted trade-off: a returning visitor counts as new each
    // day, and there is no GeoIP/bot enrichment — fine for "which pages do
    // people use", not for long cross-day funnels.
    cookieless_mode: "always",
    // Session replay and heatmaps are OFF everywhere. A replay records the URL
    // bar and the DOM — i.e. private travel plans, crew names and booking
    // codes. Global rather than route-gated so no routing mistake can leak one.
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
  });
}

/* ------------------------------------------------------------------ captures */

/**
 * The trip the user is currently inside, set by `AnalyticsPageviews`. Every
 * custom event then carries `trip_id` automatically, so per-trip funnels work
 * without every call site remembering to pass it (#21: per-trip metrics keyed on
 * the trip `$dtId`, never on a token).
 */
let analyticsTripId: string | undefined;

export function setAnalyticsTrip(tripId?: string): void {
  analyticsTripId = tripId;
}

/**
 * `$pageview` with a scrubbed URL. Per-trip metrics are keyed on the trip's
 * opaque id (`$dtId`) passed as a property — never on anything derived from a
 * claim token.
 */
export function capturePageview(opts?: { tripId?: string }): void {
  if (!isPostHogConfigured) return;
  const props: Record<string, unknown> = {
    $current_url: normalizeSecretPath(window.location.href),
  };
  const tripId = opts?.tripId ?? analyticsTripId;
  if (tripId) props.trip_id = tripId;
  posthog.capture("$pageview", props);
}

/** A custom event; a no-op when PostHog is unconfigured. An explicit `trip_id`
 *  in `props` wins over the ambient trip context. */
export function capture(name: string, props?: Record<string, unknown>): void {
  if (!isPostHogConfigured) return;
  const merged = analyticsTripId ? { trip_id: analyticsTripId, ...props } : props;
  posthog.capture(name, merged);
}

/** Identify the signed-in user by their Auth0 `sub` (never name/email as the key). */
export function identifyUser(sub: string, props?: Record<string, unknown>): void {
  if (!isPostHogConfigured) return;
  posthog.identify(sub, props);
}

/** Clear identity on sign-out so the next user on this browser is not merged. */
export function resetIdentity(): void {
  if (!isPostHogConfigured) return;
  posthog.reset();
}

export { posthog };
