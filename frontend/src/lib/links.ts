/**
 * Is a content-supplied link target something THIS APP can navigate to? (#301)
 *
 * Trip content carries links — a feature card's `links`, a block's links, a
 * todo's links, `practical.links` — written by the kiseki content-agent. When
 * one of them points back INTO the app (the riding-log cards link
 * `/t/<trip_id>/day/<idx>` so an overview entry opens the trip's own day), it
 * must navigate in-app: every one of those surfaces used to render a plain
 * `<a target="_blank" rel="noreferrer">`, so an internal target opened a second
 * tab and the ask was withdrawn — Niko, verbatim: *"the links open in a new
 * tab, which is not what we want."*
 *
 * The decision is per TARGET, not per surface: an off-app target (Strava,
 * YouTube, Google Maps, a booking page) keeps the new-tab contract, which is
 * right and must not change. One predicate decides, so every surface agrees.
 */

/** The FIRST path segment of the app's own route table (`frontend/src/App.tsx`)
 *  — the destinations its router can serve from a URL. Keep this in step with
 *  that file: a route it does not have would land on the catch-all redirect,
 *  and a route missing here would open a same-origin page in a new tab. */
const APP_ROUTE_SEGMENTS = new Set(["t", "u", "me", "feed", "join"]);

/** The browser's origin, or a placeholder under SSR/node (only ever compared
 *  against another origin, so the placeholder can never match a real URL). */
function appOrigin(): string {
  return typeof window !== "undefined" && window.location ? window.location.origin : "http://kiseki.invalid";
}

/**
 * The in-app path for `url` (with its query + hash), or null when it is NOT an
 * app route and keeps its `<a target="_blank">` treatment.
 *
 * Only a root-relative path (`/t/<id>/day/3`) or an absolute same-origin URL
 * can name one: a bare relative value (`day/3`) resolves against whatever
 * surface happens to render it, so it is never re-interpreted here. Same-origin
 * is required for absolute URLs — server assets (`/media/…`, `/api/…`,
 * `/inbox/…`) are not app routes and stay ordinary links.
 */
export function internalAppPath(url: string | undefined | null): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  if (!raw.startsWith("/") && !/^https?:\/\//i.test(raw)) return null;
  let resolved: URL;
  try {
    resolved = new URL(raw, appOrigin());
  } catch {
    // A malformed value must never throw from inside a render.
    return null;
  }
  if (resolved.origin !== appOrigin()) return null;
  const [first = ""] = resolved.pathname.replace(/^\/+/, "").split("/");
  if (!APP_ROUTE_SEGMENTS.has(first)) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
