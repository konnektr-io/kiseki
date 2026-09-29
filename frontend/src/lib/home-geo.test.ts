/**
 * The home map's pure half (#249, slice 3): row→pin shaping, the stage
 * fallback, the pin↔row tie, and the clustering vocabulary. The canvas
 * (`components/HomeMap`) projects and paints; everything decidable without a
 * browser lives here and is pinned here.
 */
import { describe, expect, it } from "vitest";
import { angularSeparationDeg, clusterPins, fitZoomCenteredOn, homePinsFromGeo, homeRowId, isOnVisibleHemisphere, mercatorY, MIN_FIT_ZOOM, normalizeLng, pinStage, selectHomeLabels, unfoldLngs, type HomeMapPin } from "./home-geo";
import { MAP_LABEL_MAX } from "./maps";

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
  const ids = (pins: HomeMapPin[]) => pins.map((p) => p.dtId);

  it("labels every pin when the set fits the cap", () => {
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(), null))).toEqual(["a", "b"]);
  });

  it("caps the layer and keeps input order past it", () => {
    const pins = Array.from({ length: MAP_LABEL_MAX + 3 }, (_, i) => pin({ dtId: `t${i}` }));
    const labelled = selectHomeLabels(pins, new Set(), null);
    expect(labelled).toHaveLength(MAP_LABEL_MAX);
    expect(ids(labelled)).toEqual(pins.slice(0, MAP_LABEL_MAX).map((p) => p.dtId));
  });

  it("moves the selected trip first and never caps it out", () => {
    const pins = Array.from({ length: MAP_LABEL_MAX + 3 }, (_, i) => pin({ dtId: `t${i}` }));
    const labelled = selectHomeLabels(pins, new Set(), `t${MAP_LABEL_MAX + 2}`);
    expect(labelled).toHaveLength(MAP_LABEL_MAX);
    expect(labelled[0].dtId).toBe(`t${MAP_LABEL_MAX + 2}`);
  });

  it("a selected pin inside a cluster stays quiet — the badge is its reading", () => {
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(["a"]), "a"))).toEqual(["b"]);
  });

  it("clustered pins take no label", () => {
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" }), pin({ dtId: "c" })];
    expect(ids(selectHomeLabels(pins, ["a", "b"], null))).toEqual(["c"]);
    expect(selectHomeLabels(pins, ["a", "b", "c"], null)).toEqual([]);
  });

  it("carries NO zoom gate — a negative globe zoom still labels (#372)", () => {
    // The regression this pins, measured on live data: the 390x844 landing
    // globe settles at zoom -2.28 (MapLibre zoom is unbounded below zero on a
    // globe), and the earlier HOME_LABEL_ZOOM_FLOOR = 0 hid every label on a
    // phone. The rule takes no zoom at all now; if anyone adds one back, this
    // test fails at the phone's real value.
    const pins = [pin({ dtId: "a" }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(), null))).toEqual(["a", "b"]);
    expect(ids(selectHomeLabels(pins, new Set(), "a"))).toEqual(["a", "b"]);
  });

  it("never labels a blank title — the aria-label already names the anchor", () => {
    const pins = [pin({ dtId: "a", title: "  " }), pin({ dtId: "b" })];
    expect(ids(selectHomeLabels(pins, new Set(), null))).toEqual(["b"]);
  });

  it("labels nothing when there is nothing", () => {
    expect(selectHomeLabels([], new Set(), null)).toEqual([]);
  });

  it("leaves the trip-map floor alone — trip surfaces keep their clutter gate", async () => {
    const { MAP_LABEL_ZOOM_FLOOR } = await import("./maps");
    expect(MAP_LABEL_ZOOM_FLOOR).toBe(2);
  });
});

/**
 * `fitZoomCenteredOn` is the arithmetic behind "#393 the middle of the globe is
 * my location": with the camera standing on a traveler who is NOT standing on
 * their trips, how far out must it be for the farthest trip to still land inside
 * the room the sheet leaves? The naive answer — reuse the fit's zoom — crops the
 * trip that is furthest from home, which is the whole reason this is its own
 * function rather than a `center:` override.
 */
describe("fitZoomCenteredOn", () => {
  const box = { width: 390, height: 783, padding: { top: 0, right: 0, bottom: 0, left: 0 } };

  it("zooms out until the farthest pin fits, instead of cropping it off the edge", () => {
    const pins = [pin({ dtId: "a", lng: -114.06, lat: 51.18 }), pin({ dtId: "b", lng: 11.84, lat: 46.41 })];
    // The traveler is in Amsterdam; Canada is 119° east-west away, and 195px of
    // half-width can only hold that at a low zoom.
    const zoom = fitZoomCenteredOn({ lat: 52.09, lng: 5.12 }, pins, box, 12);
    expect(zoom).not.toBeNull();
    expect(zoom!).toBeGreaterThan(0);
    expect(zoom!).toBeLessThan(3);
    // And the answer is exactly "the farthest pin just fits": nudge the box 1px
    // tighter and the zoom must fall (it is a fit, not a vibe).
    const tighter = { ...box, width: 389 };
    expect(fitZoomCenteredOn({ lat: 52.09, lng: 5.12 }, pins, tighter, 12)!).toBeLessThan(zoom!);
  });

  it("leaves the zoom alone when every pin is already inside the room", () => {
    // Two pins a few hundred metres from the traveller: nothing asks for a
    // wider view than the ceiling, so the ceiling wins.
    const near = [pin({ dtId: "a", lng: 5.11, lat: 52.08 }), pin({ dtId: "b", lng: 5.14, lat: 52.06 })];
    expect(fitZoomCenteredOn({ lat: 52.09, lng: 5.12 }, near, box, 12)).toBe(12);
  });

  it("returns nothing when the padding leaves no room (the #368 class)", () => {
    const pins = [pin({ dtId: "a", lng: 5, lat: 52 }), pin({ dtId: "b", lng: 6, lat: 51 })];
    expect(fitZoomCenteredOn({ lat: 52.09, lng: 5.12 }, pins, { ...box, height: 400, padding: { ...box.padding, bottom: 420 } }, 12)).toBeNull();
    expect(fitZoomCenteredOn({ lat: 52.09, lng: 5.12 }, pins, { ...box, width: 0 }, 12)).toBeNull();
  });

  it("measures across the antimeridian the SHORT way round", () => {
    // 175°E and 175°W are 10° apart, not 350° — the naive delta would demand a
    // zoom so low the pin is a speck.
    const pins = [pin({ dtId: "a", lng: -175, lat: 52.09 })];
    const zoom = fitZoomCenteredOn({ lat: 52.09, lng: 175 }, pins, box, 12)!;
    expect(zoom).toBeGreaterThan(4);
  });

  it("never asks for a zoom the overview does not use", () => {
    // A pole-to-pole span inside a 100px box needs a zoom BELOW the floor — the
    // surface clamps instead of handing MapLibre an unrenderable number.
    const tiny = { width: 100, height: 100, padding: { top: 0, right: 0, bottom: 0, left: 0 } };
    const pins = [pin({ dtId: "a", lng: 5, lat: -85 })];
    const zoom = fitZoomCenteredOn({ lat: 85, lng: 5.12 }, pins, tiny, 12)!;
    expect(zoom).toBe(MIN_FIT_ZOOM);
    // …and the projection it rests on is bounded at both poles.
    expect(mercatorY(90)).toBeCloseTo(0, 6);
    expect(mercatorY(-90)).toBeCloseTo(1, 6);
    expect(mercatorY(0)).toBeCloseTo(0.5, 6);
  });
});
