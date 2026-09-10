import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { capturePageview, setAnalyticsTrip } from "../lib/posthog";

/**
 * Route-level pageview capture for the SPA (issue #21).
 *
 * The SDK's built-in `$pageview` is disabled (`capture_pageview: false`) so this
 * component owns what ships: the URL goes through `before_send` →
 * `normalizeSecretPath` (so `/t/<id>` becomes `/t/:token`), and the trip is
 * identified by its opaque `$dtId` as a PROPERTY instead of by the path.
 *
 * What we want to learn (#21): does "≤2 taps to today's plan" hold, how deep do
 * share links get opened, mobile vs desktop, booklet downloads, and which pages
 * people actually use. All page-level facts, so one pageview per navigation is
 * the entire instrument for them.
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
    // Keep the ambient trip context in sync even when the path did not change
    // (e.g. a redirect that lands on the same URL), so custom events raised
    // elsewhere always carry the right trip.
    setAnalyticsTrip(tripId);
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    capturePageview(tripId ? { tripId } : undefined);
  }, [pathname, tripId]);

  return null;
}
