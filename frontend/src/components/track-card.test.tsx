import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

/* A recorded track reads as its own card (#193) — distance / time / ascent
 * plus the trace — and never masquerades as a letter-chip stop (#90:
 * `data-place-pill` is for stops; a track is the shape of the day).
 *
 * Server-rendered (no DOM, no fetch): the initial paint carries the card
 * hook, the download link and the loading state. */
import { TrackCard } from "./track-card";

const TRACK = "/media/bf29a027-2ed2-46b3-b869-d9d81bbcf237/f88c15acf2c135cbff4de7f3fbd8c534.gpx";

describe("TrackCard", () => {
  it("renders its own card hook, never a place pill", () => {
    const html = renderToString(createElement(TrackCard, { track: TRACK }));
    expect(html).toContain(`data-track-card="${TRACK}"`);
    expect(html).not.toContain("data-place-pill");
  });
  it("links the GPX download and announces the loading state", () => {
    const html = renderToString(createElement(TrackCard, { track: TRACK }));
    expect(html).toContain(`href="${TRACK}"`);
    expect(html).toContain("Loading track");
    expect(html).toContain("Recorded track");
  });
  it("labels a .fit download as FIT (#290 — both formats ride the same card)", () => {
    const fit = TRACK.replace(/\.gpx$/, ".fit");
    const html = renderToString(createElement(TrackCard, { track: fit }));
    expect(html).toContain(`data-track-card="${fit}"`);
    expect(html).toContain(">FIT<");
    expect(html).not.toContain(">GPX<");
  });
});
