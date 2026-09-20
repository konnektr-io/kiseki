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

// The block tree reads the auth context for its editor branch (blocks.test.tsx
// pattern) — the weather wiring under test is auth-agnostic.
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({ isAuthenticated: false, isLoading: false }),
}));

// The itinerary row renders through `./blocks` (glyph + meta chips), whose
// card tree embeds `MapView` → maplibre-gl + maplibre-contour, which don't
// resolve under node-env vitest. Maps are irrelevant to the weather pill
// (blocks.test.tsx pattern).
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

import { DayWeatherPill, WeatherStrip } from "./Weather";
import { DaySummaryRow } from "./DaySummaryRow";
import { DayBlocks } from "./blocks";
import { TripProvider } from "./theme";
import { PlaceFacts } from "./PlaceFacts";
import type { Block, Day, Trip, TripLocation } from "../lib/types";

function render(el: ReactElement): string {
  return renderToString(el);
}

/** The trip-local "today" the pill is judged against — pinned so the
 *  forecast-window guard is deterministic in tests. */
const TODAY = "2027-02-15";

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
          element: createElement(DaySummaryRow, { day, idx: 0, dayNo: 1, locations, today: TODAY }),
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
  it("onlyDate pins the strip to a single day (day view)", () => {
    const html = render(
      createElement(WeatherStrip, { lat: 51.0785, lng: -115.7765, onlyDate: "2027-02-21" }),
    );
    expect(html).toContain("9°");
    expect(html).toContain("5%");
    expect(html).not.toContain("12 cm"); // the powder token of 02-20 stays out
    expect(html).toContain("Weather by");
  });
  it("onlyDate with no matching forecast renders nothing", () => {
    expect(
      render(createElement(WeatherStrip, { lat: 51.0785, lng: -115.7765, onlyDate: "2027-08-01" })),
    ).toBe("");
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
    const html = render(
      createElement(DayWeatherPill, { day: dayOn("2027-02-21"), locations, today: TODAY }),
    );
    expect(html).toContain("9°");
    expect(html).toContain("5%");
    expect(html).toContain("Open-Meteo");
  });
  it("shows the snow figure on a powder day", () => {
    const html = render(
      createElement(DayWeatherPill, { day: dayOn("2027-02-20"), locations, today: TODAY }),
    );
    expect(html).toContain("12 cm");
    expect(html).toContain("90%");
  });
  it("renders nothing when the day floats free of the registry", () => {
    const free = { ...dayOn("2027-02-21"), blocks: [{ kind: "note", title: "Rest" }] } as unknown as Day;
    expect(render(createElement(DayWeatherPill, { day: free, locations, today: TODAY }))).toBe("");
  });
});

describe("no forecast = no space (outside the 16-day window)", () => {
  it("the pill itself renders no markup at all", () => {
    expect(
      render(createElement(DayWeatherPill, { day: dayOn("2027-08-01"), locations, today: TODAY })),
    ).toBe("");
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
  it("only renders the strip when the CALLER says a forecast can cover the trip", () => {
    const place = { name: "Sunshine Village", lat: 51.0785, lng: -115.7765 };
    const shown = render(createElement(PlaceFacts, { place, showWeather: true }));
    expect(shown).toContain("Weather by");
    // Default (and a far-out trip) = no strip, no request, no space.
    expect(render(createElement(PlaceFacts, { place }))).not.toContain("Weather by");
    expect(render(createElement(PlaceFacts, { place, showWeather: false }))).not.toContain("Weather by");
  });
  it("a coords-only place with weather on renders ONLY the strip", () => {
    // The block call sites widen their guard for exactly this case: a mapped
    // resort with no place metadata yet still shows this week's conditions.
    const html = render(
      createElement(PlaceFacts, { place: { name: "Revelstoke", lat: 51, lng: -118 }, showWeather: true }),
    );
    expect(html).toContain("Weather by");
    expect(html).not.toContain("Open in Google Maps");
  });
  it("weather on but no coords renders nothing (never an empty box)", () => {
    expect(render(createElement(PlaceFacts, { place: { name: "Somewhere" }, showWeather: true }))).toBe("");
  });
  it("a placed trip far out gets no strip even with facts present", () => {
    const html = render(
      createElement(PlaceFacts, {
        place: { name: "Sunshine Village", lat: 51.0785, lng: -115.7765, placeId: "ChIJx" },
      }),
    );
    expect(html).toContain("Open in Google Maps");
    expect(html).not.toContain("Weather by");
  });
  it("with date set, the strip shows only that day's chip (day view)", () => {
    const place = { name: "Sunshine Village", lat: 51.0785, lng: -115.7765 };
    const html = render(createElement(PlaceFacts, { place, showWeather: true, date: "2027-02-21" }));
    expect(html).toContain("Weather by");
    expect(html).toContain("9°");
    expect(html).not.toContain("12 cm"); // the powder token of 02-20 stays out
  });
});

/* The real call site: a block card on a day view. This is the wiring that a
 * component-only test cannot prove — the guard lives in `blocks.tsx`, and a
 * missed `showWeather` there is invisible everywhere else (the "data shipped
 * without UI" class of defect). The trip's own dates decide. */
describe("block card wiring (the guard lives in blocks.tsx)", () => {
  const activity: Block = {
    id: "b1",
    kind: "activity",
    title: "Ski day",
    location: "Revelstoke",
    order: 0,
  } as unknown as Block;

  function renderCard(tripDates: { startDate?: string; endDate?: string }): string {
    const trip = {
      id: "t1",
      slug: "test",
      title: "Test trip",
      stage: "booked",
      myRole: "viewer",
      ...tripDates,
      locations: [{ name: "Revelstoke", lat: 51.0785, lng: -115.7765 }], // coords only, no facts
      days: [],
    } as unknown as Trip;
    return renderToString(
      createElement(TripProvider, {
        trip,
        apply: () => {},
        children: createElement(
          MemoryRouter,
          { initialEntries: ["/t/t1/day/0"] },
          createElement(DayBlocks, { blocks: [activity] } as never),
        ),
      }),
    );
  }

  /** The guard reads the REAL clock (no `now` injection at the call site), so
   *  the fixture dates are relative to today — a hardcoded "near" date would
   *  silently become far-out as the calendar moves. */
  function isoIn(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  it("an in-window trip shows the weather strip on a coords-only place", () => {
    const html = renderCard({ startDate: isoIn(5), endDate: isoIn(12) });
    expect(html).toContain("Weather by");
  });
  it("a trip happening right now shows it too (ongoing overlap)", () => {
    const html = renderCard({ startDate: isoIn(-5), endDate: isoIn(9) });
    expect(html).toContain("Weather by");
  });
  it("a far-out trip shows no weather at all — not even the PlaceFacts wrapper", () => {
    const html = renderCard({ startDate: isoIn(200), endDate: isoIn(214) });
    expect(html).not.toContain("Weather by");
    expect(html).not.toContain("Open in Google Maps"); // no facts, no strip → nothing
  });
  it("a day view shows only that day's chip, not the five-day strip", () => {
    const dayA = isoIn(5);
    const dayB = isoIn(6);
    hookState.current = [
      { date: dayA, wmo: 0, tmax_c: 9.1, tmin_c: -2.5, snowfall_cm: 0, precip_prob: 5, snow_depth_m: 0 },
      { date: dayB, wmo: 63, tmax_c: 15, tmin_c: 6, snowfall_cm: 0, precip_prob: 70, snow_depth_m: 0 },
    ];
    const trip = {
      id: "t1",
      slug: "test",
      title: "Test trip",
      stage: "booked",
      myRole: "viewer",
      startDate: isoIn(5),
      endDate: isoIn(12),
      locations: [{ name: "Revelstoke", lat: 51.0785, lng: -115.7765 }], // coords only, no facts
      days: [],
    } as unknown as Trip;
    const renderDay = (date?: string) =>
      renderToString(
        createElement(TripProvider, {
          trip,
          apply: () => {},
          children: createElement(
            MemoryRouter,
            { initialEntries: ["/t/t1/day/0"] },
            createElement(DayBlocks, { blocks: [activity], date } as never),
          ),
        }),
      );
    const single = renderDay(dayA);
    expect(single).toContain("Weather by");
    expect(single).toContain("5%");
    expect(single).not.toContain("70%");
    // Without the day pin (legacy call sites) the full strip still renders.
    const full = renderDay(undefined);
    expect(full).toContain("5%");
    expect(full).toContain("70%");
  });
});
