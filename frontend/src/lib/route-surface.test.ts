import { describe, expect, it } from "vitest";
import {
  blockEndpoints,
  dayRangeLabel,
  daysAtLocation,
  greatCircle,
  journeyOrder,
  legBlock,
  legStage,
  locationsInText,
  returnsToStart,
  stageToLegStage,
  tripJourney,
} from "./route-surface";
import type { Trip, TripLocation } from "./types";

const loc = (name: string, lat: number, lng: number, alias: string[] = []): TripLocation => ({
  name,
  alias,
  lat,
  lng,
});

/** A canada-2027-shaped trip: airport in, four stops, drive back to the airport. */
function canada(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "t1",
    slug: "canada-2027",
    title: "Canada 2027",
    stage: "booked",
    visibility: "private",
    crew: [],
    practical: {},
    locations: [
      loc("YYC", 51.1215, -114.0079, ["Calgary"]),
      loc("Banff", 51.1784, -115.5708),
      loc("Revelstoke", 50.9981, -118.1957, ["Hillcrest"]),
      loc("Golden", 51.292, -116.9656),
      loc("Rogers Pass", 51.3019, -117.5167, ["Glacier National Park"]),
    ],
    sections: [
      { id: "s0", title: "Arrival", days: [0, 1], locationRefs: ["Banff"] },
      { id: "s1", title: "Revelstoke", days: [2, 3], locationRefs: ["Revelstoke"] },
      { id: "s2", title: "Kicking Horse", days: [4, 4], locationRefs: ["Golden"] },
    ],
    days: [
      {
        id: "d0",
        date: "2027-02-13",
        title: "Fly in",
        blocks: [
          { id: "b0", kind: "transport", mode: "flight", title: "BRU → YYC", status: "booked" },
          { id: "b1", kind: "transport", title: "Drive YYC → Banff", to: "Banff" },
        ],
      },
      { id: "d1", date: "2027-02-14", title: "Sunshine", blocks: [] },
      {
        id: "d2",
        date: "2027-02-15",
        title: "Over the pass",
        blocks: [{ id: "b2", kind: "transport", title: "Drive Banff → Revelstoke", to: "Revelstoke" }],
      },
      { id: "d3", date: "2027-02-16", title: "Powder", blocks: [] },
      {
        id: "d4",
        date: "2027-02-17",
        title: "Kicking Horse",
        blocks: [{ id: "b3", kind: "transport", title: "Drive Revelstoke → Golden", to: "Golden" }],
      },
      {
        id: "d5",
        date: "2027-02-18",
        title: "The road home",
        blocks: [
          { id: "b4", kind: "transport", title: "Drive Golden → YYC", to: "YYC" },
          { id: "b5", kind: "transport", mode: "flight", title: "YYC → BRU", status: "booked" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("locationsInText", () => {
  const trip = canada();

  it("finds places named in prose, in the order they appear", () => {
    expect(locationsInText(trip, "Drive Golden → YYC").map((l) => l.name)).toEqual([
      "Golden",
      "YYC",
    ]);
  });

  it("matches aliases", () => {
    expect(locationsInText(trip, "Coast Hillcrest check-in").map((l) => l.name)).toEqual([
      "Revelstoke",
    ]);
  });

  it("requires a word boundary — no substring hits", () => {
    expect(locationsInText(trip, "Goldeneye premiere")).toEqual([]);
  });

  it("drops a hit nested inside a longer one", () => {
    // "Sapporo" is an alias of New Chitose AND a prefix of two other places;
    // the longest match is the real one.
    const jp: Trip = {
      ...canada(),
      locations: [
        loc("New Chitose", 42.7752, 141.6923, ["Sapporo"]),
        loc("Sapporo Kokusai", 43.0728, 141.2073),
      ],
    };
    expect(locationsInText(jp, "Laps at Sapporo Kokusai").map((l) => l.name)).toEqual([
      "Sapporo Kokusai",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(locationsInText(trip, undefined)).toEqual([]);
    expect(locationsInText(trip, "")).toEqual([]);
  });
});

describe("stageToLegStage", () => {
  it("treats the pre-commitment stages as provisional", () => {
    expect(stageToLegStage("idea")).toBe("provisional");
    expect(stageToLegStage("options")).toBe("provisional");
    expect(stageToLegStage("shortlist")).toBe("provisional");
  });

  it("maps planned to planned and everything committed to booked", () => {
    expect(stageToLegStage("planned")).toBe("planned");
    expect(stageToLegStage("booked")).toBe("booked");
    expect(stageToLegStage("live")).toBe("booked");
    expect(stageToLegStage("archive")).toBe("booked");
  });
});

describe("legStage", () => {
  it("prefers the leg's own transport block status over the trip stage", () => {
    const trip = canada({ stage: "idea" });
    const [yyc, banff] = trip.locations!;
    trip.days[0].blocks[1].status = "booked";
    expect(legStage(trip, yyc, banff).stage).toBe("booked");
  });

  it("falls back to the trip stage when the block carries no status", () => {
    const trip = canada();
    const [yyc, banff] = trip.locations!;
    // A drive is not something you book — the block exists but says nothing,
    // so the trip's own stage answers.
    expect(legStage(trip, yyc, banff)).toMatchObject({ stage: "booked" });
    expect(legStage(trip, yyc, banff).block?.title).toBe("Drive YYC → Banff");
  });

  it("falls back to the trip stage when no block describes the leg", () => {
    const trip = canada({ stage: "shortlist" });
    const golden = trip.locations![3];
    const rogers = trip.locations![4];
    expect(legStage(trip, golden, rogers)).toEqual({ stage: "provisional", block: undefined });
  });

  it("matches a leg regardless of direction", () => {
    const trip = canada();
    const [yyc, banff] = trip.locations!;
    expect(legStage(trip, banff, yyc).block?.title).toBe("Drive YYC → Banff");
  });

  it("ignores non-transport blocks", () => {
    const trip = canada({ stage: "idea" });
    const [yyc, banff] = trip.locations!;
    trip.days[0].blocks = [
      { id: "n", kind: "note", title: "YYC to Banff is easy", status: "booked" },
    ];
    expect(legStage(trip, yyc, banff)).toEqual({ stage: "provisional", block: undefined });
  });
});

describe("daysAtLocation", () => {
  const trip = canada();

  it("unions block references, day titles and section locationRefs", () => {
    // Banff: the day-0 arrival drive, section 0's range (days 0-1), and the
    // day-2 departure drive that names it — leaving a place is a day at it.
    expect(daysAtLocation(trip, "Banff")).toEqual([0, 1, 2]);
    // Revelstoke: the day-2 drive plus section 1's range.
    expect(daysAtLocation(trip, "Revelstoke")).toEqual([2, 3, 4]);
  });

  it("resolves by alias", () => {
    expect(daysAtLocation(trip, "Hillcrest")).toEqual(daysAtLocation(trip, "Revelstoke"));
  });

  it("picks up a place named only in prose", () => {
    // YYC never appears as a `location`, only in two flight titles and a drive.
    expect(daysAtLocation(trip, "YYC")).toEqual([0, 5]);
  });

  it("returns [] for an unknown place", () => {
    expect(daysAtLocation(trip, "Whistler")).toEqual([]);
  });
});

describe("returnsToStart", () => {
  it("is true when the first place is visited near both ends", () => {
    expect(returnsToStart(canada())).toBe(true);
  });

  it("is false for a one-way trip", () => {
    const trip = canada();
    // Fly home from Golden instead of driving back to Calgary.
    trip.days[5].blocks = [{ id: "b4", kind: "transport", mode: "flight", title: "Golden → BRU" }];
    expect(returnsToStart(trip)).toBe(false);
  });

  it("is false for a trip too short to loop", () => {
    const trip = canada();
    trip.days = trip.days.slice(0, 2);
    expect(returnsToStart(trip)).toBe(false);
  });
});

describe("tripJourney", () => {
  it("chains the marker registry in order and closes the loop", () => {
    const j = tripJourney(canada());
    expect(j.stops.map((s) => s.name)).toEqual([
      "YYC",
      "Banff",
      "Revelstoke",
      "Golden",
      "Rogers Pass",
    ]);
    expect(j.loop).toBe(true);
    expect(j.legs.map((l) => `${l.from.name}→${l.to.name}`)).toEqual([
      "YYC→Banff",
      "Banff→Revelstoke",
      "Revelstoke→Golden",
      "Golden→Rogers Pass",
      "Rogers Pass→YYC",
    ]);
  });

  it("omits the closing leg on a one-way trip", () => {
    const trip = canada();
    trip.days[5].blocks = [{ id: "b4", kind: "transport", mode: "flight", title: "Golden → BRU" }];
    const j = tripJourney(trip);
    expect(j.loop).toBe(false);
    expect(j.legs).toHaveLength(4);
  });

  it("marks every leg provisional on an idea-stage trip with no leg blocks", () => {
    const trip = canada({ stage: "idea" });
    trip.days = trip.days.map((d) => ({ ...d, blocks: [] }));
    expect(tripJourney(trip).legs.every((l) => l.stage === "provisional")).toBe(true);
  });

  it("drops places with no coordinates", () => {
    const trip = canada();
    trip.locations = [...trip.locations!, { name: "TBD", alias: [] }];
    expect(tripJourney(trip).stops.map((s) => s.name)).not.toContain("TBD");
  });

  it("chains an excursion where the itinerary puts it, not where the registry does", () => {
    const trip = canada();
    // Rogers Pass sits between Revelstoke and Golden but was added to the
    // registry last; a day-3 block naming it is the evidence that fixes the
    // chain. Marker numbers stay registry-ordered.
    trip.days[3].blocks = [{ id: "b9", kind: "activity", title: "Tour Rogers Pass" }];
    expect(journeyOrder(trip).map((s) => s.name)).toEqual([
      "YYC",
      "Banff",
      "Revelstoke",
      "Rogers Pass",
      "Golden",
    ]);
    expect(tripJourney(trip).legs.map((l) => `${l.from.name}→${l.to.name}`)).toEqual([
      "YYC→Banff",
      "Banff→Revelstoke",
      "Revelstoke→Rogers Pass",
      "Rogers Pass→Golden",
      "Golden→YYC",
    ]);
    // `stops` — the list and the markers — stays registry order.
    expect(tripJourney(trip).stops.map((s) => s.name)).toEqual([
      "YYC",
      "Banff",
      "Revelstoke",
      "Golden",
      "Rogers Pass",
    ]);
  });

  it("keeps registry order for places no day mentions", () => {
    const trip = canada();
    trip.days = trip.days.map((d) => ({ ...d, blocks: [] }));
    trip.sections = [];
    expect(journeyOrder(trip).map((s) => s.name)).toEqual(
      trip.locations!.map((l) => l.name),
    );
  });

  it("produces no legs for a trip with a single place", () => {
    const trip = canada();
    trip.locations = [loc("Banff", 51.1784, -115.5708)];
    expect(tripJourney(trip).legs).toEqual([]);
  });
});

describe("greatCircle", () => {
  it("starts and ends on the endpoints", () => {
    const pts = greatCircle([-70.6693, -33.4489], [-77.0428, -12.0464], 8);
    expect(pts).toHaveLength(9);
    expect(pts[0][0]).toBeCloseTo(-70.6693, 4);
    expect(pts[8][1]).toBeCloseTo(-12.0464, 4);
  });

  it("bows away from the straight line between distant points", () => {
    const a: [number, number] = [-114.0079, 51.1215];
    const b: [number, number] = [141.6923, 42.7752];
    const pts = greatCircle(a, b, 8);
    const mid = pts[4];
    const straightMidLat = (a[1] + b[1]) / 2;
    expect(mid[1]).toBeGreaterThan(straightMidLat);
  });

  it("degenerates to the two endpoints when they coincide", () => {
    expect(greatCircle([5, 50], [5, 50])).toEqual([
      [5, 50],
      [5, 50],
    ]);
  });
});

describe("dayRangeLabel", () => {
  it("renders a single day", () => {
    expect(dayRangeLabel([3])).toBe("Day 4");
  });

  it("renders a contiguous run as a range", () => {
    expect(dayRangeLabel([2, 3, 4, 5])).toBe("Days 3–6");
  });

  it("groups gaps into runs rather than listing every day", () => {
    expect(dayRangeLabel([0, 1, 2, 12, 14])).toBe("Days 1–3, 13, 15");
  });

  it("does NOT expand a two-element list as an inclusive range", () => {
    // `sectionRange` would say "Days 1–15" here — the section storage
    // convention, and wrong for a literal day list.
    expect(dayRangeLabel([0, 14])).toBe("Days 1, 15");
  });

  it("tolerates unsorted input and duplicates", () => {
    expect(dayRangeLabel([4, 2, 3, 2])).toBe("Days 3–5");
  });

  it("is null for no days", () => {
    expect(dayRangeLabel([])).toBeNull();
  });
});

describe("blockEndpoints", () => {
  const trip = canada();

  it("fills a missing `from` from the title's place order", () => {
    const b = trip.days[0].blocks[1]; // to: "Banff", title "Drive YYC → Banff"
    const e = blockEndpoints(trip, b);
    expect([e.from?.name, e.to?.name]).toEqual(["YYC", "Banff"]);
  });

  it("has no `to` when only one place is named", () => {
    const e = blockEndpoints(trip, { id: "x", kind: "transport", title: "Land at YYC" });
    expect(e.from?.name).toBe("YYC");
    expect(e.to).toBeUndefined();
  });

  it("does not hand one block to a leg it merely mentions in passing", () => {
    // "over the pass" is prose, but a title naming three places would give a
    // touches-both match to legs the block does not describe.
    const t = canada();
    t.days[2].blocks = [
      { id: "b", kind: "transport", to: "Revelstoke", title: "Drive Banff → Revelstoke via Rogers Pass" },
    ];
    const [, banff, revelstoke, , rogers] = t.locations!;
    expect(legBlock(t, banff, revelstoke)?.id).toBe("b");
    expect(legBlock(t, revelstoke, rogers)).toBeUndefined();
  });
});
