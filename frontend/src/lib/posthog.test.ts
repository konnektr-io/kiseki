import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the analytics wiring (issue #21, and #295 for the
 * pageleave half).
 *
 * v0.25.0 shipped with `cookieless_mode: "always"` behind a consent banner.
 * That combination is self-defeating — "always" is the mode you pick when you
 * do NOT want a banner — and it is silently destructive: with a project that
 * has not enabled "Cookieless server hash mode", PostHog answers every event
 * with `{"status":"Ok"}` and then DISCARDS it. The site collected nothing for a
 * whole release while every visible signal was green (HTTP 200, requests
 * delivered, unit tests passing, the probe asserting "events delivered").
 *
 * The fix is `on_reject` (the documented banner pairing) plus an explicit
 * `opt_in_capturing()` on init, because `on_reject` starts the client in the
 * pending/cookieless state. These tests make both halves impossible to undo
 * by accident.
 *
 * #295 is the same shape of gap one layer up: pageviews shipped, the matching
 * `$pageleave` never did (818 to 0 over 30 days), so bounce rate, session
 * duration and scroll depth were empty while the pageview metrics looked
 * healthy. Both SDK switches are off on purpose, which makes pairing OUR job —
 * these tests pin that a leave is emitted exactly once per pageview, that it
 * goes out as a beacon, and that it never becomes a stray event of its own.
 *
 * Runs in the repo's default `node` environment, so consent is supplied by
 * mocking `./analytics-consent` and the SDK by mocking `posthog-js`.
 */

const hoisted = vi.hoisted(() => ({
  consent: null as null | "granted" | "denied",
}));

vi.mock("./analytics-consent", () => ({
  currentConsent: () => hoisted.consent,
}));

const client = vi.hoisted(() => ({
  __loaded: false,
  init: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: client }));

const { initAnalytics, capturePageview, capturePageleave, setAnalyticsTrip, isPostHogConfigured } =
  await import("./posthog");

/** A trip `$dtId` and the URL that carries it — both appear in assertions. */
const TRIP = "bf29a027-2ed2-46b3-b869-d9d81bbcf237";
const TRIP_HREF = `http://localhost/t/${TRIP}/itinerary`;

describe("posthog init (analytics #21)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.__loaded = false;
    client.init.mockImplementation(() => {
      client.__loaded = true;
    });
    hoisted.consent = null;
    // `capturePageview`/`capturePageleave` read window.location — the repo's node
    // test env has no window, so every case gets a browser-shaped one.
    vi.stubGlobal("window", { location: { href: TRIP_HREF } });
    // Pairing state (`pageviewOpen`) and the ambient trip are module-level and
    // outlive a test. Start every case from a CLOSED pair and no trip, or an open
    // pageview left by an earlier case would make the "no pageleave without a
    // pageview" assertion pass vacuously.
    client.__loaded = true;
    capturePageleave();
    client.__loaded = false;
    setAnalyticsTrip(undefined);
    vi.clearAllMocks();
  });

  it("is configured from the baked-in public ingest key", () => {
    expect(isPostHogConfigured).toBe(true);
  });

  it("refuses to initialize without a granted consent choice", () => {
    initAnalytics();
    expect(client.init).not.toHaveBeenCalled();
    expect(client.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("refuses to initialize when the visitor declined", () => {
    hoisted.consent = "denied";
    initAnalytics();
    expect(client.init).not.toHaveBeenCalled();
  });

  it("uses cookieless_mode 'on_reject' — never 'always'", () => {
    // Guards the exact v0.25.0 defect: "always" + a banner = silently dropped
    // events, because identity becomes a server-side hash that the project must
    // opt into storing.
    hoisted.consent = "granted";
    initAnalytics();

    expect(client.init).toHaveBeenCalledTimes(1);
    const config = client.init.mock.calls[0][1] as Record<string, unknown>;
    expect(config.cookieless_mode).toBe("on_reject");
    expect(config.cookieless_mode).not.toBe("always");
  });

  it("opts in explicitly, so the SDK leaves its pending cookieless state", () => {
    // Without this call the client stays cookieless despite the banner being
    // accepted, and every event is discarded server-side again.
    hoisted.consent = "granted";
    initAnalytics();
    expect(client.opt_in_capturing).toHaveBeenCalled();
  });

  it("keeps the privacy posture the issue requires", () => {
    hoisted.consent = "granted";
    initAnalytics();
    const config = client.init.mock.calls[0][1] as Record<string, unknown>;

    expect(config.disable_session_recording).toBe(true); // replay records URLs + DOM
    expect(config.capture_heatmaps).toBe(false);
    expect(config.autocapture).toBe(false); // ships element text = trip content
    expect(config.capture_pageview).toBe(false); // we send pageviews via the scrubber
    // ...and we send pageleave ourselves too (#295), so the SDK's must stay off:
    // one source, never two. posthog-js would not emit it anyway while
    // `capture_pageview` is false — that coupling is what shipped the gap.
    expect(config.capture_pageleave).toBe(false);
    expect(typeof config.before_send).toBe("function"); // scrubber is wired
    expect(String(config.api_host)).toContain("eu."); // EU data residency
  });

  it("sends no events when the SDK is not loaded", () => {
    capturePageview({ tripId: "trip-1" });
    capturePageleave();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("sends a pageview with the trip id once loaded", () => {
    hoisted.consent = "granted";
    initAnalytics();
    client.capture.mockClear();
    capturePageview({ tripId: TRIP });
    expect(client.capture).toHaveBeenCalledTimes(1);
    const [event, props] = client.capture.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("$pageview");
    expect(props.trip_id).toBe(TRIP);
    // The URL it ships is the scrubbed one, never the raw trip path.
    expect(String(props.$current_url)).not.toContain(TRIP);
  });

  it("sends no pageleave before a pageview has shipped", () => {
    // The first navigation of a page load opens the pair. A leave here would be a
    // stray `$pageleave` with no `$pageview_id` to pair with — it would satisfy
    // PostHog's health check while corrupting the very metrics it exists for.
    hoisted.consent = "granted";
    initAnalytics();
    client.capture.mockClear();
    capturePageleave();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("pairs each pageview with a $pageleave sent as a beacon", () => {
    hoisted.consent = "granted";
    initAnalytics();
    client.capture.mockClear();

    // Exactly the order the component uses: the ambient trip is set first (that
    // is what tags events raised elsewhere), then the pageview opens the pair.
    setAnalyticsTrip(TRIP);
    capturePageview({ tripId: TRIP });
    capturePageleave();

    expect(client.capture.mock.calls.map((c) => c[0])).toEqual(["$pageview", "$pageleave"]);
    const [, props, options] = client.capture.mock.calls[1] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // The beacon is load-bearing, not a style choice: `request_batching` defaults
    // to true, and the SDK's own unload flush is gated on the `capture_pageleave`
    // we keep off — so a queued pageleave would simply never leave.
    expect(options).toEqual({ transport: "sendBeacon" });
    expect(props.trip_id).toBe(TRIP);
    expect(String(props.$current_url)).not.toContain(TRIP);
  });

  it("closes a pageview only once, and reopens on the next pageview", () => {
    hoisted.consent = "granted";
    initAnalytics();
    client.capture.mockClear();

    capturePageview({ tripId: TRIP });
    capturePageleave();
    capturePageleave(); // no pageview since — must not emit a second leave
    capturePageview({ tripId: TRIP });
    capturePageleave();

    expect(client.capture.mock.calls.map((c) => c[0])).toEqual([
      "$pageview",
      "$pageleave",
      "$pageview",
      "$pageleave",
    ]);
  });

  it("pairs the pageview initAnalytics replays for the current page", () => {
    // A visitor who accepts while sitting on a trip page gets that pageview
    // replayed by `initAnalytics`; it must be closable too, or accept-then-leave
    // becomes the one path still missing a pageleave.
    setAnalyticsTrip(TRIP);
    hoisted.consent = "granted";
    initAnalytics();
    client.capture.mockClear();

    capturePageleave();

    expect(client.capture.mock.calls.map((c) => c[0])).toEqual(["$pageleave"]);
  });
});
