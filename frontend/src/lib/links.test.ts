// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { internalAppPath } from "./links";

/* #301 — the predicate every content-link surface shares. A wrong "internal"
 * answer is worse than none: it would turn a Strava/YouTube/Maps link into an
 * in-app navigation (a router Link to a foreign URL), while a wrong "external"
 * answer is the original defect (an app route opening a second tab).
 *
 * jsdom (not node) is deliberate: the predicate compares against
 * `window.location.origin`, and jsdom gives it a real one
 * ("http://localhost:3000"). */
describe("internalAppPath (#301)", () => {
  it("recognises the app's own routes — root-relative and same-origin absolute", () => {
    expect(internalAppPath("/t/bc537361-8d0a/day/3")).toBe("/t/bc537361-8d0a/day/3");
    expect(internalAppPath("/t/bc537361-8d0a/itinerary#s-2")).toBe("/t/bc537361-8d0a/itinerary#s-2");
    expect(internalAppPath("/t/abc?tab=2#s-2")).toBe("/t/abc?tab=2#s-2");
    // an absolute URL on THIS origin is the same destination
    expect(internalAppPath(`${window.location.origin}/t/abc/day/0`)).toBe("/t/abc/day/0");
    expect(internalAppPath("/me")).toBe("/me");
    expect(internalAppPath("/u/google-oauth2%7C123")).toBe("/u/google-oauth2%7C123");
  });

  it("never claims an off-app target", () => {
    const external = [
      "https://www.strava.com/activities/9001",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.google.com/maps/search/?api=1&query=Banff",
      "https://kiseki.konnektr.io/t/abc/day/1", // same path, another origin
      "//evil.example/t/abc/day/1", // protocol-relative, other origin
      "mailto:someone@example.com",
      "tel:+3212345678",
      "day/3", // relative: resolves against whatever surface renders it
      "t/abc/day/3",
      "#s-2",
      "/media/abc/cover.jpg",
      "/api/trips/abc",
      "/inbox/deadbeef.pdf",
      "/members", // merely shares an app route's first letters
      "/trip/abc",
      "",
    ];
    for (const url of external) expect(internalAppPath(url), url).toBeNull();
  });

  it("takes null/undefined and junk without throwing (it runs inside render)", () => {
    expect(internalAppPath(undefined)).toBeNull();
    expect(internalAppPath(null)).toBeNull();
    expect(internalAppPath("   ")).toBeNull();
    expect(internalAppPath("not a url at all")).toBeNull();
    expect(internalAppPath("https://")).toBeNull();
  });
});
