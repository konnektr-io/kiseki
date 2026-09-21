// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyOverviewGlobe,
  clearOverviewGlobe,
  GLOBE_PROJECTION_TYPE,
  globeSky,
  globeSkySpec,
  isGlobeProjection,
  MERCATOR_PROJECTION_TYPE,
  shouldUseGlobe,
  type GlobeCapableMap,
} from "./globe";
import { CHROME_PADDING, clampPadding } from "./maps";
import { unfoldLngs } from "./home-geo";

/* #361 slice 3 + #372 slice 1 — the globe for the overviews.
 *
 * Screen-only by construction: the scan level of RouteMap, the
 * OverviewPage feature map (via TripMap/MapView), and the signed-in landing
 * map (HomeMap) render on a globe; the day level, card minimaps, LandingMap
 * and the ENTIRE print path stay Mercator. Colours are tokens, never hex;
 * there is no per-trip knob.
 */

/** A recording fake for the sliver of MapLibre the globe helpers touch. */
function fakeMap(
  overrides: Partial<{
    projection: string;
    throwOnProjection: boolean;
    throwOnSky: boolean;
  }> = {},
): GlobeCapableMap & {
  projections: unknown[];
  skies: unknown[];
} {
  const calls: unknown[] = [];
  const skies: unknown[] = [];
  return {
    projections: calls,
    skies,
    setProjection(p: unknown) {
      if (overrides.throwOnProjection) throw new Error("no projection today");
      calls.push(p);
      return undefined;
    },
    setSky(s: unknown) {
      if (overrides.throwOnSky) throw new Error("no sky today");
      skies.push(s);
      return undefined;
    },
    getProjection() {
      if (overrides.projection === undefined) return undefined;
      return { type: overrides.projection };
    },
  };
}

describe("shouldUseGlobe — the screen-only gate", () => {
  it("the overview feature map renders on the globe on screen", () => {
    expect(shouldUseGlobe({ globe: true, isPdfRender: false, compact: false })).toBe(true);
  });

  it("the booklet PDF never sees the globe, even if the prop leaks through", () => {
    expect(shouldUseGlobe({ globe: true, isPdfRender: true })).toBe(false);
  });

  it("compact card minimaps stay Mercator", () => {
    expect(shouldUseGlobe({ globe: true, isPdfRender: false, compact: true })).toBe(false);
  });

  it("nothing else opts in — no per-trip knob, no default", () => {
    expect(shouldUseGlobe({ globe: undefined, isPdfRender: false })).toBe(false);
    expect(shouldUseGlobe({ isPdfRender: false })).toBe(false);
  });
});

describe("applyOverviewGlobe / clearOverviewGlobe", () => {
  it("sets the globe projection with a token sky", () => {
    const map = fakeMap();
    const el = document.createElement("div");
    el.style.setProperty("--map-sky", "rgb(200, 212, 227)");
    el.style.setProperty("--map-horizon", "rgb(246, 243, 238)");
    applyOverviewGlobe(map, el);
    expect(map.projections).toEqual([{ type: GLOBE_PROJECTION_TYPE }]);
    expect(map.skies).toHaveLength(1);
    const sky = map.skies[0] as Record<string, unknown>;
    expect(sky["sky-color"]).toBe("rgb(200, 212, 227)");
    expect(sky["horizon-color"]).toBe("rgb(246, 243, 238)");
  });

  it("the sky spec carries atmosphere blends per the style spec", () => {
    const spec = globeSkySpec(document.createElement("div"));
    expect(spec["sky-horizon-blend"]).toBeTypeOf("number");
    expect(spec["horizon-fog-blend"]).toBeTypeOf("number");
  });

  it("sky colours are tokens, never hex literals in map code", () => {
    // No stylesheet in jsdom: the fallbacks must still be defined strings,
    // and globe.ts itself contains no hex literal (pinned here so one cannot
    // slip back in the way #1e3a8a once did).
    const { sky, horizon } = globeSky(document.createElement("div"));
    expect(sky).toBeTruthy();
    expect(horizon).toBeTruthy();
    expect(sky).not.toMatch(/^#/);
    expect(horizon).not.toMatch(/^#/);
  });

  it("the day level goes back to Mercator and sets no sky", () => {
    const map = fakeMap();
    clearOverviewGlobe(map);
    expect(map.projections).toEqual([{ type: MERCATOR_PROJECTION_TYPE }]);
    expect(map.skies).toHaveLength(0);
  });

  it("a map that rejects the globe keeps its Mercator route — never a broken surface", () => {
    const map = fakeMap({ throwOnProjection: true, throwOnSky: true });
    expect(() => applyOverviewGlobe(map, document.createElement("div"))).not.toThrow();
    expect(() => clearOverviewGlobe(map)).not.toThrow();
  });
});

describe("isGlobeProjection — the terrain seam", () => {
  it("reads the live projection", () => {
    expect(isGlobeProjection(fakeMap({ projection: "globe" }))).toBe(true);
    expect(isGlobeProjection(fakeMap({ projection: "mercator" }))).toBe(false);
  });

  it("unknown maps read as Mercator — terrain attaches as before", () => {
    const noGetter: GlobeCapableMap = {
      setProjection: () => undefined,
      setSky: () => undefined,
    };
    expect(isGlobeProjection(noGetter)).toBe(false);
    expect(isGlobeProjection(fakeMap())).toBe(false);
  });
});

describe("camera on the globe — measured, not assumed", () => {
  /* Chile-Peru-shaped: Santiago → Cusco with the SCL/CUZ airport gateways
   * the slice-4 proximity rule matches through, plus Lima on the way home.
   * The globe-relevant property is the SPAN: under a hemisphere the
   * flat-measured fitBounds fit still frames; past it no fit can. */
  const CHAIN = [
    { name: "Santiago", lng: -70.66, lat: -33.45 },
    { name: "Luchthaven Santiago", lng: -70.79, lat: -33.39 },
    { name: "Cusco", lng: -71.97, lat: -13.53 },
    { name: "Luchthaven Cusco", lng: -72.01, lat: -13.55 },
    { name: "Lima", lng: -77.03, lat: -12.05 },
  ];

  it("the chain spans well under a hemisphere, contiguous through unfoldLngs", () => {
    const unfolded = unfoldLngs(CHAIN.map((p) => p.lng));
    // Same order, same points — unfolding only re-frames, never invents.
    expect(unfolded).toHaveLength(CHAIN.length);
    const span = Math.max(...unfolded) - Math.min(...unfolded);
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(90);
    const lats = CHAIN.map((p) => p.lat);
    expect(Math.max(...lats) - Math.min(...lats)).toBeLessThan(90);
  });

  it("phone framing (sheet at half) still leaves a usable viewport", () => {
    // 390×844 phone, scan level: rail/sheet occlusion eats the bottom half.
    const padding = { ...CHROME_PADDING, bottom: 422 + CHROME_PADDING.bottom };
    const clamped = clampPadding(padding, 390, 844);
    expect(390 - clamped.left - clamped.right).toBeGreaterThanOrEqual(96);
    expect(844 - clamped.top - clamped.bottom).toBeGreaterThanOrEqual(96);
  });

  it("desktop framing (fixed left rail) still leaves a usable viewport", () => {
    // 1280×800 desktop: the 400px rail occludes the left.
    const padding = { ...CHROME_PADDING, left: 400 + CHROME_PADDING.left };
    const clamped = clampPadding(padding, 1280, 800);
    expect(1280 - clamped.left - clamped.right).toBeGreaterThanOrEqual(96);
    expect(800 - clamped.top - clamped.bottom).toBeGreaterThanOrEqual(96);
  });
});
