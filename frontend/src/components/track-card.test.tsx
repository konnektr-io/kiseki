import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

/* A track block reads as its own card (#193) — distance / time / ascent
 * plus the trace — and never masquerades as a letter-chip stop (#90:
 * `data-place-pill` is for stops; a track is the shape of the day).
 *
 * The same `track` field carries a RECORDING (`status: "done"`) or a planned
 * ROUTE (#194/#336: a signposted trail's GPX attached while planning) — the
 * card must never call a plan "Recorded track".
 *
 * Server-rendered (no DOM, no fetch): the initial paint carries the card
 * hook, the label, the download link and the loading state. */
import { TrackCard } from "./track-card";

const TRACK = "/media/bf29a027-2ed2-46b3-b869-d9d81bbcf237/f88c15acf2c135cbff4de7f3fbd8c534.gpx";

describe("TrackCard", () => {
  it("renders its own card hook, never a place pill", () => {
    const html = renderToString(createElement(TrackCard, { track: TRACK }));
    expect(html).toContain(`data-track-card="${TRACK}"`);
    expect(html).not.toContain("data-place-pill");
  });
  it("links the GPX download and announces the loading state", () => {
    const html = renderToString(createElement(TrackCard, { track: TRACK, status: "done" }));
    expect(html).toContain(`href="${TRACK}"`);
    expect(html).toContain("Loading track");
    expect(html).toContain("Recorded track");
  });
  it("labels a .fit download as FIT (#290 — both formats ride the same card)", () => {
    const fit = TRACK.replace(/\.gpx$/, ".fit");
    const html = renderToString(createElement(TrackCard, { track: fit, status: "done" }));
    expect(html).toContain(`data-track-card="${fit}"`);
    expect(html).toContain(">FIT<");
    expect(html).not.toContain(">GPX<");
  });
  it("hides the minimap in the card strip (#305 — minimap belongs on a real map in print via CardMedia)", () => {
    const html = renderToString(createElement(TrackCard, { track: TRACK, status: "done" }));
    expect(html).not.toContain('viewBox="0 0 320 96"');
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("minimap");
    // Stats strip and download CTA are kept
    expect(html).toContain("Recorded track");
    expect(html).toContain(`href="${TRACK}"`);
  });
  it("calls a not-yet-walked track a Route (#336 — a plan is not a recording)", () => {
    for (const status of ["planned", "booked", undefined] as const) {
      const html = renderToString(createElement(TrackCard, { track: TRACK, status }));
      expect(html).toContain("Route");
      expect(html).not.toContain("Recorded track");
      expect(html).toContain("Download the route file");
    }
  });
});
