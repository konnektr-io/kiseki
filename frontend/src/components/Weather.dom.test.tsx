// @vitest-environment jsdom
/**
 * Weather overlay, mounted with the REAL hooks (#334).
 *
 * The SSR suites (Weather.test.tsx, weather-live.test.ts) pin the pure
 * rules; this one runs the actual fetch-on-mount path in a DOM, which is
 * what answers the only question that matters for a trip planned months
 * out: **a day outside the forecast window adds NOTHING to the row** — no
 * element, no box, no reserved space. jsdom has no layout engine, so the
 * contract is asserted structurally: the pill is absent from the DOM
 * (a null React child is not a node), and the row's markup is identical to
 * the same row without a single weather request in flight.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaySummaryRow } from "./DaySummaryRow";
import { clearWeatherCache } from "../lib/weather-live";
import type { Day, TripLocation } from "../lib/types";

// The row's glyph/meta come from `./blocks`, whose card tree embeds
// `MapView` → maplibre-gl + maplibre-contour (no node-env resolution).
// Maps are irrelevant to the weather pill (blocks.test.tsx pattern).
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

/** Forecast covering 2027-02-20/21 only — every other date is out of window. */
const FORECAST = {
  available: true,
  lat: 51.0785,
  lng: -115.7765,
  timezone: "America/Edmonton",
  current: { temp_c: 4, snowfall_cm: 0, wmo: 0 },
  attribution: { source: "Open-Meteo", url: "https://open-meteo.com/" },
  daily: [
    { date: "2027-02-20", wmo: 71, tmax_c: 2, tmin_c: -6, snowfall_cm: 12.4, precip_prob: 90, snow_depth_m: 0.35 },
    { date: "2027-02-21", wmo: 0, tmax_c: 9, tmin_c: -2, snowfall_cm: 0, precip_prob: 5, snow_depth_m: 0.3 },
  ],
};

const sent: string[] = [];

function stubForecast(): void {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      sent.push(url);
      return { ok: true, status: 200, json: async () => FORECAST } as unknown as Response;
    }),
  );
}

const locations: TripLocation[] = [
  { name: "Revelstoke", lat: 51.0785, lng: -115.7765 },
];

function dayOn(date: string): Day {
  return {
    id: "d1",
    date,
    title: "First turns",
    blocks: [{ kind: "activity", title: "Ski", location: "Revelstoke" }],
  } as unknown as Day;
}

let container: HTMLDivElement;
let root: Root;

async function mountRow(day: Day, locs: TripLocation[] | undefined = locations): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/t/t1/itinerary"]}>
        <Routes>
          <Route
            path="/t/:tripId/itinerary"
            element={<DaySummaryRow day={day} idx={0} dayNo={1} locations={locs} />}
          />
        </Routes>
      </MemoryRouter>,
    );
  });
  // Flush the fetch promise + the state update it triggers.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  clearWeatherCache();
  stubForecast();
  // jsdom ships no matchMedia; the hook reads it to skip fetching for print.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

/** The weather pill, identified by its credit text (its only stable hook —
 *  the same contract the SSR suite asserts on). */
function weatherNodes(): Element[] {
  return [...container.querySelectorAll("*")].filter((el) =>
    (el.textContent ?? "").includes("Open-Meteo"),
  );
}

describe("weather pill in a real mount", () => {
  it("shows conditions/temp/precip for a day inside the window", async () => {
    await mountRow(dayOn("2027-02-21"));
    const nodes = weatherNodes();
    expect(nodes.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("9°");
    expect(container.textContent).toContain("5%");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("/api/weather/forecast");
  });

  it("adds NOTHING to the row for a day outside the 16-day window", async () => {
    // Months out: the request happens (the coords are in the registry) and
    // the forecast simply has no entry — the row must be indistinguishable
    // from a row with no weather at all.
    await mountRow(dayOn("2027-08-01"));
    const withCoordsNoForecast = container.innerHTML;
    expect(sent.length).toBe(1); // the fetch is issued…
    expect(weatherNodes()).toEqual([]); // …and renders nothing at all
    // No weather wrapper, no reserved box: the pill's class never appears.
    expect(container.querySelectorAll(".no-print").length).toBe(0);
    // Byte-for-byte identical DOM to the same row with no registry coords at
    // all (no weather path in play) — the strongest form of "takes no space".
    act(() => root.unmount());
    container.remove();
    await mountRow(dayOn("2027-08-01"), undefined);
    expect(container.innerHTML).toBe(withCoordsNoForecast);
  });

  it("shares one request across rows pointing at the same place", async () => {
    await mountRow(dayOn("2027-02-21"));
    const first = sent.length;
    act(() => root.unmount());
    container.remove();
    await mountRow(dayOn("2027-02-20"));
    expect(sent.length).toBe(first); // served from the session request cache
  });
});
