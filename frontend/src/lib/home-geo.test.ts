/**
 * The home map's pure half (#249, slice 3): row→pin shaping, the stage
 * fallback, the pin↔row tie, and the clustering vocabulary. The canvas
 * (`components/HomeMap`) projects and paints; everything decidable without a
 * browser lives here and is pinned here.
 */
import { describe, expect, it } from "vitest";
import { clusterPins, homePinsFromGeo, homeRowId, normalizeLng, pinStage, unfoldLngs } from "./home-geo";
import type { TripGeo } from "./types";

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
