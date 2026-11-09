/**
 * The renderer's side of the server-derived shape (#457).
 *
 * `lib/journey` hydrates `trip.journey` / `day.surface` into the types the
 * components speak. It derives NOTHING — the rules live in
 * `backend/app/journey.py` and are pinned by `backend/tests/test_journey.py`
 * plus the captured golden fixtures. What is worth testing here is the
 * hydration contract: names resolve through the registry (alias included),
 * wires without a payload degrade to nothing rather than to a second
 * implementation, and the leg modes the map sends come from the payload.
 */

import { describe, expect, it } from "vitest";
import {
  apiJourney,
  daySurface,
  journeyModes,
  journeyOrder,
  placeRailHandle,
  placeRole,
  tripJourney,
} from "./journey";
import type { ApiJourney, Trip } from "./types";

function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "t1",
    slug: "t1",
    title: "A trip",
    stage: "shortlist",
    visibility: "public",
    crew: [],
    practical: {},
    locations: [
      { name: "Base Village", lat: 45, lng: 6, alias: ["Base"] },
      { name: "Summit Trailhead", lat: 45.4, lng: 6.5 },
      { name: "Far City", lat: 48.5, lng: 9 },
    ],
    days: [
      { id: "d0", date: "2027-07-01", title: "Base", blocks: [] },
      { id: "d1", date: "2027-07-02", title: "Trailhead", blocks: [] },
    ],
    ...overrides,
  };
}

const JOURNEY: ApiJourney = {
  stops: ["Base Village", "Summit Trailhead", "Far City"],
  chain: ["Base Village", "Far City"],
  visits: [
    { place: "Base Village", days: [0] },
    { place: "Far City", days: [1] },
  ],
  legs: [
    {
      from: "Base Village",
      to: "Far City",
      stage: "planned",
      mode: "drive",
      gap: false,
      blockId: "b7",
    },
  ],
  loop: false,
  excursions: ["Summit Trailhead"],
  rail: { "Base Village": { kind: "pill", refs: ["Base"] } },
};

describe("tripJourney", () => {
  it("hydrates the payload's names into the trip's own locations", () => {
    const j = tripJourney(trip({ journey: JOURNEY }));
    expect(j.chain.map((l) => l.name)).toEqual(["Base Village", "Far City"]);
    expect(j.stops).toHaveLength(3);
    expect(j.excursions.map((l) => l.name)).toEqual(["Summit Trailhead"]);
    expect(j.visits).toEqual([
      { place: j.stops[0], days: [0] },
      { place: j.stops[2], days: [1] },
    ]);
  });

  it("resolves a payload name through the registry's alias", () => {
    const j = tripJourney(
      trip({
        journey: { ...JOURNEY, chain: ["Base", "Far City"], visits: [], stops: [] },
      }),
    );
    expect(j.chain.map((l) => l.name)).toEqual(["Base Village", "Far City"]);
  });

  it("carries each leg's block and mode, so the map needs no lookup", () => {
    const blocks = [{ id: "b7", kind: "transport" as const, title: "Drive", mode: "drive" as const }];
    const t = trip({ journey: JOURNEY });
    t.days[0].blocks = blocks;
    const j = tripJourney(t);
    expect(j.legs).toHaveLength(1);
    expect(j.legs[0].stage).toBe("planned");
    expect(j.legs[0].mode).toBe("drive");
    expect(j.legs[0].block?.id).toBe("b7");
  });

  it("drops a wire entry the registry cannot resolve", () => {
    const j = tripJourney(
      trip({ journey: { ...JOURNEY, chain: ["Base Village", "Atlantis"] } }),
    );
    expect(j.chain.map((l) => l.name)).toEqual(["Base Village"]);
  });

  it("degrades to nothing when the document predates the payload", () => {
    const t = trip();
    expect(apiJourney(t).chain).toEqual([]);
    const j = tripJourney(t);
    expect(j).toEqual({ stops: [], chain: [], visits: [], legs: [], loop: false, excursions: [] });
    expect(journeyOrder(t)).toEqual([]);
  });
});

describe("journeyModes", () => {
  it("marks an unauthored pair as a gap and keeps a silent block's road default", () => {
    const j = tripJourney(
      trip({
        journey: {
          ...JOURNEY,
          legs: [
            { from: "Base Village", to: "Far City", stage: "planned", mode: "drive", gap: false, blockId: "b7" },
            { from: "Far City", to: "Base Village", stage: "provisional", mode: null, gap: true, blockId: null },
            { from: "Base Village", to: "Summit Trailhead", stage: "planned", mode: null, gap: false, blockId: "b8" },
          ],
        },
      }),
    );
    expect(journeyModes(j)).toEqual(["drive", "gap", undefined]);
  });
});

describe("placeRole and the rail handle", () => {
  it("reads the excursion set from the payload", () => {
    const t = trip({ journey: JOURNEY });
    expect(placeRole(t, "Summit Trailhead")).toBe("excursion");
    expect(placeRole(t, "Base")).toBe("stop"); // alias of a chain stop
  });

  it("finds the rail handle by registry name, asked by alias", () => {
    const t = trip({ journey: JOURNEY });
    expect(placeRailHandle(t, "Base Village")).toEqual({ kind: "pill", refs: ["Base"] });
    expect(placeRailHandle(t, "Base")).toEqual({ kind: "pill", refs: ["Base"] });
    expect(placeRailHandle(t, "Far City")).toBeNull();
    expect(placeRailHandle(t, "Atlantis")).toBeNull();
  });
});

describe("daySurface", () => {
  const withSurface = (): Trip =>
    trip({
      journey: JOURNEY,
      days: [
        {
          id: "d0",
          date: "2027-07-01",
          title: "Base",
          blocks: [
            { id: "b1", kind: "transport", title: "Drive", mode: "drive" },
            { id: "a1", kind: "activity", title: "Ski" },
            { id: "a2", kind: "activity", title: "Sauna" },
          ],
          surface: {
            markers: [
              { role: "place", place: "Base Village" },
              { role: "activity", place: "Base Village", letter: "A", blockIds: ["a1", "a2"] },
            ],
            legs: [
              { from: "Base Village", to: "Far City", blockId: "b1", stage: "planned", mode: "drive" },
            ],
            endpoints: ["Base Village"],
            tracks: [{ blockId: "a1", url: "/media/t1/day1.gpx" }],
          },
        },
        { id: "d1", date: "2027-07-02", title: "No surface", blocks: [] },
      ],
    });

  it("hydrates markers, legs and the letter map", () => {
    const s = daySurface(withSurface(), 0);
    expect(s).not.toBeNull();
    expect(s!.markers.map((m) => m.role)).toEqual(["place", "activity"]);
    const chip = s!.markers[1];
    expect(chip.role === "activity" && chip.letter).toBe("A");
    expect(s!.legs[0].block.id).toBe("b1");
    expect(s!.endpoints.map((p) => p.name)).toEqual(["Base Village"]);
    expect([...s!.letters.entries()]).toEqual([
      ["a1", "A"],
      ["a2", "A"],
    ]);
    expect(s!.tracks).toEqual([{ blockId: "a1", url: "/media/t1/day1.gpx" }]);
  });

  it("is null for a day without a payload and past the last day", () => {
    const t = withSurface();
    expect(daySurface(t, 1)).toBeNull();
    expect(daySurface(t, 9)).toBeNull();
  });
});
