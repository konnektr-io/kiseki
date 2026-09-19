// @vitest-environment jsdom
/**
 * Trip route render regressions.
 *
 * These mount the REAL TripLayout into a DOM and drive it through the
 * transitions the component guards on: loading -> loaded and loading ->
 * error. That second render is where React #310 ("Rendered more hooks than
 * during the previous render") took the whole app down in v0.25.8: a hook
 * (`useCallback`) sat *below* the loading/error guards, so the first render
 * returned early with N hooks and the render that had a trip called N+1.
 * The app-wide boundary in main.tsx then replaced every screen with
 * "Something went wrong. Please refresh the page and try again."
 *
 * Two rules follow, and this file enforces both:
 *   1. every hook in a component stays ABOVE its early returns;
 *   2. this route is tested by MOUNTING, not with renderToString — SSR only
 *      ever renders once, so it is structurally blind to hook-order drift.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Trip } from "../lib/types";

const mocks = vi.hoisted(() => ({
  fetchTrip: vi.fn(),
  refetchTrip: vi.fn(),
  downloadBooklet: vi.fn(),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    getAccessTokenSilently: async () => "test-token",
    loginWithRedirect: async () => undefined,
    logout: async () => undefined,
  }),
}));

vi.mock("../lib/auth", () => ({
  isAuthConfigured: () => true,
  isSessionExpiredError: () => false,
}));

// Heavy peripheral chrome: not the subject of these tests — except the drawer
// ITSELF, which the route-derived chat scope has to open with the right
// invisible focus. The probe renders nothing until the layout actually opens
// it, so every existing assertion (none of which open chat) is unaffected.
vi.mock("../components/chat-panel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ChatPopup: (props: { focus?: { entity: string; id: string } | null }) =>
      React.createElement("div", {
        "data-testid": "chat-drawer",
        "data-focus": props.focus ? `${props.focus.entity}:${props.focus.id}` : "",
      }),
  };
});

// Keep the REAL TripAccessError (TripLayout discriminates on it) and stub
// only the network functions.
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchTrip: mocks.fetchTrip,
    refetchTrip: mocks.refetchTrip,
    downloadBooklet: mocks.downloadBooklet,
  };
});

const { TripAccessError } = await import("../lib/api");
const { TripLayout } = await import("./TripLayout");
const { SettingsPage } = await import("./SettingsPage");

const TRIP = {
  id: "b16680e7-a338-4c76-9cd7-fa13d45be594",
  slug: "urban-legends-neon-dreams",
  title: "Urban Legends & Neon Dreams",
  subtitle: "Folklore, backstreets and late-night light",
  stage: "idea",
  startDate: "2027-09-20",
  endDate: "2027-09-30",
  timezone: "Asia/Tokyo",
  visibility: "private",
  myRole: "owner",
  coverStats: [],
  stats: [],
  features: [],
  locations: [{ id: "loc-1", name: "Shinjuku" }],
  sections: [{ id: "sec-1", title: "Before you go", order: 1, body: "Bring coins." }],
  crew: [],
  practical: {},
  days: [
    {
      id: "day-1",
      date: "2027-09-20",
      title: "Arrival",
      blocks: [
        { id: "blk-1", kind: "note", text: "Land at Narita, take the Skyliner." },
      ],
    },
  ],
} as unknown as Trip;

let container: HTMLDivElement;
let root: Root;
let uncaught: unknown[];

function mount(initialEntry = `/t/${TRIP.id}`) {
  uncaught = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, {
    onUncaughtError: (error: unknown) => uncaught.push(error),
  });
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/t/:tripId" element={<TripLayout />}>
            {/* App.tsx registers this child route the same way (#248). */}
            <Route path="settings" element={<SettingsPage />} />
            {/* Day pages render inside the same layout shell (map surface). */}
            <Route path="day/:dayIdx" element={<div data-testid="day-stub" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** Flush pending microtasks + effects inside act(). */
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
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("TripLayout", () => {
  it("renders the trip after the document arrives (no hook-order crash)", async () => {
    let deliver!: (trip: Trip) => void;
    mocks.fetchTrip.mockImplementation(
      () => new Promise<Trip>((resolve) => { deliver = resolve; }),
    );

    mount();
    // First render: no trip yet, so the component takes its early return.
    expect(text()).toContain("Loading trip…");

    // Let the load effect fire so the deferred fetch is actually pending.
    await flush();
    expect(mocks.fetchTrip).toHaveBeenCalled();
    expect(text()).toContain("Loading trip…");

    await act(async () => { deliver(TRIP); await Promise.resolve(); });
    await flush();

    // Second render carries a trip: this is the render that used to throw
    // React #310 and blank the app.
    expect(uncaught).toEqual([]);
    expect(text()).not.toContain("Something went wrong");
    expect(text()).toContain("Urban Legends & Neon Dreams");
    expect(text()).toContain("Itinerary");
    expect(text()).toContain("Overview");
  });

  it("renders the not-found branch after a failed load (no hook-order crash)", async () => {
    mocks.fetchTrip.mockRejectedValue(new TripAccessError(404, "no such trip"));

    mount();
    expect(text()).toContain("Loading trip…");

    await flush();

    expect(uncaught).toEqual([]);
    expect(text()).not.toContain("Something went wrong");
    expect(text()).toContain("This trip doesn't exist or is no longer shared.");
  });

  it("renders the no-access branch for a forbidden load", async () => {
    mocks.fetchTrip.mockRejectedValue(new TripAccessError(403, "forbidden"));

    mount();
    await flush();

    expect(uncaught).toEqual([]);
    expect(text()).not.toContain("Something went wrong");
    expect(text()).toContain("You don't have access to this trip.");
  });

  it("the header menu keeps the booklet + a way into settings, and nothing else (#248)", async () => {
    mocks.fetchTrip.mockResolvedValue(TRIP); // owner
    mount();
    await flush();

    const trigger = container.querySelector('button[aria-label="Trip actions"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(text()).toContain("Download booklet PDF");
    const link = container.querySelector(`a[href="/t/${TRIP.id}/settings"]`);
    expect(link, "the settings entry point").not.toBeNull();
    // The trip-level rows are on the page now — the header keeps one row and
    // a two-item menu.
    expect(text()).not.toContain("Delete trip");
    expect(container.querySelectorAll('[role="menu"] select')).toHaveLength(0);
  });

  it("a viewer gets no settings entry point (#248)", async () => {
    mocks.fetchTrip.mockResolvedValue({ ...TRIP, myRole: "viewer" });
    mount();
    await flush();

    const trigger = container.querySelector('button[aria-label="Trip actions"]');
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toContain("Download booklet PDF");
    expect(container.querySelector(`a[href="/t/${TRIP.id}/settings"]`)).toBeNull();
  });

  it("the /settings child route renders the page inside the layout shell", async () => {
    mocks.fetchTrip.mockResolvedValue(TRIP); // owner
    mount(`/t/${TRIP.id}/settings`);
    await flush();

    expect(uncaught).toEqual([]);
    expect(text()).not.toContain("Something went wrong");
    // The layout's own chrome stays (shared header + nav)…
    expect(text()).toContain("Itinerary");
    // …and the settings groups render inside its Outlet.
    expect(text()).toContain("Trip identity");
    expect(text()).toContain("Danger zone");
  });

  it("on a day route the header back control goes up one level to the itinerary", async () => {
    mocks.fetchTrip.mockResolvedValue(TRIP); // owner
    mount(`/t/${TRIP.id}/day/0`);
    await flush();

    expect(uncaught).toEqual([]);
    const back = container.querySelector('a[aria-label="Back to the itinerary"]');
    expect(back, "the day-level way up").not.toBeNull();
    expect(back!.getAttribute("href")).toBe(`/t/${TRIP.id}/itinerary`);
    expect(
      container.querySelector('a[aria-label="Back to all trips"]'),
      "no landing shortcut on a day page",
    ).toBeNull();
  });

  it("off a day route the header back control still goes home", async () => {
    mocks.fetchTrip.mockResolvedValue(TRIP); // owner
    mount(`/t/${TRIP.id}`);
    await flush();

    expect(uncaught).toEqual([]);
    const back = container.querySelector('a[aria-label="Back to all trips"]');
    expect(back, "the trip-level way home").not.toBeNull();
    expect(back!.getAttribute("href")).toBe("/");
  });

  it("the header chat drawer carries the route's day as its invisible focus", async () => {
    mocks.fetchTrip.mockResolvedValue(TRIP); // owner
    mount(`/t/${TRIP.id}/day/0`);
    await flush();
    // Drawer closed: the probe is absent.
    expect(container.querySelector('[data-testid="chat-drawer"]')).toBeNull();

    // Open the drawer from the header chat toggle (no per-surface button).
    const toggle = container.querySelector('button[aria-label="Open chat"]');
    expect(toggle, "the header chat toggle").not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const drawer = container.querySelector('[data-testid="chat-drawer"]');
    expect(drawer, "the drawer opened").not.toBeNull();
    expect(drawer!.getAttribute("data-focus")).toBe("day:day-1");
    expect(uncaught).toEqual([]);
  });

  it("the header chat drawer off a day route is the whole-trip chat (no focus)", async () => {
    mocks.fetchTrip.mockResolvedValue(TRIP); // owner
    mount(`/t/${TRIP.id}`);
    await flush();

    const toggle = container.querySelector('button[aria-label="Open chat"]');
    expect(toggle, "the header chat toggle").not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const drawer = container.querySelector('[data-testid="chat-drawer"]');
    expect(drawer, "the drawer opened").not.toBeNull();
    expect(drawer!.getAttribute("data-focus")).toBe("");
    expect(uncaught).toEqual([]);
  });
});
