import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Snow-weather components (#334): the 5-day location strip and the
 * one-day itinerary pill. The fetch-on-mount hook is mocked (SSR never
 * runs effects, so the real hook can't light up in renderToString); the
 * mock feeds the exact payload shape app/weather.py serves. Pure helpers
 * (date match, coords resolution) are pinned in weather-live.test.ts. */

const daily = [
  { date: "2027-02-20", wmo: 71, tmax_c: 2.0, tmin_c: -6.0, snowfall_cm: 12.4, precip_prob: 90, snow_depth_m: 0.35 },
  { date: "2027-02-21", wmo: 0, tmax_c: 9.1, tmin_c: -2.5, snowfall_cm: 0.0, precip_prob: 5, snow_depth_m: 0.3 },
];

/** Mutable so each test pins its own hook payload. */
const hookState: { current: typeof daily | null } = { current: daily };

vi.mock("../lib/weather-live", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const orig = await importOriginal();
  return {
    ...orig,
    useWeatherDaily: () => hookState.current,
  };
});

vi.mock("../lib/place-live", () => ({
  placePhotoUrl: (ref: string) => `/api/places/photo?ref=${encodeURIComponent(ref)}`,
  usePlaceLive: () => null,
}));

import { DaySnowPill, SnowStrip } from "./WeatherSnow";
import { PlaceFacts } from "./PlaceFacts";
import type { Day, TripLocation } from "../lib/types";

function render(el: ReactElement): string {
  return renderToString(el);
}

beforeEach(() => {
  hookState.current = daily;
});

describe("SnowStrip", () => {
  it("renders one chip per forecast day plus the Open-Meteo credit", () => {
    const html = render(createElement(SnowStrip, { lat: 51.0785, lng: -115.7765 }));
    expect(html).toContain("12 cm");
    expect(html).toContain("0 cm");
    expect(html).toContain("Snow forecast by");
    expect(html).toContain("https://open-meteo.com/");
    expect(html).toContain("no-print");
  });
  it("renders nothing without coords", () => {
    expect(render(createElement(SnowStrip, { lat: undefined, lng: -115.7765 }))).toBe("");
  });
  it("renders nothing when the overlay is absent", () => {
    hookState.current = null;
    expect(render(createElement(SnowStrip, { lat: 51.0785, lng: -115.7765 }))).toBe("");
  });
});

const locations: TripLocation[] = [
  { name: "Sunshine Village", alias: ["Sunshine"], lat: 51.0785, lng: -115.7765 },
];

function powderDay(date: string): Day {
  return {
    id: "d1",
    date,
    title: "First turns",
    blocks: [{ kind: "activity", title: "Ski", location: "Sunshine" }],
  } as unknown as Day;
}

describe("DaySnowPill", () => {
  it("renders the powder pill for a date inside the window", () => {
    const html = render(createElement(DaySnowPill, { day: powderDay("2027-02-20"), locations }));
    expect(html).toContain("12 cm");
    expect(html).toContain("Open-Meteo");
  });
  it("renders nothing outside the forecast window (honest empty state)", () => {
    expect(render(createElement(DaySnowPill, { day: powderDay("2027-08-01"), locations }))).toBe("");
  });
  it("renders nothing when the day floats free of the registry", () => {
    const free = { ...powderDay("2027-02-20"), blocks: [{ kind: "note", title: "Rest" }] } as unknown as Day;
    expect(render(createElement(DaySnowPill, { day: free, locations }))).toBe("");
  });
});

describe("PlaceFacts weather integration", () => {
  it("a located place gains the snow strip; an unlocated one stays silent", () => {
    const located = render(
      createElement(PlaceFacts, {
        place: { name: "Sunshine Village", lat: 51.0785, lng: -115.7765 },
      }),
    );
    expect(located).toContain("Snow forecast by");
    const bare = render(createElement(PlaceFacts, { place: { name: "Somewhere" } }));
    expect(bare).not.toContain("Snow forecast by");
  });
});
