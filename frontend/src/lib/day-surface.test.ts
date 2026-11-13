/**
 * The two day-level helpers that stayed in the client after #457: the chip
 * letter and the card's title→place matcher. The day's own topology (markers,
 * legs, endpoints, tracks) is derived server-side and arrives as `day.surface`.
 */

import { describe, expect, it } from "vitest";
import { activityLetter, matchTitlePlace } from "./day-surface";
import type { Trip } from "./types";

const trip: Trip = {
  id: "t1",
  slug: "t1",
  title: "A trip",
  stage: "shortlist",
  visibility: "public",
  crew: [],
  practical: {},
  days: [],
  locations: [
    { name: "Sunshine Village", lat: 51.1, lng: -115.8, alias: ["Sunshine"] },
    { name: "Lake Louise", lat: 51.4, lng: -116.2, alias: ["Louise"] },
    { name: "Banff", lat: 51.17, lng: -115.57, alias: ["YH"] },
  ],
};

describe("activityLetter", () => {
  it("cycles A–Z then suffixes with the cycle number", () => {
    expect(activityLetter(1)).toBe("A");
    expect(activityLetter(2)).toBe("B");
    expect(activityLetter(26)).toBe("Z");
    expect(activityLetter(27)).toBe("A2");
    expect(activityLetter(53)).toBe("A3");
  });

  it("never returns an empty chip", () => {
    expect(activityLetter(0)).toBe("A");
    expect(activityLetter(-3)).toBe("A");
  });
});

describe("matchTitlePlace", () => {
  it("matches a place named by its own name", () => {
    expect(matchTitlePlace(trip, "Sunrise at Lake Louise")?.name).toBe("Lake Louise");
  });

  it("matches through an alias of 3+ characters (#104)", () => {
    expect(matchTitlePlace(trip, "Sunshine full day")?.name).toBe("Sunshine Village");
  });

  it("ignores an alias shorter than 3 characters", () => {
    expect(matchTitlePlace(trip, "YH transfer")).toBeUndefined();
  });

  it("prefers the longest name when several could match", () => {
    expect(matchTitlePlace(trip, "Lake Louise and Louise")?.name).toBe("Lake Louise");
  });

  it("invents nothing", () => {
    expect(matchTitlePlace(trip, "Dinner downtown")).toBeUndefined();
    expect(matchTitlePlace(trip, undefined)).toBeUndefined();
  });
});
