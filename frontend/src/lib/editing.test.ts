/**
 * Crew snapshot builders (issue #198) — pure optimistic-update helpers next
 * to `withCrewMember`, same no-op/identity-preserving style.
 */
import { describe, expect, it } from "vitest";

import {
  withAddedCrew,
  withDayFields,
  withPracticalBlock,
  withRemovedCrew,
  withSectionTitle,
  withTripFields,
} from "./editing";
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

/* #296 ubiquitous title/notes — pure optimistic snapshot builders. */

function titledTrip(): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Old title",
    subtitle: "Old subtitle",
    stage: "planned",
    visibility: "private",
    crew: [],
    practical: { blocks: [{ title: "Money", body: "Cash only" }] },
    days: [{ id: "d1", date: "2027-07-01", title: "Old day", notes: "Old notes", blocks: [] }],
    sections: [{ id: "s1", title: "Old chapter", days: [0, 0] }],
    locations: [],
  } as unknown as Trip;
}

describe("withTripFields", () => {
  it("patches only the sent field", () => {
    const trip = titledTrip();
    const next = withTripFields(trip, { title: "New title" });
    expect(next.title).toBe("New title");
    expect(next.subtitle).toBe("Old subtitle");
    expect(trip.title).toBe("Old title");
  });

  it("returns the same reference on a no-op", () => {
    const trip = titledTrip();
    expect(withTripFields(trip, { title: "Old title" })).toBe(trip);
    expect(withTripFields(trip, {})).toBe(trip);
  });
});

describe("withDayFields", () => {
  it("patches one day's title/notes, leaving the other days alone", () => {
    const trip = titledTrip();
    const next = withDayFields(trip, "d1", { notes: "New notes" });
    expect(next.days[0].notes).toBe("New notes");
    expect(next.days[0].title).toBe("Old day");
    expect(trip.days[0].notes).toBe("Old notes");
  });

  it("returns the same reference for an unknown day or a no-op", () => {
    const trip = titledTrip();
    expect(withDayFields(trip, "d-unknown", { title: "X" })).toBe(trip);
    expect(withDayFields(trip, "d1", { title: "Old day" })).toBe(trip);
  });
});

describe("withSectionTitle", () => {
  it("renames one section", () => {
    const trip = titledTrip();
    const next = withSectionTitle(trip, "s1", "New chapter");
    expect(next.sections?.[0].title).toBe("New chapter");
    expect(trip.sections?.[0].title).toBe("Old chapter");
  });

  it("returns the same reference for an unknown section or a no-op", () => {
    const trip = titledTrip();
    expect(withSectionTitle(trip, "s-unknown", "X")).toBe(trip);
    expect(withSectionTitle(trip, "s1", "Old chapter")).toBe(trip);
  });
});

describe("withPracticalBlock", () => {
  it("patches one block by list position", () => {
    const trip = titledTrip();
    const next = withPracticalBlock(trip, 0, { body: "Cards everywhere" });
    expect(next.practical.blocks?.[0]).toEqual({ title: "Money", body: "Cards everywhere" });
    expect(trip.practical.blocks?.[0]).toEqual({ title: "Money", body: "Cash only" });
  });

  it("returns the same reference for an out-of-range index or a no-op", () => {
    const trip = titledTrip();
    expect(withPracticalBlock(trip, 7, { title: "X" })).toBe(trip);
    expect(withPracticalBlock(trip, 0, { title: "Money" })).toBe(trip);
  });
});
