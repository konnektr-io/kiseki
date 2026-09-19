// @vitest-environment jsdom
/**
 * The track card's RENDERED strip (#336) — the figures, not just the hook.
 *
 * The live defect: Little Switzerland by Van (planned hikes, #194) printed
 * "Recorded track · 16.2 km ridden · 16.2 km tracked · +265 m" — a recording
 * that never happened, and a ride/lift split reporting the same number twice
 * in ski vocabulary on a walk.
 *
 * Mounted in jsdom with `fetch` stubbed to the real API payloads, because
 * the SSR test in track-card.test.tsx only ever sees the loading state (the
 * track arrives in an effect). Payloads copied from production:
 * `GET /api/tracks/<trip>/<file>` for a planned GPX (liftDistanceM 0, no
 * timestamps) and for a recorded ski day (real lift legs).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrackCard } from "./track-card";
import type { TrackFeature } from "../lib/tracks";

const TRACK = "/media/ec5c2b2a-a241-44ee-87d5-37c97b92d642/680c7a12b77f5e1337a9680955eea9dc.gpx";

/** Little Switzerland, 2026-11-12 — the planned Mullerthal Route 2 shape. */
const PLANNED_HIKE: TrackFeature = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[6.25, 49.8], [6.3, 49.82]] },
  properties: {
    distanceM: 16233.3,
    ascentM: 265,
    startTime: null,
    endTime: null,
    durationS: null,
    pointCount: 400,
    rideDistanceM: 16233.3,
    liftDistanceM: 0,
    liftVerticalM: 0,
    legs: [{ type: "ride", startIndex: 0, endIndex: 399, distanceM: 16233.3, ascentM: 265 }],
  },
};

/** Japow 2026-01-14 — a recorded day: lifts, timestamps, a real split. */
const RECORDED_SKI_DAY: TrackFeature = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[140.7, 42.8], [140.72, 42.82]] },
  properties: {
    distanceM: 34552,
    ascentM: 4140.5,
    startTime: "2026-01-14T01:25:34Z",
    endTime: "2026-01-14T09:17:34Z",
    durationS: 28320,
    pointCount: 900,
    rideDistanceM: 16790.5,
    liftDistanceM: 17761.2,
    liftVerticalM: 4140.5,
    legs: [
      { type: "lift", startIndex: 0, endIndex: 1, distanceM: 900, ascentM: 800 },
      { type: "ride", startIndex: 1, endIndex: 2, distanceM: 16790.5, ascentM: 3340.5 },
    ],
  },
};

/** A recorded walk with no lift in it — the split must stay away. */
const RECORDED_HIKE: TrackFeature = {
  ...PLANNED_HIKE,
  properties: {
    ...PLANNED_HIKE.properties,
    startTime: "2026-09-12T08:00:00Z",
    durationS: 5400,
  },
};

let container: HTMLDivElement;
let root: Root;

function stubTrack(feature: TrackFeature) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => feature }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(track: string, status?: "planned" | "booked" | "done") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<TrackCard track={track} status={status} />);
  });
}

/** Flush the track fetch + its effect inside act(). */
async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(): string {
  return container.textContent ?? "";
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("TrackCard rendered strip (#336)", () => {
  it("a planned hiking route reads as a Route with plain figures — no 'ridden', no tautology", async () => {
    stubTrack(PLANNED_HIKE);
    mount(TRACK, "planned");
    await flush();

    expect(text()).toContain("Route");
    expect(text()).not.toContain("Recorded");
    expect(text()).toContain("16.2 km");
    expect(text()).toContain("+265 m");
    // The reported defect: the same distance twice, labelled 'ridden'/'tracked'.
    expect(text()).not.toContain("ridden");
    expect(text()).not.toContain("tracked");
    expect(text()).not.toContain("lift");
  });

  it("a recorded walk with no lift shows the total, never a split", async () => {
    stubTrack(RECORDED_HIKE);
    mount(TRACK, "done");
    await flush();

    expect(text()).toContain("Recorded track");
    expect(text()).toContain("16.2 km");
    expect(text()).not.toContain("ridden");
    expect(text()).not.toContain("tracked");
  });

  it("a recorded ski day keeps its riding figure, lift count and duration", async () => {
    stubTrack(RECORDED_SKI_DAY);
    mount(TRACK, "done");
    await flush();

    expect(text()).toContain("Recorded track");
    expect(text()).toContain("16.8 km");
    expect(text()).toContain("ridden");
    expect(text()).toContain("34.6 km");
    expect(text()).toContain("tracked");
    expect(text()).toContain("1 lift");
    expect(text()).toContain("+4,141 m");
    expect(text()).toContain("7 h 52");
  });

  it("a plan never borrows the split, even if its file carries lift-shaped legs", async () => {
    stubTrack(RECORDED_SKI_DAY);
    mount(TRACK, "planned");
    await flush();

    expect(text()).toContain("Route");
    expect(text()).not.toContain("ridden");
    expect(text()).not.toContain("lift");
  });
});
