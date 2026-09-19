import { describe, expect, it } from "vitest";
import {
  dayCoords,
  dayWeather,
  shortDay,
  tripInForecastWindow,
  weatherForecastUrl,
  weatherKind,
  weatherLabel,
  weatherReadout,
  withinForecastWindow,
  type WeatherDay,
} from "./weather-live";
import type { Day, TripLocation } from "./types";

/* Pure helpers of the weather overlay (#334): date matching, the
 * day → registry coords resolution, condition mapping, and the readout
 * rules (conditions · temp · precip, plus snow only when there is snow to
 * report). */

function w(over: Partial<WeatherDay> & { date: string }): WeatherDay {
  return {
    wmo: 0,
    tmax_c: 12,
    tmin_c: 4,
    snowfall_cm: 0,
    precip_prob: 10,
    snow_depth_m: 0,
    ...over,
  };
}

const beach = w({ date: "2027-07-04", wmo: 0, tmax_c: 31, tmin_c: 22, precip_prob: 5 });
const powder = w({
  date: "2027-02-20",
  wmo: 71,
  tmax_c: 2,
  tmin_c: -6,
  snowfall_cm: 12.4,
  precip_prob: 90,
  snow_depth_m: 0.35,
});
const daily = [beach, powder];

describe("dayWeather", () => {
  it("matches the exact trip date", () => {
    expect(dayWeather(daily, "2027-02-20")?.snowfall_cm).toBe(12.4);
  });
  it("returns null outside the forecast window (the honest empty state)", () => {
    expect(dayWeather(daily, "2027-03-01")).toBeNull();
  });
  it("returns null without data", () => {
    expect(dayWeather(null, "2027-02-20")).toBeNull();
    expect(dayWeather([], "2027-02-20")).toBeNull();
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

describe("weatherKind / weatherLabel", () => {
  it("names snow codes as snow", () => {
    for (const code of [71, 73, 75, 77, 85, 86]) {
      expect(weatherKind(code)).toBe("snow");
      expect(weatherLabel(code)).toBe("Snow");
    }
  });
  it("compacts the rest", () => {
    expect(weatherKind(0)).toBe("clear");
    expect(weatherLabel(0)).toBe("Clear");
    expect(weatherKind(2)).toBe("cloud");
    expect(weatherKind(63)).toBe("rain");
    expect(weatherKind(95)).toBe("storm");
    expect(weatherKind(45)).toBe("fog");
    expect(weatherKind(null)).toBe("unknown");
    expect(weatherLabel(null)).toBe("");
    expect(weatherKind(999)).toBe("unknown");
    expect(weatherLabel(999)).toBe("");
  });
});

describe("weatherReadout — general by default, snow only when it means something", () => {
  it("a summer day reads conditions, temp and precip chance with no snow talk", () => {
    const r = weatherReadout(beach)!;
    expect(r.kind).toBe("clear");
    expect(r.temp).toBe("31° / 22°");
    expect(r.precip).toBe("5%");
    expect(r.snow).toBeNull();
    expect(r.base).toBeNull();
  });
  it("a powder day adds the snowfall figure", () => {
    const r = weatherReadout(powder)!;
    expect(r.snow).toBe("12 cm");
    expect(r.base).toBe("35 cm");
    expect(r.temp).toBe("2° / -6°");
    expect(r.precip).toBe("90%");
  });
  it("an existing snowpack is reported even with no fresh snow", () => {
    const r = weatherReadout(w({ date: "2027-03-02", wmo: 3, snowfall_cm: 0, snow_depth_m: 1.42 }))!;
    expect(r.snow).toBeNull();
    expect(r.base).toBe("142 cm");
  });
  it("a trace of snow (<0.5 cm) is not reported as snowfall", () => {
    const r = weatherReadout(w({ date: "2027-03-02", wmo: 3, snowfall_cm: 0.2 }))!;
    expect(r.snow).toBeNull();
  });
  it("a shallow snowpack (<10 cm) stays hidden", () => {
    const r = weatherReadout(w({ date: "2027-03-02", snow_depth_m: 0.04 }))!;
    expect(r.base).toBeNull();
  });
  it("half-day temps read as one number", () => {
    expect(weatherReadout(w({ date: "x", tmin_c: null }))!.temp).toBe("12°");
  });
  it("returns null with nothing to show and no forecast at all", () => {
    expect(weatherReadout(null)).toBeNull();
    expect(
      weatherReadout({ ...w({ date: "x" }), wmo: null, tmax_c: null, tmin_c: null, precip_prob: null }),
    ).toBeNull();
  });
});

describe("withinForecastWindow", () => {
  const today = "2027-02-15";
  it("accepts a date inside the 16-day horizon", () => {
    expect(withinForecastWindow("2027-02-20", today)).toBe(true);
    expect(withinForecastWindow("2027-03-01", today)).toBe(true); // day 14
    expect(withinForecastWindow(today, today)).toBe(true); // trip day today
  });
  it("rejects a date past the horizon (no request worth making)", () => {
    expect(withinForecastWindow("2027-03-03", today)).toBe(false); // day 16
    expect(withinForecastWindow("2027-08-01", today)).toBe(false);
  });
  it("tolerates one day of clock/timezone skew", () => {
    expect(withinForecastWindow("2027-02-14", today)).toBe(true);
    expect(withinForecastWindow("2027-02-13", today)).toBe(false);
  });
  it("fails closed on junk", () => {
    expect(withinForecastWindow("", today)).toBe(false);
    expect(withinForecastWindow(null, today)).toBe(false);
    expect(withinForecastWindow("2027-02-20", "")).toBe(false);
    expect(withinForecastWindow("not-a-date", today)).toBe(false);
  });
});

describe("tripInForecastWindow — the gate for the location strip", () => {
  const now = new Date("2027-02-15T09:00:00Z");
  const trip = (startDate?: string, endDate?: string, timezone?: string) => ({
    startDate,
    endDate,
    timezone,
  });
  it("true while the trip is inside the window", () => {
    expect(tripInForecastWindow(trip("2027-02-18", "2027-02-26"), now)).toBe(true);
    expect(tripInForecastWindow(trip("2027-02-15", "2027-02-15"), now)).toBe(true); // today
  });
  it("true for a long trip that has already started but is still on", () => {
    expect(tripInForecastWindow(trip("2027-01-20", "2027-03-05"), now)).toBe(true);
  });
  it("false months out — a far-out trip gets no weather readout at all", () => {
    expect(tripInForecastWindow(trip("2027-08-01", "2027-08-14"), now)).toBe(false);
  });
  it("false once the trip is well past", () => {
    expect(tripInForecastWindow(trip("2026-12-01", "2026-12-10"), now)).toBe(false);
  });
  it("fails closed without dates", () => {
    expect(tripInForecastWindow(trip(undefined, undefined), now)).toBe(false);
  });
  it("accepts a one-sided range", () => {
    expect(tripInForecastWindow(trip(undefined, "2027-02-20"), now)).toBe(true);
    expect(tripInForecastWindow(trip("2027-08-01", undefined), now)).toBe(false);
  });
  it("resolves 'today' in the trip's own timezone", () => {
    // 2027-02-15T22:30Z is already the 16th in Tokyo and still the 15th in UTC.
    // From Tokyo's 16th the 02 Mar start sits exactly on the 15-day horizon;
    // from UTC's 15th it is a day past it.
    const late = new Date("2027-02-15T22:30:00Z");
    expect(tripInForecastWindow(trip("2027-03-02", "2027-03-04", "Asia/Tokyo"), late, 15)).toBe(true);
    expect(tripInForecastWindow(trip("2027-03-02", "2027-03-04", "UTC"), late, 15)).toBe(false);
  });
});

describe("weatherForecastUrl / shortDay", () => {
  it("hits the backend proxy with the requested horizon", () => {
    expect(weatherForecastUrl(51.0785, -115.7765)).toBe(
      "/api/weather/forecast?lat=51.0785&lng=-115.7765&days=7",
    );
    expect(weatherForecastUrl(51.0785, -115.7765, 5)).toBe(
      "/api/weather/forecast?lat=51.0785&lng=-115.7765&days=5",
    );
  });
  it("formats a chip date as weekday + day number", () => {
    expect(shortDay("2027-02-20")).toBe("Sat 20");
  });
});
