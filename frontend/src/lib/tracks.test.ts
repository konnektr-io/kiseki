import { describe, expect, it } from "vitest";
import {
  formatTrackAscent,
  formatTrackDistance,
  formatTrackDuration,
  trackDataUrl,
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
