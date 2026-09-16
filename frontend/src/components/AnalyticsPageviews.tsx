import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { capturePageleave, capturePageview, setAnalyticsTrip } from "../lib/posthog";

/**
 * Route-level pageview capture for the SPA (issue #21), and the matching
 * `$pageleave` that PostHog's web analytics pairs it with (#295).
 *
 * The SDK's built-in `$pageview` is disabled (`capture_pageview: false`) so this
 * component owns what ships: the URL goes through `before_send` →
 * `normalizeSecretPath` (so `/t/<id>` becomes `/t/:token`), and the trip is
 * identified by its opaque `$dtId` as a PROPERTY instead of by the path.
 *
 * What we want to learn (#21): does "≤2 taps to today's plan" hold, how deep do
 * share links get opened, mobile vs desktop, booklet downloads, and which pages
 * people actually use. All page-level facts, so one pageview per navigation is
 * the entire instrument for them — but only half of it works without the leave:
 * bounce rate, session duration and scroll depth are all computed from the pair.
 * `capture_pageleave` is off in the SDK for the same reason as `capture_pageview`
 * (see `lib/posthog.ts`), so we emit both, at the two moments PostHog documents
 * for a hand-rolled setup — a route change here, and leaving the page below.
 */
export function AnalyticsPageviews() {
  const { pathname } = useLocation();

  // Trip id straight off the path. Deliberately not `useParams`: this component
  // mounts outside the trip Route, and on `/join/<claimToken>` there is no trip
  // id to report — the claim token must never be sent, not even as a key.
  const segments = pathname.split("/").filter(Boolean);
  const tripId = segments[0] === "t" ? segments[1] : undefined;

  // Skip a re-render that did not move the user (StrictMode double-invokes
  // effects in dev, which would otherwise double-count every pageview).
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    const first = lastPath.current === null;
    const moved = lastPath.current !== pathname;
    // Close the page we are leaving BEFORE the next one opens, so its
    // `$pageleave` carries the trip that page belonged to — `setAnalyticsTrip`
    // below has not run yet, so the ambient trip is still the old one. No-op on
    // the first render (nothing is open yet); `capturePageleave` owns the rest of
    // the pairing rule.
    if (!first && moved) capturePageleave();
    // Keep the ambient trip context in sync even when the path did not change
    // (e.g. a redirect that lands on the same URL), so custom events raised
    // elsewhere always carry the right trip.
    setAnalyticsTrip(tripId);
    if (!moved) return;
    lastPath.current = pathname;
    capturePageview(tripId ? { tripId } : undefined);
  }, [pathname, tripId]);

  // The other half of a manual setup: leaving the page. `pagehide` is what the
  // SDK itself listens on (not `beforeunload`, which mobile Safari may skip), and
  // this component lives for the whole app, so the listener is registered once
  // and survives every route change.
  useEffect(() => {
    const onPageHide = () => capturePageleave();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  return null;
}
