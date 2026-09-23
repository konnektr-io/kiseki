import { describe, expect, it } from "vitest";
import { activityLetter, blockLegStage, daySurface } from "./day-surface";
import type { Block, Day, Trip, TripLocation } from "./types";

/* Fixtures follow the route-surface.test.ts conventions: the whole trip in one
 * object, a handful of registry places with real-ish coordinates, and blocks
 * that carry the evidence fields the derivation is allowed to read (#91). */

const loc = (name: string, lat: number, lng: number): TripLocation => ({
  name,
  lat,
  lng,
});

const PLACES: Record<string, TripLocation> = {
  Banff: loc("Banff", 51.1784, -115.5708),
  Revelstoke: loc("Revelstoke", 51.0, -118.2),
  Louise: loc("Lake Louise", 51.4254, -116.1773),
  Calgary: loc("Calgary", 51.1315, -114.0106),
};

function trip(over: Partial<Trip> = {}): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test trip",
    stage: "booked",
    startDate: "2027-02-15",
    endDate: "2027-02-16",
    locations: Object.values(PLACES),
    days: [],
    ...over,
  } as Trip;
}

function day(blocks: Block[], over: Partial<Day> = {}): Day {
  return { date: "2027-02-15", title: "Test day", blocks, ...over } as Day;
}

const block = (over: Partial<Block> & { id: string }): Block => ({ ...over }) as Block;

/* ---------------------------------------------------------------- letters */

describe("activityLetter", () => {
  it("goes A, B, C in order", () => {
    expect(activityLetter(1)).toBe("A");
    expect(activityLetter(2)).toBe("B");
    expect(activityLetter(26)).toBe("Z");
  });
  it("cycles with a suffix past Z so chips never collide", () => {
    expect(activityLetter(27)).toBe("A2");
    expect(activityLetter(28)).toBe("B2");
  });
  it("clamps nonsense to A", () => {
    expect(activityLetter(0)).toBe("A");
  });
});

/* ------------------------------------------------------------- stage rule */

describe("blockLegStage", () => {
  it("the block's own status wins", () => {
    const t = trip();
    expect(blockLegStage(t, block({ id: "b", kind: "transport", status: "planned" }))).toBe("planned");
    expect(blockLegStage(t, block({ id: "b", kind: "transport", status: "booked" }))).toBe("booked");
  });
  it("falls back to the trip stage like chain legs do", () => {
    expect(blockLegStage(trip({ stage: "booked" }), block({ id: "b", kind: "transport" }))).toBe("booked");
    expect(blockLegStage(trip({ stage: "idea" }), block({ id: "b", kind: "transport" }))).toBe("provisional");
  });
  it("a skipped block says nothing — the trip stage answers (#385)", () => {
    expect(blockLegStage(trip({ stage: "booked" }), block({ id: "b", kind: "transport", status: "skipped" }))).toBe("booked");
    expect(blockLegStage(trip({ stage: "live" }), block({ id: "b", kind: "transport", status: "skipped" }))).toBe("booked");
  });
});

/* ------------------------------------------------------------ day surface */

describe("daySurface", () => {
  it("derives chips in day order; blocks at one place share the letter", () => {
    const t = trip({
      days: [
        day([
          block({ id: "b1", kind: "activity", title: "Sunshine full day", order: 0, location: "Sunshine" }),
          block({ id: "b2", kind: "meal", title: "Dinner in Banff", order: 1, location: "Banff" }),
          block({ id: "b3", kind: "lodging", title: "Banff Inn", order: 2, location: "Banff" }),
        ]),
      ],
    });
    // "Sunshine" is not in the registry — a title match must NOT invent a
    // place (#91); Banff blocks share one chip, and the chip IS the place's
    // marker (no bare numbered pin stacked under it).
    const s = daySurface(t, 0)!;
    expect(s.letters.get("b2")).toBe("A");
    expect(s.letters.get("b3")).toBe("A");
    expect(s.letters.has("b1")).toBe(false);
    const chips = s.markers.filter((m) => m.role === "activity");
    expect(chips).toHaveLength(1);
    expect(chips[0].place.name).toBe("Banff");
    expect(chips[0].blockIds).toEqual(["b2", "b3"]);
    expect(s.markers.filter((m) => m.role === "place")).toHaveLength(0);
  });

  it("a title may name a place through its alias (#104 prod: Sunshine full day)", () => {
    const places: TripLocation[] = [
      loc("Banff", 51.1784, -115.5708),
      { ...loc("Sunshine Village", 51.0786, -115.7822), alias: ["Sunshine", "Banff Sunshine"] },
    ];
    const t = trip({
      locations: places,
      days: [
        day([
          // No explicit location — the title names the place via its alias.
          block({ id: "s1", kind: "activity", title: "Sunshine full day", order: 0 }),
          block({ id: "s2", kind: "lodging", title: "Stay: Banff (2nd night)", order: 1, location: "Banff" }),
        ]),
      ],
    });
    const s = daySurface(t, 0)!;
    expect(s.letters.get("s1")).toBe("A");
    expect(s.letters.get("s2")).toBe("B");
    const chips = s.markers.filter((m) => m.role === "activity");
    expect(chips.map((c) => (c as { place: { name: string } }).place.name)).toEqual([
      "Sunshine Village",
      "Banff",
    ]);
  });

  it("title matching stays exact-name and never invents places (#91)", () => {
    const t = trip({
      days: [
        day([block({ id: "x1", kind: "activity", title: "Wander around town", order: 0 })]),
      ],
    });
    const s = daySurface(t, 0)!;
    expect(s.letters.size).toBe(0);
    expect(s.markers).toHaveLength(0);
  });

  it("transport days: numbered pins only; flights mark resolved endpoints without arcs", () => {
    const t = trip({
      days: [
        day([
          block({ id: "f1", kind: "transport", title: "Fly Brussels → Calgary", order: 0, from: "Brussels", to: "Calgary", mode: "flight" }),
          block({ id: "d1", kind: "transport", title: "Drive Calgary → Banff", order: 1, from: "Calgary", to: "Banff", mode: "drive" }),
        ]),
      ],
    });
    const s = daySurface(t, 0)!;
    // flight: Brussels off the registry → one-sided marking of Calgary only
    // (Brussels must NOT appear); the drive then adds Banff. Together the
    // endpoints are exactly the transport places, no invented ones.
    expect(s.endpoints.map((p) => p.name)).toEqual(["Calgary", "Banff"]);
    expect(s.legs.map((l) => [l.from.name, l.to.name])).toEqual([["Calgary", "Banff"]]);
    expect(s.legs[0].stage).toBe("booked");
    expect(s.markers.every((m) => m.role === "place")).toBe(true);
    expect(s.markers.map((m) => (m.role === "place" ? m.place.name : ""))).toEqual(["Calgary", "Banff"]);
    expect(s.letters.size).toBe(0);
  });

  it("an unclassified transport block travels like a car (draws the leg)", () => {
    const t = trip({
      days: [
        day([block({ id: "d1", kind: "transport", title: "Transfer to Revelstoke", order: 0, from: "Banff", to: "Revelstoke" })]),
      ],
    });
    const s = daySurface(t, 0)!;
    expect(s.legs).toHaveLength(1);
    expect(s.legs[0].to.name).toBe("Revelstoke");
  });

  it("returns null past the trip's days", () => {
    const t = trip({ days: [day([])] });
    expect(daySurface(t, 1)).toBeNull();
  });

  it("collects recorded tracks from the explicit track field, in day order", () => {
    const t = trip({
      days: [
        day([
          block({ id: "b1", kind: "activity", title: "Morning skin track", order: 0, track: "/media/t1/aaa.gpx" }),
          block({ id: "b2", kind: "activity", title: "Lunch", order: 1 }),
          block({ id: "b3", kind: "activity", title: "Afternoon traverse", order: 2, track: "/media/t1/bbb.gpx" }),
        ]),
      ],
    });
    const s = daySurface(t, 0)!;
    expect(s.tracks).toEqual([
      { blockId: "b1", url: "/media/t1/aaa.gpx" },
      { blockId: "b3", url: "/media/t1/bbb.gpx" },
    ]);
  });

  it("a day without tracks reports an empty list, never undefined", () => {
    const t = trip({ days: [day([block({ id: "b1", kind: "note", title: "Rest", order: 0 })])] });
    expect(daySurface(t, 0)!.tracks).toEqual([]);
  });
});
