import { describe, expect, it } from "vitest";
import {
  applyBasemapTint,
  CHROME_PADDING,
  clampPadding,
  findLocation,
  locationStage,
  MAP_STYLE_URL,
  markerNumber,
  markerPinClass,
  OPENFREEMAP_STYLES,
  resolveMapStyle,
  routeCasingOpacityAtZoom,
  routeCasingWidthAtZoom,
  ROUTE_BODY_WIDTH,
  ROUTE_CASING_OPACITY,
  ROUTE_CASING_WIDTH,
  ROUTE_NONROAD,
  routeWidthAtZoom,
  ROUTE_WIDTH_STOPS,
  type TintableMap,
} from "./maps";
import type { Trip } from "./types";
import { PRESET_IDS } from "./theme-presets";

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
    expect(r.terrain).toEqual({ exaggeration: 0.7 });
  });

  it("picks the preset basemap (density varies per trip)", () => {
    expect(resolveMapStyle(themed({ preset: "ember" })).styleUrl).toBe(OPENFREEMAP_STYLES.liberty);
    expect(resolveMapStyle(themed({ preset: "nocturne" })).styleUrl).toBe(OPENFREEMAP_STYLES.dark);
    expect(resolveMapStyle(themed({ preset: "archive" })).tint?.background).toBe("#f5efe2");
  });

  it("ignores a legacy theme.mapStyle in the document — the preset wins", () => {
    const legacy = {
      preset: "alpine",
      mapStyle: { basemap: "liberty", styleUrl: "https://example.com/evil.json" },
    } as unknown as Trip["theme"];
    expect(resolveMapStyle(themed(legacy)).styleUrl).toBe(
      resolveMapStyle(themed({ preset: "alpine" })).styleUrl,
    );
    expect(resolveMapStyle(themed(legacy)).styleUrl).not.toBe("https://example.com/evil.json");
  });

  it("falls back to positron on an unknown preset id, never throws", () => {
    expect(resolveMapStyle(themed({ preset: "atlantis" })).styleUrl).toBe(OPENFREEMAP_STYLES.positron);
  });

  it("hands the preset terrain through untouched", () => {
    expect(resolveMapStyle(themed({ preset: "nordic" })).terrain).toEqual({
      exaggeration: 0.45,
    });
  });

  it("no preset can produce an elevation-free map (#201)", () => {
    // addTerrain has no off-switch anymore — it always builds the DEM,
    // hillshade, contours and tilt-gated 3D from this one intensity — so a
    // positive exaggeration here means relief on the map, for every preset.
    // (addTerrain itself is not importable under node-env vitest:
    // maplibre-contour has no node-resolvable export — see blocks.test.tsx —
    // so this pins the derivation it consumes.)
    for (const id of PRESET_IDS) {
      const terrain = resolveMapStyle(themed({ preset: id })).terrain;
      expect(Object.keys(terrain).sort(), `${id} terrain shape`).toEqual(["exaggeration"]);
      expect(terrain.exaggeration, `${id} exaggeration`).toBeGreaterThan(0);
    }
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

describe("locationStage", () => {
  const banff = { name: "Banff", alias: [], lat: 51.1, lng: -115.5 };
  const revy = { name: "Revelstoke", alias: ["Hillcrest"], lat: 51.0, lng: -118.1 };
  const staged = (stage: Trip["stage"], days: Trip["days"], sections?: Trip["sections"]) =>
    ({ stage, locations: [banff, revy], days, sections }) as unknown as Trip;

  it("falls back to the trip stage with no speaking block", () => {
    expect(locationStage(staged("idea", []), banff)).toBe("idea");
    expect(locationStage(staged("booked", []), banff)).toBe("booked");
  });

  it("derives booked from a booked/done block, planned from an explicit planned", () => {
    const days = [
      { blocks: [{ kind: "lodging", location: "Banff", status: "booked" }] },
      { blocks: [{ kind: "activity", location: "Hillcrest", status: "planned" }] },
    ] as unknown as Trip["days"];
    const t = staged("idea", days);
    expect(locationStage(t, banff)).toBe("booked");
    expect(locationStage(t, revy)).toBe("planned");
  });

  it("matches by alias and by transport endpoints", () => {
    const days = [
      { blocks: [{ kind: "transport", from: "Hillcrest", to: "Banff", status: "done" }] },
    ] as unknown as Trip["days"];
    const t = staged("planned", days);
    expect(locationStage(t, banff)).toBe("booked");
    expect(locationStage(t, revy)).toBe("booked");
  });

  it("ignores status-less blocks and section-pool blocks speak too", () => {
    const days = [{ blocks: [{ kind: "meal", location: "Banff" }] }] as unknown as Trip["days"];
    expect(locationStage(staged("idea", days), banff)).toBe("idea");
    const sections = [{ blocks: [{ kind: "meal", location: "Banff", status: "booked" }] }] as unknown as Trip["sections"];
    expect(locationStage(staged("idea", [], sections), banff)).toBe("booked");
  });

  it("a booked block wins over a planned one for the same place", () => {
    const days = [
      {
        blocks: [
          { kind: "meal", location: "Banff", status: "planned" },
          { kind: "lodging", location: "Banff", status: "booked" },
        ],
      },
    ] as unknown as Trip["days"];
    expect(locationStage(staged("idea", days), banff)).toBe("booked");
  });
});

describe("markerPinClass", () => {
  const loc = { name: "Banff", alias: [], lat: 51.1, lng: -115.5 };
  const pin = (stage: Trip["stage"]) => markerPinClass({ stage, locations: [loc], days: [] } as unknown as Trip, loc);

  it("implements the §8.3 variants — outline while provisional, muted when planned, desaturated in archive", () => {
    expect(pin("idea")).toContain("border-dashed");
    expect(pin("options")).toContain("border-dashed");
    expect(pin("shortlist")).toContain("border-dashed");
    expect(pin("planned")).toContain("bg-marker/70");
    expect(pin("archive")).toContain("bg-muted");
    expect(pin("archive")).not.toContain("bg-marker");
  });

  it("keeps the long-standing filled pin for booked and live", () => {
    const filled =
      "grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold leading-none shadow-card border border-marker-fg bg-marker text-marker-fg";
    expect(pin("booked")).toBe(filled);
    expect(pin("live")).toBe(filled);
  });

  it("never writes a colour in JS — utilities off tokens only", () => {
    for (const s of ["idea", "planned", "booked", "live", "archive"] as const) {
      expect(pin(s)).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });
});

describe("route weight (#357 slice 1)", () => {
  it("pins the body interpolation table: 2/2.5/3/4 px at zoom 0/4/8/12", () => {
    expect(ROUTE_WIDTH_STOPS).toEqual([
      [0, 2],
      [4, 2.5],
      [8, 3],
      [12, 4],
    ]);
    expect(routeWidthAtZoom(0)).toBe(2);
    expect(routeWidthAtZoom(4)).toBe(2.5);
    expect(routeWidthAtZoom(8)).toBe(3);
    expect(routeWidthAtZoom(12)).toBe(4);
  });

  it("interpolates linearly between stops and clamps at the ends", () => {
    expect(routeWidthAtZoom(2)).toBeCloseTo(2.25, 5);
    expect(routeWidthAtZoom(6)).toBeCloseTo(2.75, 5);
    expect(routeWidthAtZoom(10)).toBeCloseTo(3.5, 5);
    expect(routeWidthAtZoom(-3)).toBe(2);
    expect(routeWidthAtZoom(20)).toBe(4);
  });

  it("keeps the casing at ~1.6x the body, softening 0.9 to 0.55", () => {
    for (const z of [0, 2, 4, 6, 8, 10, 12]) {
      expect(routeCasingWidthAtZoom(z)).toBeCloseTo(routeWidthAtZoom(z) * 1.6, 5);
    }
    expect(routeCasingOpacityAtZoom(0)).toBe(0.9);
    expect(routeCasingOpacityAtZoom(12)).toBe(0.55);
    expect(routeCasingOpacityAtZoom(6)).toBeCloseTo(0.725, 5);
  });

  it("draws non-road legs thin, dim and dashed", () => {
    expect(ROUTE_NONROAD.width).toBe(2);
    expect(ROUTE_NONROAD.opacity).toBe(0.35);
    expect([...ROUTE_NONROAD.dasharray]).toEqual([2, 3]);
  });

  it("exposes zoom interpolations as MapLibre expressions", () => {
    for (const expr of [ROUTE_BODY_WIDTH, ROUTE_CASING_WIDTH, ROUTE_CASING_OPACITY]) {
      const raw = expr as unknown as unknown[];
      expect(raw[0]).toBe("interpolate");
      expect(raw[1]).toEqual(["linear"]);
      expect(raw[2]).toEqual(["zoom"]);
    }
    expect(ROUTE_BODY_WIDTH as unknown as unknown[]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      2,
      4,
      2.5,
      8,
      3,
      12,
      4,
    ]);
  });
});
