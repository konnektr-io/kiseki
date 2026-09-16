/**
 * The signed-in home's ordering and filtering (#249, slice 2).
 *
 * The one rule the home answers "why is this first?" with: bands are fixed
 * (Up next → Your trips → Following → Discover), and inside a trip list the
 * shared `sortShowcaseTrips` comparator decides. The feed keeps the server's
 * order verbatim.
 */
import { describe, expect, it } from "vitest";
import type { TripSummary } from "./types";
import { filterTrips, nextUpTrip, presentStages, upNextLabel } from "./home";

function trip(over: Partial<TripSummary> & { dtId: string; title: string }): TripSummary {
  return {
    visibility: "private",
    subtitle: "",
    stage: "planned",
    slug: over.dtId,
    ...over,
  } as TripSummary;
}

describe("nextUpTrip", () => {
  it("prefers the live trip over anything sooner", () => {
    const trips = [
      trip({ dtId: "a", title: "Soon", stage: "booked", startDate: "2027-03-01" }),
      trip({ dtId: "b", title: "Now", stage: "live", startDate: "2026-09-01" }),
    ];
    expect(nextUpTrip(trips)?.dtId).toBe("b");
  });

  it("picks the soonest start among the rest, skipping archives and dateless trips", () => {
    const trips = [
      trip({ dtId: "a", title: "Later", stage: "planned", startDate: "2027-09-01" }),
      trip({ dtId: "b", title: "Old", stage: "archive", startDate: "2023-08-01" }),
      trip({ dtId: "c", title: "Vague", stage: "idea" }),
      trip({ dtId: "d", title: "Soon", stage: "booked", startDate: "2027-03-01" }),
    ];
    expect(nextUpTrip(trips)?.dtId).toBe("d");
  });

  it("returns null when nothing is upcoming", () => {
    expect(nextUpTrip([])).toBeNull();
    expect(nextUpTrip([trip({ dtId: "a", title: "Old", stage: "archive" })])).toBeNull();
  });
});

describe("upNextLabel", () => {
  it("names the live trip as happening, and counts down to the rest", () => {
    const live = trip({ dtId: "a", title: "Now", stage: "live", startDate: "2026-09-01" });
    expect(upNextLabel(live, "2026-09-15")).toBe("Happening now");
    const soon = trip({ dtId: "b", title: "Soon", startDate: "2026-09-16" });
    expect(upNextLabel(soon, "2026-09-15")).toBe("Starts tomorrow");
    const later = trip({ dtId: "c", title: "Later", startDate: "2026-09-27" });
    expect(upNextLabel(later, "2026-09-15")).toBe("Starts in 12 days");
    const today = trip({ dtId: "d", title: "Today", startDate: "2026-09-15" });
    expect(upNextLabel(today, "2026-09-15")).toBe("Starts today");
  });
});

describe("filterTrips", () => {
  const trips = [
    trip({ dtId: "a", title: "Canada Heliski", subtitle: "Powder week", stage: "booked" }),
    trip({ dtId: "b", title: "Chile Peru", subtitle: "Andes to coast", stage: "planned" }),
    trip({ dtId: "c", title: "Japan Idea", subtitle: "Campervan?", stage: "idea" }),
  ];

  it("matches title and subtitle, case-insensitively, blank matches all", () => {
    expect(filterTrips(trips, { q: "", stages: [] })).toHaveLength(3);
    expect(filterTrips(trips, { q: "heli", stages: [] }).map((t) => t.dtId)).toEqual(["a"]);
    expect(filterTrips(trips, { q: "ANDES", stages: [] }).map((t) => t.dtId)).toEqual(["b"]);
    expect(filterTrips(trips, { q: "nowhere", stages: [] })).toHaveLength(0);
  });

  it("keeps only the selected stages, and preserves the caller's order", () => {
    const out = filterTrips(trips, { q: "", stages: ["idea", "booked"] });
    expect(out.map((t) => t.dtId)).toEqual(["a", "c"]);
  });

  it("combines text and stage", () => {
    const out = filterTrips(trips, { q: "a", stages: ["planned"] });
    expect(out.map((t) => t.dtId)).toEqual(["b"]);
  });
});

describe("presentStages", () => {
  it("lists the stages present, furthest-along first, without duplicates", () => {
    const trips = [
      trip({ dtId: "a", title: "A", stage: "idea" }),
      trip({ dtId: "b", title: "B", stage: "booked" }),
      trip({ dtId: "c", title: "C", stage: "idea" }),
      trip({ dtId: "d", title: "D", stage: "planned" }),
    ];
    expect(presentStages(trips)).toEqual(["booked", "planned", "idea"]);
  });
});
