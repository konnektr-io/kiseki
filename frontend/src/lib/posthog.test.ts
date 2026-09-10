import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the v0.25.0 analytics defect (issue #21).
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
 * Runs in the repo's default `node` environment, so consent is supplied by
 * mocking `./analytics-consent` rather than by touching a DOM.
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

const { initAnalytics, capturePageview, isPostHogConfigured } = await import("./posthog");

describe("posthog init (analytics #21)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.__loaded = false;
    client.init.mockImplementation(() => {
      client.__loaded = true;
    });
    hoisted.consent = null;
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
    expect(typeof config.before_send).toBe("function"); // scrubber is wired
    expect(String(config.api_host)).toContain("eu."); // EU data residency
  });

  it("sends no events when the SDK is not loaded", () => {
    capturePageview({ tripId: "trip-1" });
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("sends a pageview with the trip id once loaded", () => {
    hoisted.consent = "granted";
    initAnalytics();
    client.capture.mockClear();
    // `capturePageview` reads window.location for the (scrubbed) URL — the repo's
    // node test env has no window, so supply the one field it needs.
    vi.stubGlobal("window", {
      location: { href: "http://localhost/t/bf29a027-2ed2-46b3-b869-d9d81bbcf237/itinerary" },
    });
    try {
      capturePageview({ tripId: "bf29a027-2ed2-46b3-b869-d9d81bbcf237" });
      expect(client.capture).toHaveBeenCalledTimes(1);
      const [event, props] = client.capture.mock.calls[0] as [string, Record<string, unknown>];
      expect(event).toBe("$pageview");
      expect(props.trip_id).toBe("bf29a027-2ed2-46b3-b869-d9d81bbcf237");
      // The URL it ships is the scrubbed one, never the raw trip path.
      expect(String(props.$current_url)).not.toContain("bf29a027-2ed2-46b3-b869-d9d81bbcf237");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
