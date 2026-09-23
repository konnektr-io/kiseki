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

import { scrollToPlaceDayCard, scrollToPlacePill, scrollWithinScroller, selectionNote, togglePlaceSelection, TripMapSurface } from "./TripMapSurface";
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

describe("scrollWithinScroller", () => {
  /** A fake DOM tree: scroller[data-scroll-root] → list → el, with enough
   *  geometry for the helper to compute a scroll target. jsdom getBoundingClientRect
   *  returns all-zero rects by default, so every rect is a plain object. */
  function fakeTree(opts: {
    scrollTop?: number;
    scrollerH?: number;
    elTop?: number; // element top relative to scroller's viewport top
    elH?: number;
    noScrollRoot?: boolean;
  }) {
    const calls: { scrollTo?: unknown[]; scrollIntoView?: unknown[] } = {};
    const scrollTop = opts.scrollTop ?? 0;
    const scrollerH = opts.scrollerH ?? 500;
    const elH = opts.elH ?? 80;
    const sRect = { top: 100, height: scrollerH };
    // Element top in VIEWPORT coords: scroller viewport top + rel position.
    const eRect = { top: sRect.top + (opts.elTop ?? 0), height: elH };
    const el = {
      closest: (_sel: string) => (opts.noScrollRoot ? null : scroller),
      getBoundingClientRect: () => eRect,
      scrollIntoView: (...a: unknown[]) => void (calls.scrollIntoView ??= []).push(a),
    } as unknown as HTMLElement;
    const scroller = {
      scrollTop,
      getBoundingClientRect: () => sRect,
      scrollTo: (...a: unknown[]) => void (calls.scrollTo ??= []).push(a),
    } as unknown as HTMLElement;
    return { el, scroller, calls };
  }

  it("centers the element via the scroller only — never scrollIntoView", () => {
    // relTop = 700-100+0 = 600; center = 600 - (500-80)/2 = 390.
    const { el, calls } = fakeTree({ elTop: 600 });
    scrollWithinScroller(el, "center", "smooth");
    expect(calls.scrollTo).toHaveLength(1);
    expect(calls.scrollTo![0]).toEqual([{ top: 390, behavior: "smooth" }]);
    expect(calls.scrollIntoView).toBeUndefined();
  });

  it("center with auto behavior writes scrollTop directly on the scroller", () => {
    // relTop = 20; center target = 20 - 210 = -190 (browsers clamp negatives —
    // the point here is the WRITE goes to the scroller, nothing else moves).
    const { el, scroller, calls } = fakeTree({ elTop: 20 });
    scrollWithinScroller(el, "center", "auto");
    expect(scroller.scrollTop).toBe(-190);
    expect(calls.scrollTo).toBeUndefined();
    expect(calls.scrollIntoView).toBeUndefined();
  });

  it("nearest: no-ops when the element is already fully visible", () => {
    // relTop = 100-100+50 = 50; visible box [58, 542] → 50 < 58 → actually
    // above the pad, so use a clearly-inside position instead.
    const { el, scroller, calls } = fakeTree({ elTop: 200, scrollTop: 50, scrollerH: 500, elH: 80 });
    scrollWithinScroller(el, "nearest", "auto");
    // relTop = 150; box [58, 542]; 150+80=230 < 542 → no scroll.
    expect(scroller.scrollTop).toBe(50);
    expect(calls.scrollTo).toBeUndefined();
    expect(calls.scrollIntoView).toBeUndefined();
  });

  it("nearest: scrolls up to the top pad when the element is above the viewport", () => {
    // elTop = -30 → eRect.top = 70 → relTop = 70-100+120 = 90, above the
    // visible box [120, 620] → target = 90-8 = 82.
    const { el, scroller, calls } = fakeTree({ elTop: -30, scrollTop: 120 });
    scrollWithinScroller(el, "nearest", "auto");
    expect(scroller.scrollTop).toBe(82);
    expect(calls.scrollTo).toBeUndefined();
    expect(calls.scrollIntoView).toBeUndefined();
  });

  it("falls back to scrollIntoView when no [data-scroll-root] ancestor exists", () => {
    const { el, calls } = fakeTree({ noScrollRoot: true });
    scrollWithinScroller(el, "center", "auto");
    expect(calls.scrollIntoView).toHaveLength(1);
    expect(calls.scrollIntoView![0]).toEqual([{ block: "center", behavior: "auto" }]);
  });

  it("keeps the pill tests' contract: scrollToPlacePill still scrolls its pill", () => {
    // The pill path now routes through scrollWithinScroller → with no
    // [data-scroll-root] in the fake, it lands on the same scrollIntoView
    // fallback with identical args as before the refactor.
    vi.useFakeTimers();
    try {
      const { pills, root } = fakeRoot(["Lake Louise"]);
      expect(scrollToPlacePill(root as never, "Lake Louise")).toBe(true);
      expect(pills[0].calls[0]).toEqual([{ block: "nearest", behavior: "smooth" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a pill whose ref is an ALIAS of the selected place", () => {
    // A chapter can ref the place by alias (`locationRefs: ["Hillcrest"]`), so
    // the pill's attribute is the alias while a map tap selects the registry
    // name — `refs` from placeRailHandle bridges the two.
    vi.useFakeTimers();
    try {
      const unrelated = fakeRoot(["Golden"]);
      expect(scrollToPlacePill(unrelated.root as never, "Revelstoke", ["Hillcrest"])).toBe(false);
      const aliased = fakeRoot(["Hillcrest"]);
      expect(scrollToPlacePill(aliased.root as never, "Revelstoke", ["Hillcrest"])).toBe(true);
      expect(aliased.pills[0].calls[0]).toEqual([{ block: "nearest", behavior: "smooth" }]);
      expect(unrelated.pills[0].calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scrollToPlaceDayCard (the venue handle: no pill, scroll the day)", () => {
  /** The rail as the helper sees it: a root whose querySelector returns the
   *  day card for one index only. The card has no `closest`, so
   *  scrollWithinScroller takes its scrollIntoView fallback — the same shape
   *  the pill tests use. */
  function fakeRail(knows: number) {
    const calls: unknown[] = [];
    const classes = new Set<string>();
    const card = {
      getAttribute: () => String(knows),
      classList: {
        add: (c: string) => void classes.add(c),
        remove: (c: string) => void classes.delete(c),
      },
      scrollIntoView: (...args: unknown[]) => void calls.push(args),
    };
    const root = {
      querySelector: (sel: string) => {
        const m = /\[data-day-idx="(\d+)"\]/.exec(sel);
        return m && Number(m[1]) === knows ? card : null;
      },
      querySelectorAll: () => [],
    };
    return { card, root, calls, classes };
  }

  it("scrolls the place's day card into view and flashes it", () => {
    vi.useFakeTimers();
    try {
      const { root, calls, classes } = fakeRail(2);
      expect(scrollToPlaceDayCard(root as never, 2)).toBe(true);
      expect(calls[0]).toEqual([{ block: "center", behavior: "smooth" }]);
      expect(classes.has("day-card-flash")).toBe(true);
      vi.advanceTimersByTime(1300);
      expect(classes.has("day-card-flash")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false (no throw) when that day card is not in the rail", () => {
    const { root, calls } = fakeRail(2);
    expect(scrollToPlaceDayCard(root as never, 7)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(scrollToPlaceDayCard(null, 0)).toBe(false);
  });

  it("finds a FOLDED day by the card's per-day link (the fold's data-day-idx is the first day)", () => {
    const calls: unknown[] = [];
    const classes = new Set<string>();
    const link = {};
    const foldCard = {
      classList: {
        add: (c: string) => void classes.add(c),
        remove: (c: string) => void classes.delete(c),
      },
      querySelector: (sel: string) => (sel === 'a[href$="/day/7"]' ? link : null),
      scrollIntoView: (...args: unknown[]) => void calls.push(args),
    };
    const root = {
      querySelector: () => null, // no card carries data-day-idx="7" — it is folded
      querySelectorAll: (sel: string) => (sel === "[data-day-idx]" ? [foldCard] : []),
    };
    vi.useFakeTimers();
    try {
      expect(scrollToPlaceDayCard(root as never, 7)).toBe(true);
      expect(calls[0]).toEqual([{ block: "center", behavior: "smooth" }]);
      expect(classes.has("day-card-flash")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the flash under prefers-reduced-motion (the scroll still lands)", () => {
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = { matchMedia: () => ({ matches: true }) };
    try {
      const { root, calls, classes } = fakeRail(2);
      expect(scrollToPlaceDayCard(root as never, 2)).toBe(true);
      expect(calls[0]).toEqual([{ block: "center", behavior: "auto" }]);
      expect(classes.has("day-card-flash")).toBe(false);
    } finally {
      if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = prevWindow;
    }
  });
});

describe("selectionNote (the sheet must describe what actually happened)", () => {
  it("names the pill when the place has one", () => {
    expect(selectionNote({ kind: "pill", refs: ["Revelstoke"] })).toBe(
      "On the map — its pill is highlighted below",
    );
  });

  it("names the day for a place with no pill — never a promise the rail breaks", () => {
    // Niko's report: tapping an activity diamond (a restaurant in the
    // Revelstoke cluster) kept the pill wording while scrolling nothing.
    expect(selectionNote({ kind: "day", dayIdx: 2 })).toBe(
      "On the map — Day 3 is highlighted below",
    );
    expect(selectionNote({ kind: "day", dayIdx: 2 })).not.toContain("pill");
  });

  it("promises nothing when the place has no handle at all (ring only)", () => {
    expect(selectionNote(null)).toBe("On the map");
  });
});
