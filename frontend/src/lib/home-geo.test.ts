/**
 * The home map's pure half (#249, slice 3): row→pin shaping, the stage
 * fallback, the pin↔row tie, and the clustering vocabulary. The canvas
 * (`components/HomeMap`) projects and paints; everything decidable without a
 * browser lives here and is pinned here.
 */
import { describe, expect, it } from "vitest";
import { clusterPins, homePinsFromGeo, homeRowId, pinStage } from "./home-geo";
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
