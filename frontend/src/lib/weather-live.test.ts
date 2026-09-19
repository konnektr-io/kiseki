import { describe, expect, it } from "vitest";
import { dayCoords, daySnow, weatherForecastUrl, wmoLabel, type WeatherDay } from "./weather-live";
import type { Day, TripLocation } from "./types";

/* Pure helpers of the snow-weather overlay (#334): date matching, the
 * day → registry coords resolution, WMO labels, proxy URL shape. */

const daily: WeatherDay[] = [
  { date: "2027-02-20", wmo: 71, tmax_c: 2.0, tmin_c: -6.0, snowfall_cm: 12.4, precip_prob: 90, snow_depth_m: 0.35 },
  { date: "2027-02-21", wmo: 0, tmax_c: 9.1, tmin_c: -2.5, snowfall_cm: 0.0, precip_prob: 5, snow_depth_m: 0.3 },
];

describe("daySnow", () => {
  it("matches the exact trip date", () => {
    expect(daySnow(daily, "2027-02-20")?.snowfall_cm).toBe(12.4);
  });
  it("returns null outside the forecast window (the honest empty state)", () => {
    expect(daySnow(daily, "2027-03-01")).toBeNull();
  });
  it("returns null without data", () => {
    expect(daySnow(null, "2027-02-20")).toBeNull();
    expect(daySnow([], "2027-02-20")).toBeNull();
  });
});

const locations: TripLocation[] = [
  { name: "Sunshine Village", alias: ["Sunshine"], lat: 51.0785, lng: -115.7765 },
  { name: "Banff", lat: 51.1784, lng: -115.5708 },
  { name: "Nowhere", alias: ["Void"] },
];

function dayWith(blocks: Day["blocks"]): Day {
  return { id: "d1", date: "2027-02-20", title: "First turns", blocks } as Day;
}

describe("dayCoords", () => {
  it("resolves the first located block via name", () => {
    const day = dayWith([{ kind: "activity", title: "Ski", location: "Banff" }] as Day["blocks"]);
    expect(dayCoords(day, locations)).toEqual({ lat: 51.1784, lng: -115.5708 });
  });
  it("resolves via alias", () => {
    const day = dayWith([{ kind: "activity", title: "Ski", location: "sunshine" }] as Day["blocks"]);
    expect(dayCoords(day, locations)).toEqual({ lat: 51.0785, lng: -115.7765 });
  });
  it("skips unlocated blocks and returns null when nothing resolves", () => {
    const day = dayWith([
      { kind: "note", title: "Rest" },
      { kind: "activity", title: "Mystery", location: "Void" },
      { kind: "activity", title: "Unknown", location: "Atlantis" },
    ] as Day["blocks"]);
    expect(dayCoords(day, locations)).toBeNull();
  });
  it("returns null without a registry", () => {
    const day = dayWith([{ kind: "activity", title: "Ski", location: "Banff" }] as Day["blocks"]);
    expect(dayCoords(day, undefined)).toBeNull();
    expect(dayCoords(day, [])).toBeNull();
  });
});

describe("wmoLabel", () => {
  it("names snow codes first", () => {
    for (const code of [71, 73, 75, 77, 85, 86]) expect(wmoLabel(code)).toBe("Snow");
  });
  it("compacts the rest", () => {
    expect(wmoLabel(0)).toBe("Clear");
    expect(wmoLabel(2)).toBe("Cloud");
    expect(wmoLabel(63)).toBe("Rain");
    expect(wmoLabel(95)).toBe("Storm");
    expect(wmoLabel(45)).toBe("Fog");
    expect(wmoLabel(null)).toBe("");
    expect(wmoLabel(999)).toBe("");
  });
});

describe("weatherForecastUrl", () => {
  it("hits the backend proxy with clamped params", () => {
    expect(weatherForecastUrl(51.0785, -115.7765)).toBe(
      "/api/weather/forecast?lat=51.0785&lng=-115.7765&days=7",
    );
  });
});
