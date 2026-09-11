import { describe, expect, it } from "vitest";
import {
  applyBasemapTint,
  CHROME_PADDING,
  clampPadding,
  findLocation,
  MAP_STYLE_URL,
  markerNumber,
  OPENFREEMAP_STYLES,
  resolveMapStyle,
  type TintableMap,
} from "./maps";
import type { Trip } from "./types";

const trip = {
  locations: [
    { name: "Banff", alias: [], lat: 51.1784, lng: -115.5708 },
    { name: "Revelstoke", alias: ["Hillcrest"], lat: 50.9981, lng: -118.1957 },
    { name: "Golden", marker: 9, alias: [], lat: 51.292, lng: -116.9656 },
  ],
} as unknown as Trip;

describe("findLocation", () => {
  it("matches a name or an alias, case-insensitively", () => {
    expect(findLocation(trip, "banff")?.name).toBe("Banff");
    expect(findLocation(trip, " Hillcrest ")?.name).toBe("Revelstoke");
  });

  it("is undefined for an unknown place", () => {
    expect(findLocation(trip, "Whistler")).toBeUndefined();
  });
});

describe("markerNumber", () => {
  it("is the registry position, unless the entry overrides it", () => {
    expect(markerNumber(trip, trip.locations![0])).toBe(1);
    expect(markerNumber(trip, trip.locations![2])).toBe(9);
  });
});

describe("clampPadding", () => {
  it("passes padding through when the box has room", () => {
    expect(clampPadding(CHROME_PADDING, 900, 700)).toEqual(CHROME_PADDING);
  });

  it("squeezes opposing sides proportionally, keeping the lean", () => {
    // A sheet at `full` occludes far more than the surface can spare.
    const p = clampPadding({ top: 36, right: 44, bottom: 660, left: 64 }, 390, 700);
    expect(p.top + p.bottom).toBeLessThanOrEqual(700 - 96);
    // The camera still leans away from the sheet.
    expect(p.bottom).toBeGreaterThan(p.top);
    // The unaffected axis is untouched.
    expect(p.left).toBe(64);
    expect(p.right).toBe(44);
  });

  it("gives up entirely on a box smaller than the minimum", () => {
    expect(clampPadding(CHROME_PADDING, 60, 60)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("handles an unmeasured box without producing NaN", () => {
    const p = clampPadding(CHROME_PADDING, 0, 0);
    expect(Object.values(p).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("resolveMapStyle", () => {
  const themed = (theme: Trip["theme"]) => ({ theme }) as Trip;

  it("is today's map for an un-themed trip", () => {
    const r = resolveMapStyle(themed(undefined));
    expect(r.styleUrl).toBe(MAP_STYLE_URL);
    expect(r.styleUrl).toBe(OPENFREEMAP_STYLES.positron);
    expect(r.tint).toBeUndefined();
    expect(r.terrain).toEqual({ hillshade: true, exaggeration: 0.7, terrain3d: true });
  });

  it("picks the preset basemap (density varies per trip)", () => {
    expect(resolveMapStyle(themed({ preset: "ember" })).styleUrl).toBe(OPENFREEMAP_STYLES.liberty);
    expect(resolveMapStyle(themed({ preset: "nocturne" })).styleUrl).toBe(OPENFREEMAP_STYLES.dark);
    expect(resolveMapStyle(themed({ preset: "archive" })).tint?.background).toBe("#f5efe2");
  });

  it("lets a per-trip basemap and styleUrl win, in that order", () => {
    expect(resolveMapStyle(themed({ preset: "alpine", mapStyle: { basemap: "liberty" } })).styleUrl).toBe(
      OPENFREEMAP_STYLES.liberty,
    );
    expect(
      resolveMapStyle(
        themed({
          preset: "alpine",
          mapStyle: { basemap: "liberty", styleUrl: "https://example.com/custom.json" },
        }),
      ).styleUrl,
    ).toBe("https://example.com/custom.json");
  });

  it("falls back to positron on an unknown basemap key, never throws", () => {
    expect(resolveMapStyle(themed({ preset: "alpine", mapStyle: { basemap: "atlantis" } })).styleUrl).toBe(
      OPENFREEMAP_STYLES.positron,
    );
    expect(resolveMapStyle(themed({ preset: "atlantis" })).styleUrl).toBe(OPENFREEMAP_STYLES.positron);
  });

  it("hands the preset terrain through untouched", () => {
    expect(resolveMapStyle(themed({ preset: "nordic" })).terrain).toEqual({
      hillshade: false,
      exaggeration: 0,
      terrain3d: false,
    });
  });
});

describe("applyBasemapTint", () => {
  function fakeMap(): TintableMap & { painted: Array<[string, string, string]> } {
    const painted: Array<[string, string, string]> = [];
    return {
      painted,
      getStyle: () => ({
        layers: [
          { id: "background", type: "background" },
          { id: "water", type: "fill", "source-layer": "water" },
          { id: "land", type: "fill", "source-layer": "landcover" },
          { id: "park", type: "fill", "source-layer": "park" },
          { id: "border", type: "line", "source-layer": "boundary" },
          { id: "road-label", type: "symbol", "source-layer": "place" },
          { id: "road", type: "line", "source-layer": "transportation" },
        ],
      }),
      setPaintProperty: (id, name, value) => {
        painted.push([id, name, String(value)]);
      },
    };
  }

  it("repaints colour layers and never labels", () => {
    const map = fakeMap();
    applyBasemapTint(map, {
      background: "#f5efe2",
      water: "#ddd2b8",
      landcover: "#ece3cb",
      park: "#e0d7b8",
      boundary: "#b8a67e",
    });
    expect(map.painted).toContainEqual(["background", "background-color", "#f5efe2"]);
    expect(map.painted).toContainEqual(["water", "fill-color", "#ddd2b8"]);
    expect(map.painted).toContainEqual(["land", "fill-color", "#ece3cb"]);
    expect(map.painted).toContainEqual(["park", "fill-color", "#e0d7b8"]);
    expect(map.painted).toContainEqual(["border", "line-color", "#b8a67e"]);
    expect(map.painted.some(([id]) => id === "road-label")).toBe(false);
    expect(map.painted.some(([id]) => id === "road")).toBe(false);
  });

  it("no-ops cleanly on absent layers, missing tint and hostile maps", () => {
    const map = fakeMap();
    expect(() => applyBasemapTint(map, undefined)).not.toThrow();
    expect(map.painted).toEqual([]);
    expect(() =>
      applyBasemapTint({ getStyle: () => ({ layers: [] }), setPaintProperty: () => {} }, { water: "#fff" }),
    ).not.toThrow();
    expect(() =>
      applyBasemapTint(
        {
          getStyle: () => {
            throw new Error("style gone");
          },
          setPaintProperty: () => {},
        },
        { water: "#fff" },
      ),
    ).not.toThrow();
    const rejecting: TintableMap = {
      getStyle: () => ({ layers: [{ id: "water", type: "fill", "source-layer": "water" }] }),
      setPaintProperty: () => {
        throw new Error("type mismatch");
      },
    };
    expect(() => applyBasemapTint(rejecting, { water: "#fff" })).not.toThrow();
  });
});
