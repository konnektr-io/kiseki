import { describe, expect, it } from "vitest";
import {
  blockEndpoints,
  blockPlaces,
  dayRangeLabel,
  daysAtLocation,
  GATEWAY_MATCH_KM,
  gatewayMatch,
  greatCircle,
  isRegistryScaffold,
  journeyOrder,
  legBlock,
  legModes,
  legStage,
  locationsInText,
  LEG_STAGE_LABELS,
  markerPaintRank,
  placeDays,
  placeRailHandle,
  placeRole,
  resolveLegCoordinates,
  returnsToStart,
  stageToLegStage,
  tripExcursions,
  tripJourney,
} from "./route-surface";
import type { Block, Day, Trip, TripLocation } from "./types";
import MapViewSrc from "../components/MapView.tsx?raw";
import RouteMapSrc from "../components/RouteMap.tsx?raw";

const loc = (name: string, lat: number, lng: number, alias: string[] = []): TripLocation => ({
  name,
  alias,
  lat,
  lng,
});

/** A calendar-truthful day entry: id/date derived from the 0-based index. */
const dayAt = (idx: number, title: string, blocks: Block[] = [], month = "02"): Day => ({
  id: `d${idx}`,
  date: `2027-${month}-${String(1 + idx).padStart(2, "0")}`,
  title,
  blocks,
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

/**
 * Live-shaped canada-2027 (post-#89 content conventions): 15 calendar days,
 * endpointed transports, and the two #91 hazards the live data carried —
 * Rogers Pass named in day-title prose only (an excursion from Revelstoke,
 * never a transport endpoint or chapter base), and `via` mentions of Banff on
 * the Lake Louise drives that used to smear days onto Banff.
 *
 * Labels the derivation must produce (1-based, see the tests below):
 * YYC Days 1, 15 · Banff 1–3 · Revelstoke 3–10 · Golden 10–13 ·
 * Lake Louise 13–15 · Rogers Pass Day 5, an excursion.
 */
function canadaLive(): Trip {
  return {
    id: "t-ca",
    slug: "canada-2027",
    title: "Canada 2027",
    stage: "booked",
    visibility: "private",
    crew: [],
    practical: {},
    locations: [
      loc("YYC", 51.1215, -114.0079, ["Calgary"]),
      loc("Banff", 51.1784, -115.5708),
      loc("Revelstoke", 50.9981, -118.1957),
      loc("Golden", 51.292, -116.9656),
      loc("Lake Louise", 51.4254, -116.1773),
      loc("Rogers Pass", 51.3019, -117.5167, ["Glacier National Park"]),
    ],
    sections: [
      { id: "s0", title: "Arrival & Banff", days: [0, 2], locationRefs: ["Banff"] },
      { id: "s1", title: "Revelstoke heli days", days: [2, 9], locationRefs: ["Revelstoke"] },
      { id: "s2", title: "Kicking Horse, Golden", days: [9, 12], locationRefs: ["Golden"] },
      { id: "s3", title: "Lake Louise", days: [12, 13], locationRefs: ["Lake Louise"] },
      { id: "s4", title: "The way home", days: [14, 14], locationRefs: ["Lake Louise"] },
    ],
    days: [
      dayAt(0, "Fly in", [
        { id: "b0", kind: "transport", mode: "flight", title: "Brussels → Calgary (YYC)", status: "booked" },
        { id: "b1", kind: "transport", title: "Drive YYC → Banff", to: "Banff" },
      ]),
      dayAt(1, "Sunshine"),
      dayAt(2, "Over the pass", [
        { id: "b2", kind: "transport", title: "Drive Banff → Revelstoke", to: "Revelstoke", via: "Rogers Pass" },
      ]),
      dayAt(3, "Heli day 1"),
      dayAt(4, "Heli day at Rogers Pass", [
        { id: "b3", kind: "activity", title: "Heli laps above the tree line" },
      ]),
      dayAt(5, "Heli day 3"),
      dayAt(6, "Rest day in Revelstoke"),
      dayAt(7, "Cat ski"),
      dayAt(8, "Last heli day"),
      dayAt(9, "To Golden", [
        { id: "b4", kind: "transport", title: "Drive Revelstoke → Golden", to: "Golden" },
      ]),
      dayAt(10, "Kicking Horse"),
      dayAt(11, "Kicking Horse"),
      dayAt(12, "To Lake Louise", [
        { id: "b5", kind: "transport", title: "Drive Golden → Lake Louise", to: "Lake Louise", via: "Banff" },
      ]),
      dayAt(13, "Lake Louise ski day"),
      dayAt(14, "The long way home", [
        { id: "b6", kind: "transport", title: "Drive Lake Louise → Calgary", to: "YYC", via: "Banff, Canmore" },
        { id: "b7", kind: "transport", mode: "flight", title: "YYC → Brussels", status: "booked" },
      ]),
    ],
  };
}

/**
 * Live-shaped chile-peru-2027: 17 days where ONE chapter covers TWO bases
 * ("Santiago & the Andes" refs Santiago AND Valle Nevado) and chapters
 * overlap (the Sacred Valley chapter overlaps the Cusco chapter). The #91
 * hazard: co-located chapters used to smear across each other.
 *
 * Labels (1-based): Santiago Days 1–4, 7–8 · Valle Nevado 4–7 ·
 * Sacred Valley 8–10 · Machu Picchu 10–11 · Cusco 8–9, 12–14 · Lima 15–17.
 * Day 7 is Santiago's (the SCL→CUZ overnight flight is authored on its
 * arrival day, day 8) and day 8 is Cusco's arrival AND the valley's stay —
 * a transfer day belongs to both its endpoints. Cusco's day-9/10 hole is the
 * Machu Picchu visit, which is calendar truth, not a derivation leak.
 */
function chile(): Trip {
  return {
    id: "t-cl",
    slug: "chile-peru-2027",
    title: "Chile & Peru 2027",
    stage: "planned",
    visibility: "private",
    crew: [],
    practical: {},
    locations: [
      loc("Santiago", -33.4489, -70.6693),
      loc("Valle Nevado", -33.1969, -70.2711),
      loc("Sacred Valley", -13.2865, -72.1325, ["Ollantaytambo"]),
      loc("Machu Picchu", -13.1631, -72.545, ["Aguas Calientes"]),
      loc("Cusco", -13.5319, -71.9675),
      loc("Lima", -12.0464, -77.0428),
    ],
    sections: [
      {
        id: "s0",
        title: "Santiago & the Andes",
        days: [0, 6],
        locationRefs: ["Santiago", "Valle Nevado"],
      },
      { id: "s1", title: "Sacred Valley", days: [7, 10], locationRefs: ["Sacred Valley", "Machu Picchu"] },
      { id: "s2", title: "Cusco", days: [7, 13], locationRefs: ["Cusco"] },
      { id: "s3", title: "Lima", days: [14, 16], locationRefs: ["Lima"] },
    ],
    days: [
      dayAt(0, "Fly in", [{ id: "c0", kind: "transport", mode: "flight", title: "Brussels → Santiago", status: "booked" }], "07"),
      dayAt(1, "Santiago on foot", [], "07"),
      dayAt(2, "Cerro San Cristóbal", [], "07"),
      dayAt(3, "Into the Andes", [
        { id: "c1", kind: "transport", title: "Drive Santiago → Valle Nevado", to: "Valle Nevado", status: "booked" },
      ], "07"),
      dayAt(4, "Ski day", [{ id: "c2", kind: "activity", title: "Ski the chutes", location: "Valle Nevado" }], "07"),
      dayAt(5, "Ski day", [{ id: "c3", kind: "activity", title: "Primeros polvos", location: "Valle Nevado" }], "07"),
      dayAt(6, "Back down, fly north", [
        { id: "c4", kind: "transport", title: "Drive Valle Nevado → Santiago", to: "Santiago", status: "booked" },
      ], "07"),
      dayAt(7, "Overnight flight lands — into the valley", [
        { id: "c5", kind: "transport", mode: "flight", title: "Santiago → Cusco (overnight)", from: "Santiago", to: "Cusco" },
        { id: "c6", kind: "transport", title: "Land in Cusco — drive into the Sacred Valley", from: "Cusco", to: "Sacred Valley" },
      ], "07"),
      dayAt(8, "Valley acclimatise", [], "07"),
      dayAt(9, "Train to the mountain", [
        { id: "c7", kind: "transport", title: "Train to Aguas Calientes", from: "Sacred Valley", to: "Machu Picchu" },
      ], "07"),
      dayAt(10, "Machu Picchu", [{ id: "c8", kind: "activity", title: "Sunrise entry", location: "Machu Picchu" }], "07"),
      dayAt(11, "Cusco buffer", [{ id: "c9", kind: "activity", title: "Wander San Blas", location: "Cusco" }], "07"),
      dayAt(12, "Cusco buffer", [], "07"),
      dayAt(13, "Cusco buffer", [{ id: "c10", kind: "activity", title: "San Pedro market", location: "Cusco" }], "07"),
      dayAt(14, "To the coast", [{ id: "c11", kind: "transport", mode: "flight", title: "Fly to Lima", to: "Lima" }], "07"),
      dayAt(15, "Lima", [], "07"),
      dayAt(16, "Fly home", [{ id: "c12", kind: "transport", mode: "flight", title: "Lima → Brussels", from: "Lima" }], "07"),
    ],
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

describe("blockPlaces (#91: prose scope)", () => {
  const trip = canadaLive();

  it("reads explicit fields and the block title — not the road prose", () => {
    const b = trip.days[2].blocks[0]; // Drive Banff → Revelstoke, via Rogers Pass
    // Order is not meaningful in blockPlaces; the SET of places is.
    expect(blockPlaces(trip, b).map((l) => l.name).sort()).toEqual(["Banff", "Revelstoke"]);
  });

  it("never attributes a day through via/route — the matching itself works", () => {
    // The text matcher finds Banff fine; it is blockPlaces' SCOPING that
    // excludes the road fields. "Via Banff, Canmore" is a road fact.
    expect(locationsInText(trip, "Via Banff, Canmore").map((l) => l.name)).toEqual(["Banff"]);
    const b = trip.days[14].blocks[0];
    expect(blockPlaces(trip, b).map((l) => l.name).sort()).toEqual(["Lake Louise", "YYC"]);
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

  it("may use via/route to FILL an endpoint but explicit fields win (#91 asymmetry)", () => {
    // Leg matching is allowed the leniency day attribution is denied: a
    // to-only drive whose road prose names the origin still matches its leg.
    const t = canadaLive();
    const b = t.days[2].blocks[0]; // to: Revelstoke, title names Banff, via Rogers Pass
    const e = blockEndpoints(t, b);
    expect([e.from?.name, e.to?.name]).toEqual(["Banff", "Revelstoke"]);
  });
});

describe("legBlock gateway matching (#361 slice 4: airports are gateways)", () => {
  // City pair with their real airports: SCL ≈ 12.5 km from Santiago, CUZ ≈
  // 3.1 km from Cusco — both inside GATEWAY_MATCH_KM (50). The far airport is
  // ≈ 130 km out. Neutral titles throughout: blockEndpoints falls back to
  // title prose, and these tests isolate the endpoint proximity rule.
  const santiago = loc("Santiago", -33.4489, -70.6693);
  const cusco = loc("Cusco", -13.5319, -71.9675);
  const scl = loc("Luchthaven Santiago", -33.3929, -70.7856);
  const cuz = loc("Luchthaven Cusco", -13.5357, -71.9388);
  const far = loc("Far Airport", -34.6, -70.9);

  const gatewayTrip = (blocks: Block[]): Trip =>
    ({
      id: "t-gw",
      slug: "gateway",
      title: "Gateway",
      stage: "planned",
      visibility: "private",
      crew: [],
      practical: {},
      locations: [santiago, cusco, scl, cuz, far],
      sections: [],
      days: [dayAt(0, "Travel day", blocks)],
    }) as unknown as Trip;

  it(`matches a flight whose airports sit within ${GATEWAY_MATCH_KM} km of the cities`, () => {
    const t = gatewayTrip([
      { id: "f", kind: "transport", mode: "flight", title: "Morning flight", from: "Luchthaven Santiago", to: "Luchthaven Cusco" },
    ]);
    expect(legBlock(t, santiago, cusco)?.id).toBe("f");
  });

  it("matches a ferry the same way — the rule is flight/ferry only", () => {
    const t = gatewayTrip([
      { id: "f", kind: "transport", mode: "ferry", title: "Morning crossing", from: "Luchthaven Santiago", to: "Luchthaven Cusco" },
    ]);
    expect(legBlock(t, santiago, cusco)?.id).toBe("f");
  });

  it("matches regardless of direction", () => {
    const t = gatewayTrip([
      { id: "f", kind: "transport", mode: "flight", title: "Morning flight", from: "Luchthaven Santiago", to: "Luchthaven Cusco" },
    ]);
    expect(legBlock(t, cusco, santiago)?.id).toBe("f");
  });

  it("above-threshold airports do NOT match", () => {
    const t = gatewayTrip([
      { id: "f", kind: "transport", mode: "flight", title: "Morning flight", from: "Far Airport", to: "Luchthaven Cusco" },
    ]);
    expect(legBlock(t, santiago, cusco)).toBeUndefined();
  });

  it.each(["drive", "train", undefined] as const)(
    "a %s block never proximity-matches — exact-registry only (#91 stands)",
    (mode) => {
      const t = gatewayTrip([
        { id: "d", kind: "transport", mode: mode, title: "Morning run", from: "Luchthaven Santiago", to: "Luchthaven Cusco" } as Block,
      ]);
      expect(legBlock(t, santiago, cusco)).toBeUndefined();
    },
  );

  it("a block with an unresolvable endpoint matches nothing (from None / to None)", () => {
    // BRU→SCL in the live data: Brussels is not a registry place, so `from`
    // resolves to nothing — no origin to draw from. Correct, not a bug.
    const noFrom = gatewayTrip([
      { id: "f", kind: "transport", mode: "flight", title: "Outbound flight", from: "Brussels", to: "Luchthaven Cusco" },
    ]);
    expect(legBlock(noFrom, santiago, cusco)).toBeUndefined();
    const noTo = gatewayTrip([
      { id: "f", kind: "transport", mode: "flight", title: "Home flight", from: "Luchthaven Santiago", to: "Home" },
    ]);
    expect(legBlock(noTo, santiago, cusco)).toBeUndefined();
  });

  it("exact matching still wins over proximity", () => {
    const t = gatewayTrip([
      { id: "gw", kind: "transport", mode: "flight", title: "Morning flight", from: "Luchthaven Santiago", to: "Luchthaven Cusco" },
      { id: "ex", kind: "transport", mode: "flight", title: "City hop", from: "Santiago", to: "Cusco" },
    ]);
    // Gateway block listed first — priority is by match kind, not position.
    expect(legBlock(t, santiago, cusco)?.id).toBe("ex");
  });

  it("legStage inherits the gateway match — a matched flight is not provisional", () => {
    const t = gatewayTrip([
      { id: "f", kind: "transport", mode: "flight", title: "Morning flight", from: "Luchthaven Santiago", to: "Luchthaven Cusco" },
    ]);
    expect(legStage(t, santiago, cusco)).toMatchObject({ stage: "planned", block: { id: "f" } });
  });

  it("gatewayMatch is direction-insensitive and refuses a half-near pair", () => {
    expect(gatewayMatch(santiago, cusco, scl, cuz)).toBe(true);
    expect(gatewayMatch(santiago, cusco, cuz, scl)).toBe(true);
    expect(gatewayMatch(santiago, cusco, far, cuz)).toBe(false);
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

  it("labels the three leg states", () => {
    expect(LEG_STAGE_LABELS).toEqual({
      provisional: "Provisional",
      planned: "Planned",
      booked: "Booked",
    });
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

  it("never inherits the trip stage when NO block describes the leg (#91)", () => {
    // The #91 symptom: on a booked trip, a chain gap the derivation joins but
    // nobody authored drew as a SOLID BOOKED leg. Provisional, full stop.
    const trip = canada({ stage: "booked" });
    const [, , revelstoke, golden] = trip.locations!;
    trip.days[4].blocks = []; // the only Revelstoke → Golden drive, deleted
    expect(legStage(trip, revelstoke, golden)).toEqual({ stage: "provisional", block: undefined });
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

describe("placeRole (#91: stop vs excursion)", () => {
  it("a transport endpoint is a stop", () => {
    const trip = canadaLive();
    const [, banff] = trip.locations!;
    expect(placeRole(trip, banff.name)).toBe("stop");
  });

  it("a section locationRef base is a stop", () => {
    const trip = chile();
    expect(placeRole(trip, "Cusco")).toBe("stop");
  });

  it("a flight gateway is a stop even without endpoint fields", () => {
    const trip = canadaLive();
    const [yyc] = trip.locations!;
    expect(placeRole(trip, yyc.name)).toBe("stop");
  });

  it("a place only toured from a base is an excursion — Rogers Pass", () => {
    const trip = canadaLive();
    const rogers = trip.locations![5];
    // Never a transport endpoint, never a chapter base, no flight names it.
    // The day-2 drive's via mention is the ROAD, not a re-base.
    expect(placeRole(trip, rogers.name)).toBe("excursion");
  });

  it("resolves aliases", () => {
    const trip = canadaLive();
    expect(placeRole(trip, "Glacier National Park")).toBe("excursion");
  });

  it("an unknown place is an excursion, never a stop", () => {
    expect(placeRole(canada(), "Whistler")).toBe("excursion");
  });
});

describe("isRegistryScaffold (#91)", () => {
  it("is false for a trip with real re-base evidence", () => {
    expect(isRegistryScaffold(canadaLive())).toBe(false);
    expect(isRegistryScaffold(chile())).toBe(false);
  });

  it("chains the registry when NO place has re-base evidence", () => {
    // A scaffold trip: curated places, no transports or chapters yet. Exiling
    // everything to excursion would blank the route for the trips still
    // being sketched — the registry IS the author's statement of intent.
    const trip = canada();
    trip.days = trip.days.map((d) => ({ ...d, blocks: [] }));
    trip.sections = [];
    expect(isRegistryScaffold(trip)).toBe(true);
    expect(journeyOrder(trip).map((s) => s.name)).toEqual(
      trip.locations!.map((l) => l.name),
    );
  });
});

describe("markerPaintRank (#388: a venue diamond never covers the trip's pins)", () => {
  it("ranks a diamond under a stop pin and a chip above both", () => {
    const trip = canadaLive();
    const rogers = trip.locations![5]; // an excursion — never a re-base
    const base = trip.locations![2]; // a chapter base — a stop
    expect(placeRole(trip, rogers.name)).toBe("excursion");
    expect(placeRole(trip, base.name)).toBe("stop");
    const diamond = markerPaintRank(trip, { role: "place", place: rogers });
    const pin = markerPaintRank(trip, { role: "place", place: base });
    const chip = markerPaintRank(trip, { role: "activity", place: base });
    expect(diamond).toBeLessThan(pin);
    expect(pin).toBeLessThan(chip);
  });

  it("sorts every excursion under every stop, whatever order they arrive in", () => {
    // The reported tap: six Revelstoke venues stand within ~4 px of the ③ pin
    // and MapLibre stacks markers in DOM order, so whatever sorts last answers
    // a tap at that spot.
    const trip = canadaLive();
    const markers = [
      ...journeyOrder(trip).map((place) => ({ role: "place" as const, place })),
      ...tripExcursions(trip).map((place) => ({ role: "place" as const, place })),
    ];
    const painted = [...markers]
      .sort((a, b) => markerPaintRank(trip, a) - markerPaintRank(trip, b))
      .map((m) => (placeRole(trip, m.place.name) === "excursion" ? "diamond" : "pin"));
    expect(painted).toContain("diamond");
    expect(painted).toContain("pin");
    expect(painted.lastIndexOf("diamond")).toBeLessThan(painted.indexOf("pin"));
  });

  it("appends the diamonds before the stops on the scan level", () => {
    // Source-level pin: MapLibre stacks marker elements in the order they are
    // ADDED (this surface sets no z-index), so the order of these two loops IS
    // the stacking order — chain-first is the #388 report, a tap at
    // ③ Revelstoke opening The Village Idiot Bar & Grill.
    const scan = RouteMapSrc.slice(RouteMapSrc.indexOf("SCAN LEVEL"));
    const diamonds = scan.indexOf("journeyRef.current.excursions.forEach");
    const stops = scan.indexOf("journeyRef.current.chain.forEach");
    expect(diamonds).toBeGreaterThanOrEqual(0);
    expect(stops).toBeGreaterThanOrEqual(0);
    expect(diamonds).toBeLessThan(stops);
  });
});

describe("placeDays (#91: explicit days + clamped section refs)", () => {
  it("canada-2027 live labels", () => {
    const trip = canadaLive();
    expect(placeDays(trip, "YYC")).toEqual([0, 14]); // Days 1, 15
    expect(placeDays(trip, "Banff")).toEqual([0, 1, 2]); // Days 1–3
    expect(placeDays(trip, "Revelstoke")).toEqual([2, 3, 4, 5, 6, 7, 8, 9]); // Days 3–10
    expect(placeDays(trip, "Golden")).toEqual([9, 10, 11, 12]); // Days 10–13
    expect(placeDays(trip, "Lake Louise")).toEqual([12, 13, 14]); // Days 13–15
    expect(placeDays(trip, "Rogers Pass")).toEqual([4]); // Day 5 — the excursion
  });

  it("chile-peru-2027 live labels — co-located chapters split, not smear", () => {
    const trip = chile();
    expect(placeDays(trip, "Santiago")).toEqual([0, 1, 2, 3, 6, 7]); // Days 1–4, 7–8
    expect(placeDays(trip, "Valle Nevado")).toEqual([3, 4, 5, 6]); // Days 4–7
    expect(placeDays(trip, "Sacred Valley")).toEqual([7, 8, 9]); // Days 8–10
    expect(placeDays(trip, "Machu Picchu")).toEqual([9, 10]); // Days 10–11
    expect(placeDays(trip, "Cusco")).toEqual([7, 8, 11, 12, 13]); // Days 8–9, 12–14
    expect(placeDays(trip, "Lima")).toEqual([14, 15, 16]); // Days 15–17
  });

  it("via/route prose never attributes days — the Banff phantom is dead", () => {
    const trip = canadaLive();
    // Day 13 drives "via Banff", day 15 "via Banff, Canmore" — under the old
    // derivation Banff grew Days 1–3, 13, 15 and the chain sprouted a
    // Revelstoke → Banff → Lake Louise fiction.
    expect(placeDays(trip, "Banff")).not.toContain(12);
    expect(placeDays(trip, "Banff")).not.toContain(14);
    // Same for the pass on the day-3 drive.
    expect(placeDays(trip, "Rogers Pass")).not.toContain(2);
  });

  it("labels the calendar truth", () => {
    const trip = canadaLive();
    expect(dayRangeLabel(placeDays(trip, "YYC"))).toBe("Days 1, 15");
    expect(dayRangeLabel(placeDays(trip, "Revelstoke"))).toBe("Days 3–10");
    expect(dayRangeLabel(placeDays(trip, "Rogers Pass"))).toBe("Day 5");
    const cl = chile();
    expect(dayRangeLabel(placeDays(cl, "Santiago"))).toBe("Days 1–4, 7–8");
    expect(dayRangeLabel(placeDays(cl, "Valle Nevado"))).toBe("Days 4–7");
    expect(dayRangeLabel(placeDays(cl, "Cusco"))).toBe("Days 8–9, 12–14");
  });

  it("refuses a chapter day past the place's own span — the stay ends", () => {
    const t = canada();
    // Chapter stretched to day 6, but the drive-out on day 5 (idx 4) ends the
    // stay: [first, last] located is the place's calendar span.
    t.sections![1].days = [2, 5];
    t.days[5].blocks = [];
    expect(placeDays(t, "Revelstoke")).toEqual([2, 3, 4]);
  });

  it("a ref-day already owned by another place's content is not stolen", () => {
    const trip = chile();
    // Day 8 (idx 7) carries Cusco + Sacred Valley content; it is BOTH of
    // theirs, but not Santiago's even though the Andes chapter spans it —
    // wait, it is: the flight departs Santiago. The one that must NOT gain it
    // is Valle Nevado: the day falls outside its located span [3, 6].
    expect(placeDays(trip, "Valle Nevado")).not.toContain(7);
    expect(placeDays(trip, "Santiago")).toContain(7);
  });

  it("trusts the section ref when the place has no located days at all", () => {
    const t = canada();
    // Remove every block that names Revelstoke: the chapter ref is then the
    // only evidence, and there is nothing to contradict it.
    t.days[2].blocks = [];
    t.days[4].blocks = [{ id: "b4", kind: "transport", title: "Drive on to Golden", to: "Golden" }];
    expect(placeDays(t, "Revelstoke")).toEqual([2, 3]);
  });

  it("resolves by alias", () => {
    const trip = canada();
    expect(daysAtLocation(trip, "Hillcrest")).toEqual(daysAtLocation(trip, "Revelstoke"));
  });

  it("daysAtLocation is the kept alias of placeDays", () => {
    const trip = canadaLive();
    expect(daysAtLocation(trip, "Lake Louise")).toEqual(placeDays(trip, "Lake Louise"));
  });

  it("returns [] for an unknown place", () => {
    expect(placeDays(canada(), "Whistler")).toEqual([]);
  });
});

describe("returnsToStart", () => {
  it("is true when the first CHAIN stop is visited near both ends", () => {
    // YYC opens and closes the journey; Rogers Pass being an excursion does
    // not disturb the test — the chain, not the registry, is what repeats.
    expect(returnsToStart(canadaLive())).toBe(true);
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

  it("is false when the start is only an excursion-era memory", () => {
    // Chile starts in Santiago and flies home from Lima — no return.
    expect(returnsToStart(chile())).toBe(false);
  });
});

describe("tripJourney (#91: chain + excursions)", () => {
  it("chains the re-base stops and carries excursions beside the chain", () => {
    const j = tripJourney(canadaLive());
    // stops — the ① ② ③ index — stays registry order, excursions included.
    expect(j.stops.map((s) => s.name)).toEqual([
      "YYC",
      "Banff",
      "Revelstoke",
      "Golden",
      "Lake Louise",
      "Rogers Pass",
    ]);
    // The chain runs airport → Banff → Revelstoke → Golden → Lake Louise and
    // back; Rogers Pass is NOT spliced between Revelstoke and Golden.
    expect(j.chain.map((s) => s.name)).toEqual([
      "YYC",
      "Banff",
      "Revelstoke",
      "Golden",
      "Lake Louise",
    ]);
    expect(j.excursions.map((s) => s.name)).toEqual(["Rogers Pass"]);
    expect(j.loop).toBe(true);
    expect(j.legs.map((l) => `${l.from.name}→${l.to.name}`)).toEqual([
      "YYC→Banff",
      "Banff→Revelstoke",
      "Revelstoke→Golden",
      "Golden→Lake Louise",
      "Lake Louise→YYC",
    ]);
  });

  it("never draws a leg through an excursion — structurally", () => {
    const j = tripJourney(canadaLive());
    const excursionNames = new Set(j.excursions.map((s) => s.name));
    for (const leg of j.legs) {
      expect(excursionNames.has(leg.from.name)).toBe(false);
      expect(excursionNames.has(leg.to.name)).toBe(false);
    }
  });

  it("every leg of the booked flagship is booked", () => {
    const j = tripJourney(canadaLive());
    expect(j.legs.every((l) => l.stage === "booked")).toBe(true);
  });

  it("chains chile by visit order with the multi-place chapters as single stops", () => {
    const j = tripJourney(chile());
    expect(j.excursions).toEqual([]); // every place is a chapter base
    expect(j.chain.map((s) => s.name)).toEqual([
      "Santiago",
      "Valle Nevado",
      "Sacred Valley",
      "Cusco",
      "Machu Picchu",
      "Lima",
    ]);
    // Booked drive in; the overnight flight gateway-matches the valley hop
    // (#361 slice 4: Santiago≈Valle Nevado 46 km, Cusco≈Sacred Valley 33 km —
    // both inside the 50 km gateway rule), so the hop reads the trip stage
    // instead of provisional. Honest: the leg's long-haul travel IS that
    // flight, and a 2,500 km car route would be the lie. The Cusco arrival
    // drive speaks (trip stage = planned); the train hops and the to-only
    // Lima flight leave honest gaps.
    expect(j.legs.map((l) => [`${l.from.name}→${l.to.name}`, l.stage])).toEqual([
      ["Santiago→Valle Nevado", "booked"],
      ["Valle Nevado→Sacred Valley", "planned"],
      ["Sacred Valley→Cusco", "planned"],
      ["Cusco→Machu Picchu", "provisional"],
      ["Machu Picchu→Lima", "provisional"],
    ]);
    expect(j.loop).toBe(false);
  });

  it("keeps an excursion out of the chain however the itinerary mentions it", () => {
    const trip = canada();
    // A day-4 block touring the pass is more evidence it is visited — from a
    // base. It gains its day, never a chain slot.
    trip.days[3].blocks = [{ id: "b9", kind: "activity", title: "Tour Rogers Pass" }];
    expect(placeDays(trip, "Rogers Pass")).toEqual([3]);
    const j = tripJourney(trip);
    expect(j.chain.map((s) => s.name)).toEqual(["YYC", "Banff", "Revelstoke", "Golden"]);
    expect(j.excursions.map((s) => s.name)).toEqual(["Rogers Pass"]);
    expect(j.legs.map((l) => `${l.from.name}→${l.to.name}`)).toEqual([
      "YYC→Banff",
      "Banff→Revelstoke",
      "Revelstoke→Golden",
      "Golden→YYC",
    ]);
  });

  it("tripExcursions is the marker-order complement of journeyOrder", () => {
    const trip = canadaLive();
    const chain = journeyOrder(trip).map((l) => l.name);
    const excursions = tripExcursions(trip).map((l) => l.name);
    expect([...chain, ...excursions].sort()).toEqual(
      trip.locations!.map((l) => l.name).sort(),
    );
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

  it("produces no legs for a trip with a single place", () => {
    const trip = canada();
    trip.locations = [loc("Banff", 51.1784, -115.5708)];
    expect(tripJourney(trip).legs).toEqual([]);
  });
});

describe("daysAtLocation (legacy shapes, alias of placeDays)", () => {
  const trip = canada();

  it("unions block references, day titles and section locationRefs", () => {
    // Banff: the day-0 arrival drive, section 0's range (days 0-1), and the
    // day-2 departure drive that names it — leaving a place is a day at it.
    expect(daysAtLocation(trip, "Banff")).toEqual([0, 1, 2]);
    // Revelstoke: the day-2 drive plus section 1's range.
    expect(daysAtLocation(trip, "Revelstoke")).toEqual([2, 3, 4]);
  });

  it("picks up a place named only in prose", () => {
    // YYC never appears as a `location`, only in two flight titles and a drive.
    expect(daysAtLocation(trip, "YYC")).toEqual([0, 5]);
  });

  it("returns [] for an unknown place", () => {
    expect(daysAtLocation(trip, "Whistler")).toEqual([]);
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

describe("resolveLegCoordinates (#357 slice 3A: the §8.4 promise)", () => {
  const roadLeg = {
    road: true,
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [-115.5, 51.1],
        [-116.0, 51.0],
        [-118.1, 51.0],
      ] as [number, number][],
    },
  };
  const flightLeg = {
    road: false,
    mode: "flight",
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [-70.6, -33.4],
        [-72.0, -13.5],
      ] as [number, number][],
    },
  };

  it("passes a road leg's backend geometry through untouched", () => {
    expect(resolveLegCoordinates(roadLeg)).toBe(roadLeg.geometry.coordinates);
  });

  it("curves a road:false leg through greatCircle, never straight", () => {
    const coords = resolveLegCoordinates(flightLeg);
    expect(coords).toEqual(greatCircle([-70.6, -33.4], [-72.0, -13.5]));
    expect(coords.length).toBeGreaterThan(2);
  });

  it("the road flag is authoritative — a flight-looking road leg stays a road", () => {
    const farRoad = {
      road: true,
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [-70.6, -33.4],
          [-72.0, -13.5],
        ] as [number, number][],
      },
    };
    expect(resolveLegCoordinates(farRoad)).toBe(farRoad.geometry.coordinates);
  });

  it("passes degenerate geometry through rather than curving one point", () => {
    const single = {
      road: false,
      geometry: { type: "LineString" as const, coordinates: [[1, 2]] as [number, number][] },
    };
    expect(resolveLegCoordinates(single)).toBe(single.geometry.coordinates);
  });

  it("both surfaces draw through the shared helper (no second implementation)", () => {
    // Source-level pin: a straight backend line for road:false must not
    // reappear in either surface outside resolveLegCoordinates.
    expect(MapViewSrc).toContain("resolveLegCoordinates");
    expect(RouteMapSrc).toContain("resolveLegCoordinates");
    expect(RouteMapSrc.match(/resolveLegCoordinates/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("legModes comes only from data — Block.mode, never geometry", () => {
    // A flight-declared pair and an undeclared pair over IDENTICAL
    // coordinates classify differently: geometry never decides.
    const a = loc("Here", 1, 2);
    const b = loc("There", 3, 4);
    const flight: Trip = {
      days: [
        dayAt(0, "out", [
          { kind: "transport", mode: "flight", from: "Here", to: "There" } as Block,
        ]),
      ],
      locations: [a, b],
    } as unknown as Trip;
    const plain: Trip = {
      days: [],
      locations: [a, b],
    } as unknown as Trip;
    expect(legModes(flight, ["Here", "There"], false)).toEqual(["flight"]);
    expect(legModes(plain, ["Here", "There"], false)).toEqual([undefined]);
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

/**
 * Niko's report (2026-09-23): tapping an activity diamond on the itinerary map
 * — a venue, i.e. a place the trip does not re-base at — showed a registry
 * ordinal in the sheet and scrolled the rail nowhere ("showing 20 and should
 * scroll to Revelstoke"). `placeRailHandle` is the ONE answer the sheet's line
 * and the scroll both read, so they cannot disagree.
 */
describe("placeRailHandle (where a selected place lands in the itinerary)", () => {
  /** canada() + a Revelstoke restaurant: a registry place with coordinates, a
   *  meal block on day 3, and NO chapter ref — the live-post-venue-round shape. */
  function withVenue(): Trip {
    const base = canada();
    return {
      ...base,
      locations: [...(base.locations ?? []), loc("Rockford Bar & Grill", 50.9582, -118.1642)],
      days: base.days.map((d, i) =>
        i === 2
          ? {
              ...d,
              blocks: [
                ...d.blocks,
                {
                  id: "m1",
                  kind: "meal",
                  title: "Dinner — Rockford Bar & Grill",
                  location: "Rockford Bar & Grill",
                },
              ],
            }
          : d,
      ),
    } as Trip;
  }

  it("prefers the chapter pill for a place a section refs", () => {
    expect(placeRailHandle(canada(), "Banff")).toEqual({ kind: "pill", refs: ["Banff"] });
  });

  it("returns the ref as written, so an ALIAS-named pill still matches", () => {
    const trip = canada({
      sections: [{ id: "s1", title: "Revelstoke", days: [2, 3], locationRefs: ["Hillcrest"] }],
    });
    // A map tap selects the registry name; the pill's attribute is the alias.
    expect(placeRailHandle(trip, "Revelstoke")).toEqual({ kind: "pill", refs: ["Hillcrest"] });
  });

  it("falls back to the place's first day when no chapter refs it", () => {
    const trip = withVenue();
    // Rockford is on day 3 (index 2) and in no section's locationRefs — the
    // venue case that used to scroll nothing.
    expect(placeRailHandle(trip, "Rockford Bar & Grill")).toEqual({ kind: "day", dayIdx: 2 });
  });

  it("is null when the place has no handle in the list at all (ring only)", () => {
    // Rogers Pass is in the registry but no day and no chapter names it here.
    expect(placeRailHandle(canada(), "Rogers Pass")).toBeNull();
    expect(placeRailHandle(canada(), "Nowhere At All")).toBeNull();
  });

  it("is null when the day it happens on is not rendered as a card", () => {
    // With chapters, the list draws only the days a section covers — a day
    // outside every section has no card to scroll to, so the sheet must not
    // promise one.
    const trip = withVenue();
    const narrowed: Trip = {
      ...trip,
      sections: [{ id: "s0", title: "Arrival", days: [0, 1], locationRefs: ["Banff"] }],
    };
    expect(placeRailHandle(narrowed, "Rockford Bar & Grill")).toBeNull();
    // …and without chapters the flat list renders every day, so it is a handle.
    expect(placeRailHandle({ ...trip, sections: [] }, "Rockford Bar & Grill")).toEqual({
      kind: "day",
      dayIdx: 2,
    });
  });
});
