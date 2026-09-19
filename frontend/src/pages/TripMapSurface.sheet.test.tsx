import { createElement } from "react";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/* Day-level sheet nav: sticky at EVERY detent (not just `full`).
 *
 * The phone sheet's prev/up/next bar must sit on the sheet floor while the
 * day scrolls under it — day→day hopping without scrolling to the content's
 * end first. SSR pins the STRUCTURE (the sticky wrapper + the Fix-B
 * `min-h-full` column that gives the sticky range room on long days); the
 * browser harness proves the geometry (bar rect at the fold at `half`, both
 * short and overflowing days).
 *
 * Render the REAL TripMapSurface through SSR inside a MemoryRouter on a day
 * route with the surface ladder stubbed to `sheet` — the map chain and
 * SplitView don't resolve under node-env vitest, and the nav placement under
 * test touches none of their internals. `detent` starts at `half`, so this
 * fails on the old `sheet && detent === "full"` condition — that IS the
 * regression it guards.
 */
vi.mock("../components/RouteMap", () => ({ RouteMap: () => null }));
vi.mock("../components/MapView", () => ({ MapView: () => null, TripMap: () => null }));
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: false,
    getAccessTokenSilently: async () => "test-token",
  }),
}));
vi.mock("../components/SplitView", () => ({
  useSurfaceMode: () => "sheet",
  SplitView: ({ header, content }: { header: React.ReactNode; content: React.ReactNode }) =>
    createElement("div", null, header, content),
}));

import { TripMapSurface } from "./TripMapSurface";
import { TripProvider } from "../components/theme";
import type { Trip } from "../lib/types";

function sheetTrip(): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test trip",
    stage: "planned",
    visibility: "private",
    myRole: "viewer",
    crew: [],
    practical: {},
    locations: [
      {
        name: "Banff",
        lat: 51.18,
        lng: -115.57,
        placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
        address: "123 Mountain Ave, Banff AB",
        summary: "Home of the **powder**.",
      },
    ],
    sections: [{ id: "s0", title: "Mountains", days: [0, 2], locationRefs: [] }],
    days: [
      { id: "d0", date: "2027-03-01", title: "Arrival", blocks: [] },
      { id: "d1", date: "2027-03-02", title: "Ski day", blocks: [] },
      { id: "d2", date: "2027-03-03", title: "Departure", blocks: [] },
    ],
  } as unknown as Trip;
}

function renderDay(idx: number): string {
  const children = createElement(
    MemoryRouter,
    { initialEntries: [`/t/t1/day/${idx}`] },
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: "/t/:tripId/day/:idx",
        element: createElement(TripMapSurface),
      }),
    ),
  );
  return renderToString(
    createElement(TripProvider, { trip: sheetTrip(), apply: () => {}, children }),
  );
}

describe("day-level sheet nav (phone)", () => {
  it("pins the prev/up/next bar with a sticky wrapper at the initial `half` detent", () => {
    const html = renderDay(1);
    // The WRAPPER's exact class combo — the inner bar also carries
    // `sticky bottom-0` (with `z-10 -mx-4`), so only this string proves the
    // wrapper (the element whose stickiness was detent-gated) is sticky.
    expect(html).toContain("sticky bottom-0 mt-auto");
    // … and the bar itself is there with both day neighbours.
    expect(html).toContain("Previous day");
    expect(html).toContain("Next day");
  });

  it("grows the day column past one viewport so the sticky range holds long days", () => {
    const html = renderDay(1);
    // Fix-B root: `min-h-full` lets the column reach the fold on short days
    // AND grow with overflowing ones — a fixed `h-full` caps the sticky
    // wrapper's range and the bar rides up on long days.
    expect(html).toContain("flex min-h-full flex-col");
  });
});
