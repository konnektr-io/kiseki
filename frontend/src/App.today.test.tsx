// @vitest-environment jsdom
/**
 * Live-trip route regressions: the trip root, /today and /overview must land
 * on the right surface, and today's own day must carry the top-level chrome.
 *
 * What shipped broken in v0.82.1: the Overview nav pointed at the trip root,
 * and the root redirects to today while live — so Overview bounced straight
 * back to the day. These mount the REAL App route tree (not individual
 * pages), which is the only shape that can catch router-wiring drift.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip } from "./lib/types";

const mocks = vi.hoisted(() => ({
  fetchTrip: vi.fn(),
  refetchTrip: vi.fn(),
  downloadBooklet: vi.fn(),
}));

/** Phone-vs-rail switch the surface reads; tests pin it per case. */
const surface = vi.hoisted(() => ({ mode: "rail" }));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: async () => undefined,
    logout: async () => undefined,
  }),
}));

vi.mock("./lib/auth", () => ({
  isAuthConfigured: () => true,
  isSessionExpiredError: () => false,
}));

vi.mock("./components/chat-panel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ChatPopup: () => React.createElement("div", { "data-testid": "chat-drawer" }),
  };
});

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    fetchTrip: mocks.fetchTrip,
    refetchTrip: mocks.refetchTrip,
    downloadBooklet: mocks.downloadBooklet,
  };
});

// MapLibre + CSS never load under jsdom — stub the map chain (same pattern
// as the SSR surface tests).
vi.mock("./components/RouteMap", () => ({ RouteMap: () => null }));
vi.mock("./components/MapView", () => ({ MapView: () => null, TripMap: () => null }));
vi.mock("./components/SplitView", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useSurfaceMode: () => surface.mode,
    SplitView: ({
      header,
      content,
      footer,
      detent,
    }: {
      header: React.ReactNode;
      content: React.ReactNode;
      footer?: React.ReactNode;
      detent?: string;
    }) =>
      React.createElement(
        "div",
        { "data-detent": detent ?? "" },
        header,
        content,
        footer,
      ),
  };
});

const { TripAccessError } = await import("./lib/api");
void TripAccessError;
const { default: App } = await import("./App");
const { tripTodayIso } = await import("./lib/dates");

const TRIP_ID = "b16680e7-a338-4c76-9cd7-fa13d45be594";

function liveTrip(over: Record<string, unknown> = {}): Trip {
  const todayIso = tripTodayIso({ timezone: "UTC" });
  // Day 2 sits one past today on purpose: it is a NON-today day page.
  const plusOne = tripTodayIso(
    { timezone: "UTC" },
    new Date(new Date(`${todayIso}T12:00:00Z`).getTime() + 86_400_000),
  );
  return {
    id: TRIP_ID,
    slug: "live-trip",
    title: "Live Trip",
    stage: "live",
    timezone: "UTC",
    startDate: todayIso,
    endDate: plusOne,
    visibility: "private",
    myRole: "viewer",
    summary: "Two days on the move.",
    coverStats: [],
    stats: [],
    features: [],
    // One located place keeps the surface out of its empty-trip fallback so
    // the day rail (not the scan list) renders under test.
    locations: [{ id: "loc-1", name: "Trailhead", lat: 51.18, lng: -115.57 }],
    sections: [],
    crew: [{ name: "Niko Raes", role: "owner" }],
    practical: {},
    days: [
      { id: "day-1", date: todayIso, title: "Today on the road", blocks: [] },
      { id: "day-2", date: plusOne, title: "Tomorrow", blocks: [] },
    ],
    ...over,
  } as unknown as Trip;
}

let container: HTMLDivElement;
let root: Root;

/** UTC ISO date N days from now (matches tripTodayIso for UTC trips). */
function isoDaysFromNow(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Live trip whose days SKIP today: in range, but no exact date match, so the
 * Today shortcut falls back to the nearest day ("Before"). That day must
 * still render as a regular day — never the today chrome.
 */
function sparseTrip(): Trip {
  return {
    id: TRIP_ID,
    slug: "sparse-trip",
    title: "Sparse Trip",
    stage: "live",
    timezone: "UTC",
    startDate: isoDaysFromNow(-2),
    endDate: isoDaysFromNow(2),
    visibility: "private",
    myRole: "viewer",
    coverStats: [],
    stats: [],
    features: [],
    locations: [{ id: "loc-1", name: "Trailhead", lat: 51.18, lng: -115.57 }],
    sections: [],
    crew: [],
    practical: {},
    days: [
      { id: "day-1", date: isoDaysFromNow(-1), title: "Before", blocks: [] },
      { id: "day-2", date: isoDaysFromNow(2), title: "After", blocks: [] },
    ],
  } as unknown as Trip;
}

function mount(initialEntry: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>,
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function text() {
  return container.textContent ?? "";
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  surface.mode = "rail";
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (typeof globalThis.matchMedia !== "function") {
    (globalThis as Record<string, unknown>).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  }
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("live-trip routes", () => {
  it("the trip root jumps to the today view (same day surface, top-level chrome)", async () => {
    mocks.fetchTrip.mockResolvedValue(liveTrip());
    mount(`/t/${TRIP_ID}`);
    await flush();

    // The current day on the day surface…
    expect(text()).toContain("Day 1");
    expect(text()).toContain("Today on the road");
    expect(text()).not.toContain("Two days on the move.");
    // …with the top-level bottom nav (Today highlighted), not the DayNav bar.
    const bottomNav = container.querySelector("nav.fixed");
    expect(bottomNav, "the top-level bottom nav").not.toBeNull();
    const todayLink = bottomNav!.querySelector(`a[href="/t/${TRIP_ID}/today"]`);
    expect(todayLink?.textContent).toContain("Today");
    expect(todayLink?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[aria-label^="Next day"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Previous day"]')).toBeNull();
  });

  it("/today renders the today view, /overview renders the overview", async () => {
    mocks.fetchTrip.mockResolvedValue(liveTrip());

    mount(`/t/${TRIP_ID}/today`);
    await flush();
    expect(text()).toContain("Today on the road");
    expect(text()).not.toContain("Two days on the move.");
    act(() => root?.unmount());
    container?.remove();

    mount(`/t/${TRIP_ID}/overview`);
    await flush();
    // The overview stays on the overview: summary + crew, no day surface.
    expect(text()).toContain("Two days on the move.");
    expect(container.querySelector('a[aria-label="Back to the itinerary"]')).toBeNull();
  });

  it("a day reached as /day/<idx> always keeps its DayNav bar — even today's date", async () => {
    mocks.fetchTrip.mockResolvedValue(liveTrip());

    // Day 0 carries today's exact date, but arrived as a day route (e.g. from
    // the itinerary) it is a regular day view: no bottom nav, DayNav bar.
    mount(`/t/${TRIP_ID}/day/0`);
    await flush();
    expect(text()).toContain("Today on the road");
    expect(container.querySelector("nav.fixed")).toBeNull();
    expect(container.querySelector('[aria-label^="Next day"]')).not.toBeNull();
    act(() => root?.unmount());
    container?.remove();

    mount(`/t/${TRIP_ID}/day/1`);
    await flush();
    expect(container.querySelector("nav.fixed")).toBeNull();
    expect(container.querySelector('[aria-label^="Previous day"]')).not.toBeNull();
  });

  it("the phone sheet opens all the way up on the today route, half on day routes", async () => {
    surface.mode = "sheet";
    mocks.fetchTrip.mockResolvedValue(liveTrip());

    mount(`/t/${TRIP_ID}/today`);
    await flush();
    expect(container.querySelector("div[data-detent]")?.getAttribute("data-detent")).toBe("full");
    act(() => root?.unmount());
    container?.remove();

    // Same date, day route: regular chrome, half sheet.
    mount(`/t/${TRIP_ID}/day/0`);
    await flush();
    expect(container.querySelector("div[data-detent]")?.getAttribute("data-detent")).toBe("half");
  });

  it("off-live the root is the overview and /today falls back to it", async () => {
    // Stage `idea` never auto-lives, even in range.
    mocks.fetchTrip.mockResolvedValue(liveTrip({ stage: "idea" }));

    mount(`/t/${TRIP_ID}`);
    await flush();
    expect(text()).toContain("Two days on the move.");
    act(() => root?.unmount());
    container?.remove();

    mount(`/t/${TRIP_ID}/today`);
    await flush();
    expect(text()).toContain("Two days on the move.");
    act(() => root?.unmount());
    container?.remove();

    mount(`/t/${TRIP_ID}/day/0`);
    await flush();
    // No top-level bottom nav: the day keeps its DayNav bar.
    expect(container.querySelector("nav.fixed")).toBeNull();
    expect(container.querySelector('[aria-label^="Next day"]')).not.toBeNull();
  });

  it("an unresolvable today route falls back to the overview", async () => {
    // Live and in range, but no days at all: nothing to resolve.
    mocks.fetchTrip.mockResolvedValue(liveTrip({ days: [] }));
    mount(`/t/${TRIP_ID}/today`);
    await flush();
    expect(text()).toContain("Two days on the move.");
  });

  it("the today route resolves a fallback day with today chrome; the day route stays regular", async () => {
    // Live and in range, but no day carries today's exact date: /today lands
    // on the nearest day ("Before")…
    const trip = sparseTrip();
    mocks.fetchTrip.mockResolvedValue(trip);

    mount(`/t/${TRIP_ID}/today`);
    await flush();
    expect(text()).toContain("Before");
    // …with the today chrome (bottom nav, no DayNav bar)…
    expect(container.querySelector("nav.fixed")).not.toBeNull();
    expect(container.querySelector('[aria-label^="Next day"]')).toBeNull();
    act(() => root?.unmount());
    container?.remove();

    // …while the same day as /day/0 is a regular day view.
    surface.mode = "sheet";
    mount(`/t/${TRIP_ID}/day/0`);
    await flush();
    expect(container.querySelector("nav.fixed")).toBeNull();
    expect(container.querySelector('[aria-label^="Next day"]')).not.toBeNull();
    expect(container.querySelector("div[data-detent]")?.getAttribute("data-detent")).toBe("half");
  });
});
