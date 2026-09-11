/**
 * Crew snapshot builders (issue #198) — pure optimistic-update helpers next
 * to `withCrewMember`, same no-op/identity-preserving style.
 */
import { describe, expect, it } from "vitest";

import { withAddedCrew, withRemovedCrew } from "./editing";
import type { Person, Trip } from "./types";

const ANN: Person = { id: "p-ann", name: "Ann", role: "viewer", claimed: false };
const BOB: Person = { id: "p-bob", name: "Bob", role: "editor", claimed: true };

function tripWith(crew: Person[]): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test Trip",
    stage: "planned",
    visibility: "private",
    crew,
    practical: {},
    days: [],
    sections: [],
    locations: [],
  } as unknown as Trip;
}

describe("withAddedCrew", () => {
  it("appends the member", () => {
    const trip = tripWith([ANN]);
    const next = withAddedCrew(trip, BOB);
    expect(next).not.toBe(trip);
    expect(next.crew).toEqual([ANN, BOB]);
    // The original is untouched.
    expect(trip.crew).toEqual([ANN]);
  });

  it("returns the same reference when the id is already on the crew", () => {
    const trip = tripWith([ANN]);
    expect(withAddedCrew(trip, { ...ANN, note: "changed" })).toBe(trip);
  });
});

describe("withRemovedCrew", () => {
  it("drops the member by id", () => {
    const trip = tripWith([ANN, BOB]);
    const next = withRemovedCrew(trip, ANN.id);
    expect(next).not.toBe(trip);
    expect(next.crew).toEqual([BOB]);
    expect(trip.crew).toEqual([ANN, BOB]);
  });

  it("returns the same reference when the id is not on the crew", () => {
    const trip = tripWith([ANN]);
    expect(withRemovedCrew(trip, "p-unknown")).toBe(trip);
  });
});
