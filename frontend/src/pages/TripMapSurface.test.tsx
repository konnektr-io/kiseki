import { createElement } from "react";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/* The scan-level place-selection model: selecting a place NEVER swaps the
 * rail content — the itinerary list stays mounted, the pin gets its ring on
 * the map, the pill highlights in the rail, and the rail scrolls the pill
 * into view with a flash (`scrollToPlacePill`). Place facts live on the
 * day-view blocks (`PlaceFacts`), not here.
 *
 * Render the REAL TripMapSurface through SSR inside a MemoryRouter on the
 * itinerary route with a minimal TripProvider — no DOM, no map needed. The
 * module pulls the map chain (RouteMap → maplibre-gl, blocks → MapView) plus
 * the window-reading SplitView, which don't resolve/run under node-env
 * vitest, so all three are stubbed — the selection model under test touches
 * none of their internals (the SplitView stub renders header+content
 * straight through, which is exactly the "list stays mounted" contract).
 *
 * Pitfall 16 (editor-mode blind spot): the surface tree is auth-agnostic (no
 * role branching), pinned here by rendering the scan level as editor and as
 * viewer with the same expectations on the shared content. */
vi.mock("../components/RouteMap", () => ({ RouteMap: () => null }));
vi.mock("../components/MapView", () => ({ MapView: () => null, TripMap: () => null }));
// ItineraryList owns the editor "schedule to day" select via useTripWrite,
// which reads the Auth0 session — stub the hook so no provider is needed
// (writes never fire in a server render).
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: false,
    getAccessTokenSilently: async () => "test-token",
  }),
}));
vi.mock("../components/SplitView", () => ({
  useSurfaceMode: () => "rail",
  SplitView: ({ header, content }: { header: React.ReactNode; content: React.ReactNode }) =>
    createElement("div", null, header, content),
}));

import { scrollToPlacePill, togglePlaceSelection, TripMapSurface } from "./TripMapSurface";
import { TripProvider } from "../components/theme";
import type { Trip, TripLocation } from "../lib/types";

function tripWith(myRole = "viewer"): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test trip",
    stage: "planned",
    visibility: "private",
    myRole,
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
    sections: [
      { id: "s0", title: "Mountains", days: [0, 0], locationRefs: ["Banff"] },
    ],
    days: [{ id: "d0", date: "2027-03-01", title: "Arrival", blocks: [] }],
  } as unknown as Trip;
}

function renderSurface(trip: Trip): string {
  const children = createElement(
    MemoryRouter,
    { initialEntries: ["/t/t1/itinerary"] },
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: "/t/:tripId/itinerary",
        element: createElement(TripMapSurface),
      }),
    ),
  );
  return renderToString(
    createElement(TripProvider, { trip, apply: () => {}, children }),
  );
}

describe("scan-level place selection (no panel swap)", () => {
  it.each(["editor", "viewer"] as const)(
    "keeps the itinerary list mounted with the place pill (as %s)",
    (myRole) => {
      const html = renderSurface(tripWith(myRole));
      // The rail content IS the itinerary list — no PlacePanel swap.
      expect(html).toContain("data-itinerary-list");
      expect(html).toContain('data-place-pill="Banff"');
      // … and none of the panel chrome replaced it.
      expect(html).not.toContain("Back to the route");
      // Place facts live on day-view blocks now — the scan rail carries no
      // Maps deep link for the (unselected) place.
      expect(html).not.toContain("Open in Google Maps");
      expect(html).not.toContain("query_place_id=");
    },
  );

  it("toggles the selection: same pin tap clears, another pin moves it", () => {
    const banff = { name: "Banff" } as TripLocation;
    const lake = { name: "Lake Louise" } as TripLocation;
    expect(togglePlaceSelection(null, banff)).toBe(banff);
    expect(togglePlaceSelection(banff, banff)).toBeNull();
    expect(togglePlaceSelection(banff, lake)).toBe(lake);
  });
});

function fakePill(name: string, withScroll = true) {
  const calls: unknown[] = [];
  const classes = new Set<string>();
  const el = {
    getAttribute: (k: string) => (k === "data-place-pill" ? name : null),
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
    },
    ...(withScroll
      ? { scrollIntoView: (...args: unknown[]) => void calls.push(args) }
      : {}),
  };
  return { el, calls, classes };
}

function fakeRoot(names: string[], withScroll = true) {
  const pills = names.map((n) => fakePill(n, withScroll));
  return {
    pills,
    root: {
      querySelectorAll: (_sel: string) => pills.map((p) => p.el),
    },
  };
}

describe("scrollToPlacePill", () => {
  it("scrolls the matching pill into view and flashes it", () => {
    vi.useFakeTimers();
    try {
      const { pills, root } = fakeRoot(["Banff", "Lake Louise"]);
      expect(scrollToPlacePill(root as never, "Lake Louise")).toBe(true);
      // Only the matching pill scrolled …
      expect(pills[0].calls).toHaveLength(0);
      expect(pills[1].calls).toHaveLength(1);
      expect(pills[1].calls[0]).toEqual([{ block: "nearest", behavior: "smooth" }]);
      // … and flashed, then unflashed after ~1.2s.
      expect(pills[1].classes.has("place-pill-flash")).toBe(true);
      vi.advanceTimersByTime(1300);
      expect(pills[1].classes.has("place-pill-flash")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rings only (false, no throw) when no pill matches the place", () => {
    const { pills, root } = fakeRoot(["Banff"]);
    expect(scrollToPlacePill(root as never, "Nowhere")).toBe(false);
    expect(pills[0].calls).toHaveLength(0);
    expect(scrollToPlacePill(null, "Banff")).toBe(false);
  });

  it("still resolves without scrollIntoView (guard for non-DOM envs)", () => {
    const { pills, root } = fakeRoot(["Banff"], false);
    expect(scrollToPlacePill(root as never, "Banff")).toBe(true);
    expect(pills[0].classes.has("place-pill-flash")).toBe(true);
  });

  it("skips the flash under prefers-reduced-motion (state change only)", () => {
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      matchMedia: () => ({ matches: true }),
    };
    try {
      const { pills, root } = fakeRoot(["Banff"]);
      expect(scrollToPlacePill(root as never, "Banff")).toBe(true);
      // The scroll itself still lands (instant) — only the flash is skipped.
      expect(pills[0].calls[0]).toEqual([{ block: "nearest", behavior: "auto" }]);
      expect(pills[0].classes.has("place-pill-flash")).toBe(false);
    } finally {
      if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = prevWindow;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
