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
  fetchJoinLink: vi.fn(),
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

// Heavy peripheral chrome: not the subject of these tests.
vi.mock("../components/chat-panel", () => ({ ChatPopup: () => null }));

// Keep the REAL TripAccessError (TripLayout discriminates on it) and stub
// only the network functions.
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchTrip: mocks.fetchTrip,
    refetchTrip: mocks.refetchTrip,
    downloadBooklet: mocks.downloadBooklet,
    fetchJoinLink: mocks.fetchJoinLink,
  };
});

const { TripAccessError } = await import("../lib/api");
const { TripLayout } = await import("./TripLayout");

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

function mount() {
  uncaught = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, {
    onUncaughtError: (error) => uncaught.push(error),
  });
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/t/${TRIP.id}`]}>
        <Routes>
          <Route path="/t/:tripId" element={<TripLayout />} />
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
});
