// @vitest-environment jsdom
/**
 * /today is a redirect, not a page: it lands on the current day page (the
 * same surface as any other day), or on the trip root when today has no day
 * to open.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Trip } from "../lib/types";
import { tripTodayIso } from "../lib/dates";
import { TripProvider } from "../components/theme";
import { TodayRedirect } from "./TodayRedirect";

let container: HTMLDivElement;
let root: Root;

function baseTrip(over: Record<string, unknown> = {}): Trip {
  const todayIso = tripTodayIso({ timezone: "UTC" });
  return {
    id: "live-trip",
    slug: "live-trip",
    title: "Live Trip",
    stage: "live",
    timezone: "UTC",
    startDate: todayIso,
    endDate: todayIso,
    visibility: "private",
    days: [{ id: "day-1", date: todayIso, title: "Today", blocks: [] }],
    sections: [],
    locations: [],
    crew: [],
    practical: {},
    ...over,
  } as unknown as Trip;
}

function mount(trip: Trip, initialEntry = "/t/live-trip/today") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/t/:tripId"
            element={
              <TripProvider trip={trip} apply={() => undefined}>
                <Outlet />
              </TripProvider>
            }
          >
            <Route index element={<div data-testid="home-stub" />} />
            <Route path="today" element={<TodayRedirect />} />
            <Route path="day/:idx" element={<div data-testid="day-stub" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
}

function text() {
  return container.textContent ?? "";
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("TodayRedirect", () => {
  it("lands on the current day page", () => {
    mount(baseTrip());
    expect(container.querySelector('[data-testid="day-stub"]')).not.toBeNull();
    expect(text()).not.toContain("Open as day page");
  });

  it("falls back to the trip root when today has no day to open", () => {
    mount(baseTrip({ days: [] }));
    expect(container.querySelector('[data-testid="home-stub"]')).not.toBeNull();
  });
});
