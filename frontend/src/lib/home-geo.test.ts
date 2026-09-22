/**
 * The home map's pure half (#249, slice 3): row→pin shaping, the stage
 * fallback, the pin↔row tie, and the clustering vocabulary. The canvas
 * (`components/HomeMap`) projects and paints; everything decidable without a
 * browser lives here and is pinned here.
 */
import { describe, expect, it } from "vitest";
import { angularSeparationDeg, clusterPins, homePinsFromGeo, homeRowId, isOnVisibleHemisphere, normalizeLng, pinStage, selectHomeLabels, unfoldLngs, type HomeMapPin } from "./home-geo";
import { MAP_LABEL_MAX, MAP_LABEL_ZOOM_FLOOR } from "./maps";
import { HOME_LABEL_ZOOM_FLOOR } from "./home-geo";
import type { TripGeo } from "./types";

function pin(over: Partial<HomeMapPin> & { dtId: string }): HomeMapPin {
  return {
    title: `Trip ${over.dtId}`,
    stage: "booked",
    lat: 50.9981,
    lng: -118.1957,
    name: "Revelstoke",
    origin: "mine",
    ...over,
  };
}

function geo(over: Partial<TripGeo> & { dtId: string }): TripGeo {
  return {
    title: "T",
    stage: "booked",
    anchor: { lat: 50.9981, lng: -118.1957, name: "Revelstoke" },
    origin: "mine",
    ...over,
  } as TripGeo;
}

describe("pinStage", () => {
  it("passes every known stage through", () => {
    for (const stage of ["idea", "options", "shortlist", "planned", "booked", "live", "archive"] as const) {
      expect(pinStage(stage)).toBe(stage);
    }
  });

  it("reads an unknown stage as provisional, never booked", () => {
    expect(pinStage("launched")).toBe("idea");
    expect(pinStage("")).toBe("idea");
  });
});

describe("homePinsFromGeo", () => {
  it("shapes rows into pins in server order", () => {
    const pins = homePinsFromGeo([
      geo({ dtId: "a", title: "Ski Week", origin: "mine" }),
      geo({ dtId: "b", title: "Dolomites", origin: "discover", stage: "planned" }),
    ]);
    expect(pins.map((p) => [p.dtId, p.origin, p.stage])).toEqual([
      ["a", "mine", "booked"],
      ["b", "discover", "planned"],
    ]);
    expect(pins[0]).toMatchObject({ lat: 50.9981, lng: -118.1957, name: "Revelstoke" });
  });

  it("drops rows that cannot honestly become a pin, and never invents one", () => {
    const pins = homePinsFromGeo([
      geo({ dtId: "ok" }),
      geo({ dtId: "", title: "No id" }),
      { ...geo({ dtId: "no-anchor" }), anchor: undefined as never },
      { ...geo({ dtId: "nan" }), anchor: { lat: NaN, lng: 0, name: "X" } },
      { ...geo({ dtId: "bad-origin" }), origin: "yours" as never },
    ]);
    expect(pins.map((p) => p.dtId)).toEqual(["ok"]);
  });
});

describe("homeRowId", () => {
  it("ties a pin to its band row in both directions", () => {
    expect(homeRowId("abc")).toBe("home-trip-abc");
  });
});

describe("clusterPins", () => {
  const R = 48;

  it("leaves distant pins alone", () => {
    const out = clusterPins(
      [
        { dtId: "a", x: 0, y: 0 },
        { dtId: "b", x: 500, y: 500 },
      ],
      R,
    );
    expect(out.map((c) => c.kind)).toEqual(["pin", "pin"]);
  });

  it("groups colliding pins into one count, keyed by membership", () => {
    const out = clusterPins(
      [
        { dtId: "a", x: 0, y: 0 },
        { dtId: "b", x: 10, y: 10 },
        { dtId: "c", x: 500, y: 500 },
      ],
      R,
    );
    expect(out.map((c) => c.kind)).toEqual(["cluster", "pin"]);
    const cluster = out[0];
    if (cluster.kind !== "cluster") throw new Error("expected a cluster");
    expect(cluster.cluster.memberDtIds).toEqual(["a", "b"]);
    expect(cluster.cluster.key).toBe("a+b");
    expect(cluster.cluster.x).toBeCloseTo(5);
  });

  it("is deterministic and never emits a cluster of one", () => {
    const points = [
      { dtId: "a", x: 0, y: 0 },
      { dtId: "b", x: R, y: 0 },
    ];
    const first = clusterPins(points, R);
    const second = clusterPins(points, R);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("cluster");
  });

  it("clusters nothing when there is nothing", () => {
    expect(clusterPins([], R)).toEqual([]);
  });
});

describe("unfoldLngs — the shortest arc across the date line", () => {
  it("keeps a set that does not cross ±180 in order", () => {
    // `normalizeLng` reshapes through a modulo, so compare with tolerance.
    const near = unfoldLngs([11.84, 13.4]);
    expect(near[0]).toBeCloseTo(11.84, 6);
    expect(near[1]).toBeCloseTo(13.4, 6);
    const west = unfoldLngs([-114.06, -70.66]);
    expect(west[0]).toBeCloseTo(-114.06, 6);
    expect(west[1]).toBeCloseTo(-70.66, 6);
  });

  it("measures Canada + Chile + Japan by 148°, not 255°", () => {
    // Naive min/max: −114.06 … 141.35 = 255.41°, centred on Africa, which no
    // zoom can hold on a phone. The shortest arc runs Japan → Chile eastward.
    const unfolded = unfoldLngs([-114.06, -70.66, 141.35]);
    const min = Math.min(...unfolded);
    const max = Math.max(...unfolded);
    expect(min).toBeCloseTo(141.35, 4);
    expect(max).toBeCloseTo(289.34, 4);
    expect(max - min).toBeCloseTo(147.99, 2);
    // Every value is still the same point on the globe.
    expect(normalizeLng(unfolded[0])).toBeCloseTo(-114.06, 4);
  });

  it("always reports the arc's own midpoint back inside ±180", () => {
    const unfolded = unfoldLngs([-114.06, -70.66, 141.35]);
    const mid = (Math.min(...unfolded) + Math.max(...unfolded)) / 2;
    expect(normalizeLng(mid)).toBeCloseTo(-144.655, 3);
  });

  it("handles the two-point case in both directions", () => {
    // 170 and −170 are 20° apart across the line, not 340° around it.
    const pair = unfoldLngs([170, -170]);
    expect(Math.max(...pair) - Math.min(...pair)).toBeCloseTo(20, 4);
    expect([...pair].sort((a, b) => a - b)).toEqual([170, 190]);
  });

  it("is a no-op for none or one point, and never mutates its input", () => {
    const input = [-114.06, -70.66, 141.35];
    unfoldLngs(input);
    expect(input).toEqual([-114.06, -70.66, 141.35]);
    expect(unfoldLngs([])).toEqual([]);
    expect(unfoldLngs([200])).toEqual([-160]);
  });
});

describe("normalizeLng", () => {
  it("wraps any longitude into [−180, 180)", () => {
    expect(normalizeLng(215.345)).toBeCloseTo(-144.655, 3);
    expect(normalizeLng(-190)).toBeCloseTo(170, 4);
    expect(normalizeLng(190)).toBeCloseTo(-170, 4);
    expect(normalizeLng(0)).toBe(0);
  });
});

describe("isOnVisibleHemisphere — the landing globe's horizon (#372 slice 1)", () => {
  // The framed camera for the Canada/Chile/Japan set: the shortest-arc fit
  // centres on (−144.655, 8.86) — see the HomeMap bounding-box tests.
  const CAM = { lat: 8.86475, lng: -144.655 };

  it("the framed three-continent set faces its own camera — one globe face holds it", () => {
    // Measured, not assumed: 148° < 180°, so the whole set is on screen.
    expect(angularSeparationDeg(51.1784, -114.06, CAM.lat, CAM.lng)).toBeCloseTo(49.21, 1);
    expect(angularSeparationDeg(-33.4489, -70.66, CAM.lat, CAM.lng)).toBeCloseTo(81.82, 1);
    expect(angularSeparationDeg(42.78, 141.35, CAM.lat, CAM.lng)).toBeCloseTo(72.26, 1);
    for (const [lat, lng] of [[51.1784, -114.06], [-33.4489, -70.66], [42.78, 141.35]] as const) {
      expect(isOnVisibleHemisphere(lat, lng, CAM.lat, CAM.lng)).toBe(true);
    }
  });

  it("a pin past the horizon is far-side, even antimeridian-safe", () => {
    // Japan's antipode (−42.78, −38.65): the farthest possible point.
    expect(isOnVisibleHemisphere(42.78, 141.35, -42.78, -38.65)).toBe(false);
    // From a mid-Atlantic camera Japan is over the horizon (Δlng ≈ 171°).
    expect(isOnVisibleHemisphere(42.78, 141.35, 0, -30)).toBe(false);
  });

  it("the limb itself still counts as visible — no pin falls off the cluster", () => {
    expect(angularSeparationDeg(0, 0, 0, 90)).toBeCloseTo(90, 6);
    expect(isOnVisibleHemisphere(0, 0, 0, 90)).toBe(true);
    expect(isOnVisibleHemisphere(0, 0, 0, 90.0001)).toBe(false);
  });

  it("a pin at the camera centre faces it", () => {
    expect(isOnVisibleHemisphere(50.9981, -118.1957, 50.9981, -118.1957)).toBe(true);
  });
});

describe("selectHomeLabels — the landing map's title labels (#372 slice 2)", () => {
  const ZOOM = MAP_LABEL_ZOOM_FLOOR + 1;
  // Measured phone fit zoom for the three-continent set (headless Chromium,
  // SwiftShader, 390px viewport): the fitted camera lands at 0.9–1.3.
  const PHONE_FIT_ZOOM = 1;
  const ids = (pins: HomeMapPin[]) => pins.map((p) => p.dtId);

  it("labels every pin when the set fits the cap", () => {
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(), null, ZOOM))).toEqual(["a", "b"]);
  });

  it("caps the layer and keeps input order past it", () => {
    const pins = Array.from({ length: MAP_LABEL_MAX + 3 }, (_, i) => pin({ dtId: `t${i}` }));
    const labelled = selectHomeLabels(pins, new Set(), null, ZOOM);
    expect(labelled).toHaveLength(MAP_LABEL_MAX);
    expect(ids(labelled)).toEqual(pins.slice(0, MAP_LABEL_MAX).map((p) => p.dtId));
  });

  it("moves the selected trip first and never caps it out", () => {
    const pins = Array.from({ length: MAP_LABEL_MAX + 3 }, (_, i) => pin({ dtId: `t${i}` }));
    const labelled = selectHomeLabels(pins, new Set(), `t${MAP_LABEL_MAX + 2}`, ZOOM);
    expect(labelled).toHaveLength(MAP_LABEL_MAX);
    expect(labelled[0].dtId).toBe(`t${MAP_LABEL_MAX + 2}`);
  });

  it("a selected pin inside a cluster stays quiet — the badge is its reading", () => {
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(["a"]), "a", ZOOM))).toEqual(["b"]);
  });

  it("clustered pins take no label", () => {
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" }), pin({ dtId: "c" })];
    expect(ids(selectHomeLabels(pins, ["a", "b"], null, ZOOM))).toEqual(["c"]);
    expect(selectHomeLabels(pins, ["a", "b", "c"], null, ZOOM)).toEqual([]);
  });

  it("drops the whole layer below the collision zoom — selected included", () => {
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(selectHomeLabels(pins, new Set(), "a", HOME_LABEL_ZOOM_FLOOR - 0.5)).toEqual([]);
    expect(selectHomeLabels(pins, new Set(), null, HOME_LABEL_ZOOM_FLOOR - 0.5)).toEqual([]);
    expect(selectHomeLabels(pins, new Set(), null, HOME_LABEL_ZOOM_FLOOR)).toHaveLength(2);
  });

  it("labels at the phone-fit zoom — a capped set of ~10 cannot clutter (#372)", () => {
    // Measured in headless Chromium (SwiftShader): the three-continent fit
    // lands at zoom 0.9–1.3 on a 390px viewport. The landing map must name
    // its trips there, not only after the viewer zooms in twice.
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(), null, PHONE_FIT_ZOOM))).toEqual(["a", "b"]);
  });

  it("leaves the trip-map floor alone — trip surfaces keep their clutter gate", () => {
    expect(MAP_LABEL_ZOOM_FLOOR).toBe(2);
  });

  it("never labels a blank title — the aria-label already names the anchor", () => {
    const pins = [pin({ dtId: "a", title: "  " }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(), null, ZOOM))).toEqual(["b"]);
  });

  it("labels nothing when there is nothing", () => {
    expect(selectHomeLabels([], new Set(), null, ZOOM)).toEqual([]);
  });
});
