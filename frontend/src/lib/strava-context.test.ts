/**
 * The Strava rows a traveller attaches to a chat turn (#459).
 *
 * The rule under test is the whole reason this module exists: the browser holds
 * the only Strava credential (an HttpOnly cookie the relay never sees), so it
 * fetches the rows and hands over DATA. Nothing here carries a token, and the
 * attachment is scoped to the trip the rows came from — one trip's rides must
 * never reach another trip's turn.
 */

// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import {
  attachStravaContext,
  clearStravaContext,
  stravaContextForChat,
  stravaContextSnapshot,
  toStravaContextRows,
} from "./strava-context";
import type { StravaActivity } from "./api";

function rows(...dates: string[]) {
  return dates.map((local_date, index) => ({
    id: 1000 + index,
    local_date,
    name: `ride ${local_date}`,
    sport_type: "Snowboard",
    distance_m: 10_000,
    moving_time_s: 3600,
    elevation_gain_m: 500,
    start: { lat: 42.8, lng: 140.6 },
    has_track: false,
  }));
}

afterEach(() => {
  clearStravaContext();
});
describe("strava chat context", () => {
  it("hands the rows to the turn of the trip they came from", () => {
    attachStravaContext("trip-1", rows("2025-01-19", "2025-01-20"));
    expect(stravaContextForChat("trip-1")).toHaveLength(2);
    // a different trip has no window — its turn must not inherit these rides
    expect(stravaContextForChat("trip-2")).toBeNull();
    // …and an unanchored chat has no trip at all
    expect(stravaContextForChat(undefined)).toBeNull();
  });

  it("survives turn after turn until the traveller removes it", () => {
    attachStravaContext("trip-1", rows("2025-01-19"));
    // turn 2 reads the same attachment: the instructions are rebuilt per turn,
    // so nothing else remembers it
    expect(stravaContextForChat("trip-1")).toHaveLength(1);
    clearStravaContext("trip-1");
    expect(stravaContextForChat("trip-1")).toBeNull();
  });

  it("does not clear another trip's attachment", () => {
    attachStravaContext("trip-2", rows("2027-02-16"));
    clearStravaContext("trip-1"); // a stale panel for another trip
    expect(stravaContextForChat("trip-2")).toHaveLength(1);
  });

  it("attaching an empty list detaches instead of sending nothing useful", () => {
    attachStravaContext("trip-1", rows("2025-01-19"));
    attachStravaContext("trip-1", []);
    expect(stravaContextForChat("trip-1")).toBeNull();
    expect(stravaContextSnapshot()).toBeNull();
  });

  it("maps the API activity to the wire row, and only that", () => {
    const activity: StravaActivity = {
      id: 13393553403,
      name: "Slopes - A day snowboarding at Niseko United",
      sport_type: "Snowboard",
      local_date: "2025-01-19",
      distance_m: 48400,
      moving_time_s: 15240,
      elapsed_time_s: 29227,
      elevation_gain_m: 5289.4,
      start_latlng: [42.871481, 140.68134],
      photo_count: 0,
      suggested: { day_id: "day-1", block_id: "block-1" },
      imported: { day_id: "day-1", block_id: "block-1", has_track: true, has_photos: false },
    };
    const [row] = toStravaContextRows([activity]);
    expect(row).toEqual({
      id: 13393553403,
      local_date: "2025-01-19",
      name: "Slopes - A day snowboarding at Niseko United",
      sport_type: "Snowboard",
      distance_m: 48400,
      moving_time_s: 15240,
      elevation_gain_m: 5289.4,
      start: { lat: 42.871481, lng: 140.68134 },
      // the import state decides whether the agent may claim a track is there
      has_track: true,
    });
    // elapsed time and the day/block suggestion are the dialog's business
    expect(row).not.toHaveProperty("elapsed_time_s");
    expect(row).not.toHaveProperty("suggested");
    expect(row).not.toHaveProperty("imported");
  });

  it("drops a position it cannot trust rather than sending half a point", () => {
    const [row] = toStravaContextRows([
      {
        id: 1,
        name: "indoor",
        sport_type: "WeightTraining",
        local_date: "2025-01-20",
        distance_m: 0,
        moving_time_s: 1800,
        elapsed_time_s: 1800,
        elevation_gain_m: 0,
        start_latlng: null,
        photo_count: 0,
        suggested: null,
        imported: null,
      },
    ]);
    expect(row.start).toBeNull();
    expect(row.has_track).toBe(false);
  });
});
