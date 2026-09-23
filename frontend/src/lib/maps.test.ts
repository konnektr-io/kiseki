import { describe, expect, it } from "vitest";
import {
  applyBasemapTint,
  CHROME_PADDING,
  clampPadding,
  fetchRouteLegs,
  findLocation,
  formatMapLabel,
  locationStage,
  mapFitPadding,
  MAP_LABEL_MAX,
  MAP_LABEL_PIN_OFFSET_PX,
  MAP_LABEL_ZOOM_FLOOR,
  MAP_STYLE_URL,
  markerNumber,
  markerPinClass,
  OPENFREEMAP_STYLES,
  pinScaleAtZoom,
  resolveMapStyle,
  routeCasingOpacityAtZoom,
  routeCasingWidthAtZoom,
  ROUTE_BODY_WIDTH,
  ROUTE_CASING_OPACITY,
  ROUTE_CASING_WIDTH,
  ROUTE_NONROAD,
  routeWidthAtZoom,
  ROUTE_WIDTH_STOPS,
  selectMapLabels,
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

describe("mapFitPadding (#368)", () => {
  it("keeps the full surface budget on a container that has room", () => {
    expect(mapFitPadding(900, 700)).toEqual(CHROME_PADDING);
  });

  it("scales the budget to a card minimap's short side", () => {
    // A 94px-tall minimap is SMALLER than the 88px-tall chrome budget: the
    // unclamped padding left fitBounds a negative box and the camera never
    // moved (#368). The scaled padding must leave the track a real box.
    const p = mapFitPadding(670, 94);
    expect(p.top + p.bottom).toBeLessThan(94);
    expect(p.left + p.right).toBeLessThan(670);
    // The camera box must stay usable in BOTH axes.
    expect(670 - p.left - p.right).toBeGreaterThan(0);
    expect(94 - p.top - p.bottom).toBeGreaterThan(0);
  });

  it("never goes below the floor, on a degenerate box", () => {
    const p = mapFitPadding(0, 0);
    expect(Object.values(p).every((v) => v >= 2 && Number.isFinite(v))).toBe(true);
  });

  it("is monotonic: a taller/shorter strip gets more/less margin", () => {
    const short = mapFitPadding(670, 94);
    const tall = mapFitPadding(670, 190);
    expect(tall.top).toBeGreaterThanOrEqual(short.top);
    expect(tall.bottom).toBeGreaterThanOrEqual(short.bottom);
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

  it("a skipped block commits nothing — the place keeps the trip stage (#385)", () => {
    const days = [{ blocks: [{ kind: "meal", location: "Banff", status: "skipped" }] }] as unknown as Trip["days"];
    expect(locationStage(staged("idea", days), banff)).toBe("idea");
    expect(locationStage(staged("live", days), banff)).toBe("live");
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

describe("pin scale (#357 slice 2)", () => {
  it("is ~22/28 at journey zoom and 1 by day zoom", () => {
    expect(pinScaleAtZoom(5)).toBeCloseTo(22 / 28, 5);
    expect(pinScaleAtZoom(9)).toBe(1);
    expect(pinScaleAtZoom(0)).toBeCloseTo(22 / 28, 5);
    expect(pinScaleAtZoom(14)).toBe(1);
  });

  it("interpolates linearly between journey and day zoom", () => {
    expect(pinScaleAtZoom(7)).toBeCloseTo((22 / 28 + 1) / 2, 5);
  });

  it("keeps the ordinal and the hit target in the class map (size comes from CSS)", () => {
    // The markup size is unchanged — `.map-pin-scaled` scales the visible
    // dot only, so the 44px target (h-11 w-11 on the button) never moves.
    const booked =
      "grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold leading-none shadow-card border border-marker-fg bg-marker text-marker-fg";
    const t = { stage: "booked", locations: [{ name: "X", alias: [] }], days: [] } as unknown as Trip;
    expect(markerPinClass(t, t.locations![0])).toBe(booked);
  });
});

describe("on-map labels (#357 slice 2)", () => {
  const city = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

  it("caps at about 8 labels in registry order", () => {
    expect(selectMapLabels(city, null, 6)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(selectMapLabels(city, null, 6).length).toBeLessThanOrEqual(MAP_LABEL_MAX);
  });

  it("the selected pin always wins, even past the cap", () => {
    expect(selectMapLabels(city, "L", 6)[0]).toBe("L");
    expect(selectMapLabels(city, "L", 6)).toHaveLength(MAP_LABEL_MAX);
    expect(selectMapLabels(["A", "B"], "B", 6)).toEqual(["B", "A"]);
  });

  it("drops the whole layer below the collision zoom — pins stay, labels go", () => {
    expect(selectMapLabels(city, null, MAP_LABEL_ZOOM_FLOOR - 0.5)).toEqual([]);
    expect(selectMapLabels(city, "A", 1)).toEqual([]);
    expect(selectMapLabels(city, null, MAP_LABEL_ZOOM_FLOOR)).not.toEqual([]);
  });

  it("dense-city fixture: 12 stops at day zoom label 8 with the selected first", () => {
    const labels = selectMapLabels(city, "G", 11);
    expect(labels).toHaveLength(8);
    expect(labels[0]).toBe("G");
  });

  it("3-continent fixture: the same trip far out labels nothing", () => {
    expect(selectMapLabels(city, "G", 1.2)).toEqual([]);
  });

  it("numbers the prefix like the pin so label and pin read as one place", () => {
    expect(formatMapLabel(3, "Healesville")).toBe("3 · Healesville");
  });

  it("overview settle without selection names the first 8 chain stops (#361 slice 2)", () => {
    // The scan-level and feature-map settle rebuilds pass NO selection, so
    // the capped layer is the chain-order head — the overview names its
    // places without a tap. Selected-first still applies once tapped
    // (above), the cap stands, and the zoom floor still drops the layer.
    const chain = [
      "Santiago",
      "Valparaiso",
      "La Serena",
      "Antofagasta",
      "Iquique",
      "Arica",
      "Arequipa",
      "Cusco",
      "Puno",
      "Lima",
      "Huaraz",
      "Trujillo",
    ];
    expect(selectMapLabels(chain, null, 4)).toEqual(chain.slice(0, MAP_LABEL_MAX));
    expect(selectMapLabels(chain, null, 4)).toHaveLength(MAP_LABEL_MAX);
  });

  it("sits the pill just below its pin so it reads as a label (#361 slice 1)", () => {
    // ~14–16px: below the 28px visible pin (bottom edge +14), overlapping
    // only the transparent 44px hit padding (ends +22) — taps still land
    // because labels are pointer-events-none, and the drive-time chip is DOM
    // chrome above the canvas, so a label can never cover it.
    expect(MAP_LABEL_PIN_OFFSET_PX).toBeGreaterThanOrEqual(14);
    expect(MAP_LABEL_PIN_OFFSET_PX).toBeLessThanOrEqual(16);
  });
});

describe("fetchRouteLegs (#357 slice 3A: E1)", () => {
  it("preserves the server-echoed mode on each leg", async () => {
    const legs = [
      {
        from: "A",
        to: "B",
        road: false,
        mode: "flight",
        duration: null,
        distance: null,
        geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      },
    ];
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ legs }), { status: 200 })) as typeof fetch;
    try {
      const t = {
        id: "tid",
        locations: [
          { name: "A", alias: [], lat: 0, lng: 0 },
          { name: "B", alias: [], lat: 1, lng: 1 },
        ],
      } as unknown as Trip;
      const out = await fetchRouteLegs(t, ["A", "B"]);
      expect(out?.[0].mode).toBe("flight");
      expect(out?.[0].road).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
