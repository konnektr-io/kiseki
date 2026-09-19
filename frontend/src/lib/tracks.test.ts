import { describe, expect, it } from "vitest";
import {
  formatTrackAscent,
  formatTrackDistance,
  formatTrackDuration,
  trackDataUrl,
  trackLegPaths,
  trackRideSplit,
  trackSegments,
  trackTracePath,
  tripTracks,
  type TrackFeature,
} from "./tracks";

const TRIP = "bf29a027-2ed2-46b3-b869-d9d81bbcf237";
const NAME = "f88c15acf2c135cbff4de7f3fbd8c534.gpx";

describe("trackDataUrl", () => {
  it("maps a canonical /media track URL to its parse route", () => {
    expect(trackDataUrl(`/media/${TRIP}/${NAME}`)).toBe(`/api/tracks/${TRIP}/${NAME}`);
  });
  it("refuses bare names, externals and non-gpx files", () => {
    expect(trackDataUrl(undefined)).toBeNull();
    expect(trackDataUrl(null)).toBeNull();
    expect(trackDataUrl("")).toBeNull();
    expect(trackDataUrl(NAME)).toBeNull();
    expect(trackDataUrl("https://example.com/track.gpx")).toBeNull();
    expect(trackDataUrl(`/media/${TRIP}/photo.jpg`)).toBeNull();
  });
});

describe("track stat formatters", () => {
  it("formats distance in m under 1 km, km above", () => {
    expect(formatTrackDistance(850)).toBe("850 m");
    expect(formatTrackDistance(12400)).toBe("12.4 km");
    expect(formatTrackDistance(42195)).toBe("42.2 km");
  });
  it("formats duration the booklet way (h min), minutes when short", () => {
    expect(formatTrackDuration(null)).toBeNull();
    expect(formatTrackDuration(undefined)).toBeNull();
    expect(formatTrackDuration(2700)).toBe("45 min");
    expect(formatTrackDuration(5700)).toBe("1 h 35");
    expect(formatTrackDuration(7260)).toBe("2 h 01");
  });
  it("formats ascent with an explicit plus", () => {
    expect(formatTrackAscent(840)).toBe("+840 m");
    expect(formatTrackAscent(1240)).toBe("+1,240 m");
  });
});

describe("tripTracks", () => {
  it("collects block tracks in day order, then section blocks", () => {
    const trip = {
      days: [
        { blocks: [{ track: "/media/t/b.gpx", order: 1 }, { title: "No track", order: 0 }] },
        { blocks: [{ track: "/media/t/a.gpx", order: 0 }] },
      ],
      sections: [{ blocks: [{ track: "/media/t/s.gpx" }] }],
    };
    expect(tripTracks(trip)).toEqual(["/media/t/b.gpx", "/media/t/a.gpx", "/media/t/s.gpx"]);
  });
  it("is empty when nothing carries a track", () => {
    expect(tripTracks({ days: [], sections: [] })).toEqual([]);
  });
});

describe("trackTracePath", () => {
  const feature = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [-122.95, 50.1],
        [-122.951, 50.101],
        [-122.952, 50.102],
        [-122.953, 50.103],
      ],
    },
    properties: { distanceM: 397, ascentM: 90, pointCount: 4 },
  } as TrackFeature;
  it("projects the polyline into the view box, padded", () => {
    const d = trackTracePath(feature.geometry.coordinates, 200, 60, 4);
    expect(d).not.toBeNull();
    expect((d as string).startsWith("M")).toBe(true);
    expect(d).toContain("L");
    // Every projected point stays inside the padded box.
    const nums = (d as string)
      .replace(/^[M]/, "")
      .split("L")
      .flatMap((pair) => pair.trim().split(" ").map(Number));
    for (let i = 0; i < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(4);
      expect(nums[i]).toBeLessThanOrEqual(196);
      expect(nums[i + 1]).toBeGreaterThanOrEqual(4);
      expect(nums[i + 1]).toBeLessThanOrEqual(56);
    }
  });
  it("returns null for fewer than two points", () => {
    expect(trackTracePath([], 200, 60, 4)).toBeNull();
    expect(trackTracePath([[-122.95, 50.1]], 200, 60, 4)).toBeNull();
  });
});

// ------------------------------------------------------- lift legs (#290)

const SPLIT_FEATURE = {
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [-122.95, 50.1],
      [-122.951, 50.11],
      [-122.952, 50.12],
      [-122.9525, 50.121],
      [-122.953, 50.122],
    ],
  },
  properties: {
    distanceM: 3000,
    ascentM: 120,
    pointCount: 5,
    rideDistanceM: 800,
    liftDistanceM: 2200,
    liftVerticalM: 600,
    legs: [
      { type: "lift", startIndex: 0, endIndex: 2, distanceM: 2200, ascentM: 600 },
      { type: "ride", startIndex: 2, endIndex: 4, distanceM: 800, ascentM: 0 },
    ],
  },
} as TrackFeature;

describe("trackDataUrl with FIT (#290)", () => {
  it("maps a .fit track to the same parse route", () => {
    expect(trackDataUrl(`/media/${TRIP}/abcdef0123456789.fit`)).toBe(
      `/api/tracks/${TRIP}/abcdef0123456789.fit`,
    );
  });
  it("still refuses anything that is not a track file", () => {
    expect(trackDataUrl(`/media/${TRIP}/notes.txt`)).toBeNull();
    expect(trackDataUrl(`/media/${TRIP}/photo.jpeg`)).toBeNull();
  });
});

describe("trackSegments (#290)", () => {
  it("slices the line per classified leg, indices inclusive", () => {
    const segments = trackSegments(SPLIT_FEATURE);
    expect(segments.map((s) => s.type)).toEqual(["lift", "ride"]);
    expect(segments[0].coordinates).toEqual([
      [-122.95, 50.1],
      [-122.951, 50.11],
      [-122.952, 50.12],
    ]);
    // The joint coordinate belongs to BOTH legs — no gap in the drawn line.
    expect(segments[1].coordinates[0]).toEqual(segments[0].coordinates[2]);
    expect(segments[1].coordinates).toHaveLength(3);
  });
  it("degrades to one ride segment without legs (pre-#290 payloads)", () => {
    const legacy = { ...SPLIT_FEATURE, properties: { distanceM: 100, ascentM: 0, pointCount: 5 } } as TrackFeature;
    const segments = trackSegments(legacy);
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("ride");
    expect(segments[0].coordinates).toHaveLength(5);
  });
  it("never emits a zero-length segment", () => {
    const degenerate = {
      ...SPLIT_FEATURE,
      properties: {
        ...SPLIT_FEATURE.properties,
        legs: [{ type: "lift", startIndex: 2, endIndex: 2, distanceM: 0, ascentM: 0 }],
      },
    } as TrackFeature;
    // A single-point leg is dropped, but the track still draws as one ride.
    const segments = trackSegments(degenerate);
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("ride");
  });
});

describe("trackLegPaths (#290)", () => {
  it("draws one path per leg on a SINGLE shared projection", () => {
    const paths = trackLegPaths(SPLIT_FEATURE, 320, 96, 6);
    expect(paths.map((p) => p.type)).toEqual(["lift", "ride"]);
    for (const p of paths) expect(p.d.startsWith("M")).toBe(true);
    // The joint point projects identically in both legs — one fit, not two.
    const endOfLift = paths[0].d.split("L").pop();
    const startOfRide = paths[1].d.replace(/^M/, "").split("L")[0];
    expect(startOfRide).toBe(endOfLift);
  });
});

describe("trackRideSplit (#290)", () => {
  it("reports the riding figure beside the full trace total", () => {
    expect(trackRideSplit(SPLIT_FEATURE.properties)).toEqual({
      rideM: 800,
      totalM: 3000,
      liftM: 2200,
      liftVerticalM: 600,
    });
  });
  it("is null when the payload has no legs to compare", () => {
    expect(trackRideSplit(undefined)).toBeNull();
    expect(
      trackRideSplit({ distanceM: 100, ascentM: 0, pointCount: 4 }),
    ).toBeNull();
  });
  it("is null when the trace has no lift (#336 — a hike or a planned route)", () => {
    // The parser emits ONE `ride` leg covering the whole line when nothing
    // classifies as a lift, so a legs-carrying payload is not a split: the
    // live Little Switzerland hike (status: planned, #194) reported
    // "16.2 km ridden, 16.2 km tracked" — the same number twice.
    expect(
      trackRideSplit({
        distanceM: 16233.3,
        ascentM: 265,
        pointCount: 400,
        rideDistanceM: 16233.3,
        liftDistanceM: 0,
        liftVerticalM: 0,
        legs: [{ type: "ride", startIndex: 0, endIndex: 399, distanceM: 16233.3, ascentM: 265 }],
      }),
    ).toBeNull();
    // …and stays null when only the legs carry the "no lift" story.
    expect(
      trackRideSplit({
        distanceM: 5000,
        ascentM: 100,
        pointCount: 100,
        rideDistanceM: 5000,
        legs: [{ type: "ride", startIndex: 0, endIndex: 99, distanceM: 5000, ascentM: 100 }],
      }),
    ).toBeNull();
  });
});
