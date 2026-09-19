import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Weather overlay components (#334): the 5-day location strip, the one-day
 * itinerary pill, and the "no forecast = no space" contract. The
 * fetch-on-mount hook is mocked (SSR never runs effects, so the real hook
 * can't light up in renderToString); the mock feeds the exact payload shape
 * app/weather.py serves. The pure rules (date match, coords resolution,
 * readout tokens) are pinned in weather-live.test.ts. */

const daily = [
  { date: "2027-02-20", wmo: 71, tmax_c: 2, tmin_c: -6, snowfall_cm: 12.4, precip_prob: 90, snow_depth_m: 0.35 },
  { date: "2027-02-21", wmo: 0, tmax_c: 9.1, tmin_c: -2.5, snowfall_cm: 0, precip_prob: 5, snow_depth_m: 0.3 },
  { date: "2027-02-22", wmo: 63, tmax_c: 15, tmin_c: 6, snowfall_cm: 0, precip_prob: 70, snow_depth_m: 0 },
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

// The itinerary row renders through `./blocks` (glyph + meta chips), whose
// card tree embeds `MapView` → maplibre-gl + maplibre-contour, which don't
// resolve under node-env vitest. Maps are irrelevant to the weather pill
// (blocks.test.tsx pattern).
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

import { DayWeatherPill, WeatherStrip } from "./Weather";
import { DaySummaryRow } from "./DaySummaryRow";
import { PlaceFacts } from "./PlaceFacts";
import type { Day, TripLocation } from "../lib/types";

function render(el: ReactElement): string {
  return renderToString(el);
}

/** Render the real itinerary row on a trip route (it reads `useParams`). */
function renderRow(day: Day, locations?: TripLocation[]): string {
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: ["/t/t1/itinerary"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/t/:tripId/itinerary",
          element: createElement(DaySummaryRow, { day, idx: 0, dayNo: 1, locations }),
        }),
      ),
    ),
  );
}

beforeEach(() => {
  hookState.current = daily;
});

describe("WeatherStrip", () => {
  it("carries conditions, temp and precip chance per day, and the credit", () => {
    const html = render(createElement(WeatherStrip, { lat: 51.0785, lng: -115.7765 }));
    expect(html).toContain("Sat 20");
    expect(html).toContain("2°"); // the day high
    expect(html).toContain("90%"); // precip chance
    expect(html).toContain("12 cm"); // the powder token
    expect(html).toContain("Weather by");
    expect(html).toContain("https://open-meteo.com/");
    expect(html).toContain("no-print");
  });
  it("a snow-free day still gets its own chip (temp + precip, no snow talk)", () => {
    hookState.current = [daily[2]];
    const html = render(createElement(WeatherStrip, { lat: 51.0785, lng: -115.7765 }));
    expect(html).toContain("15°");
    expect(html).toContain("70%");
    expect(html).not.toContain("cm");
  });
  it("renders nothing without coords", () => {
    expect(render(createElement(WeatherStrip, { lat: undefined, lng: -115.7765 }))).toBe("");
  });
  it("renders nothing when the overlay is absent", () => {
    hookState.current = null;
    expect(render(createElement(WeatherStrip, { lat: 51.0785, lng: -115.7765 }))).toBe("");
  });
});

const locations: TripLocation[] = [
  { name: "Sunshine Village", alias: ["Sunshine"], lat: 51.0785, lng: -115.7765 },
];

function dayOn(date: string): Day {
  return {
    id: "d1",
    date,
    title: "First turns",
    blocks: [{ kind: "activity", title: "Ski", location: "Sunshine" }],
  } as unknown as Day;
}

describe("DayWeatherPill", () => {
  it("renders the day's conditions, temp and precip for a date inside the window", () => {
    const html = render(createElement(DayWeatherPill, { day: dayOn("2027-02-21"), locations }));
    expect(html).toContain("9°");
    expect(html).toContain("5%");
    expect(html).toContain("Open-Meteo");
  });
  it("shows the snow figure on a powder day", () => {
    const html = render(createElement(DayWeatherPill, { day: dayOn("2027-02-20"), locations }));
    expect(html).toContain("12 cm");
    expect(html).toContain("90%");
  });
  it("renders nothing when the day floats free of the registry", () => {
    const free = { ...dayOn("2027-02-21"), blocks: [{ kind: "note", title: "Rest" }] } as unknown as Day;
    expect(render(createElement(DayWeatherPill, { day: free, locations }))).toBe("");
  });
});

describe("no forecast = no space (outside the 16-day window)", () => {
  it("the pill itself renders no markup at all", () => {
    expect(render(createElement(DayWeatherPill, { day: dayOn("2027-08-01"), locations }))).toBe("");
  });
  it("the itinerary row is BYTE-IDENTICAL to the row without weather", () => {
    // Trip dates months out (every real kiseki trip today) must leave the
    // row exactly as it was: no placeholder, no reserved box, no wrapper.
    const far = dayOn("2027-08-01");
    const withWeatherAbsent = renderRow(far, locations);
    const baseline = renderRow(far, undefined);
    // The pill contributes nothing in either case...
    expect(withWeatherAbsent).not.toContain("Open-Meteo");
    expect(baseline).not.toContain("Open-Meteo");
    // ...and the only difference between "coords known, no forecast" and
    // "no registry at all" is nothing at all.
    expect(withWeatherAbsent).toBe(baseline);
  });
  it("an in-window row DOES gain the pill (the control for the test above)", () => {
    const html = renderRow(dayOn("2027-02-21"), locations);
    expect(html).toContain("Open-Meteo");
  });
});

describe("PlaceFacts weather integration", () => {
  it("a located place gains the weather strip; an unlocated one stays silent", () => {
    const located = render(
      createElement(PlaceFacts, {
        place: { name: "Sunshine Village", lat: 51.0785, lng: -115.7765 },
      }),
    );
    expect(located).toContain("Weather by");
    const bare = render(createElement(PlaceFacts, { place: { name: "Somewhere" } }));
    expect(bare).not.toContain("Weather by");
  });
});
