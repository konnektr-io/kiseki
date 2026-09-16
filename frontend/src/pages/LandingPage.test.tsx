// @vitest-environment jsdom
/**
 * The signed-in discovery home (#249, slice 2).
 *
 * The REAL LandingPage mounted into a DOM (the bands load in an effect, so
 * renderToString can't reach them), with `fetch` stubbed per URL and the Auth0
 * context controlled through a hoisted mock.
 *
 * Gates under test:
 * - the four bands render in the documented order (Up next → Your trips →
 *   Following → Discover), and Up next does not duplicate into the grid;
 * - an empty band collapses to one line of copy, never an empty frame;
 * - search + stage chips filter the trip bands;
 * - Discover never shows your own trips;
 * - a trips failure errors the page, but a feed/showcase failure only
 *   collapses its band — a home with your trips is still a home.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedEntry, ShowcaseTrip, TripGeo, TripSummary } from "../lib/types";

const authState = vi.hoisted(() => {
  // Stable identities for the SDK callbacks: the load effect depends on
  // `getAccessTokenSilently`, and a fresh identity per render would re-fire it
  // forever (the FeedPage.test.tsx file documents the same trap). The mock
  // below returns these same objects on every call.
  const getAccessTokenSilently = async () => "test-token";
  const loginWithRedirect = async () => undefined;
  const logout = async () => undefined;
  return { isAuthenticated: true, isLoading: false, getAccessTokenSilently, loginWithRedirect, logout };
});

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: authState.isLoading,
    user: undefined,
    getAccessTokenSilently: authState.getAccessTokenSilently,
    loginWithRedirect: authState.loginWithRedirect,
    logout: authState.logout,
  }),
}));

// The ratio ladder reads matchMedia, which jsdom does not have (see
// TripMapSurface.test.tsx for the same trap) — the stub renders the rail/sheet
// furniture (header + bands) and the map, without the ladder.
vi.mock("../components/SplitView", () => ({
  SplitView: ({
    header,
    content,
    map,
  }: {
    header: React.ReactNode;
    content: React.ReactNode;
    map: (padding: { top: number; right: number; bottom: number; left: number }) => React.ReactNode;
  }) => (
    <main>
      <div data-testid="sheet-header">{header}</div>
      {content}
      {map({ top: 0, right: 0, bottom: 0, left: 0 })}
    </main>
  ),
}));

const net = vi.hoisted(() => ({
  trips: "ok" as "ok" | "fail",
  feed: "ok" as "ok" | "fail" | "empty",
  showcase: "ok" as "ok" | "fail" | "empty" | "mine-only",
  geo: "empty" as "ok" | "empty" | "fail",
  fetched: [] as string[],
}));

const TRIPS: TripSummary[] = [
  {
    dtId: "live-1", visibility: "private", title: "Ski Week", subtitle: "",
    stage: "live", startDate: "2026-09-01", endDate: "2026-09-20", slug: "ski",
    role: "owner",
  },
  {
    dtId: "booked-1", visibility: "public", title: "Canada Heliski", subtitle: "Powder",
    stage: "booked", startDate: "2027-02-01", endDate: "2027-02-17", slug: "canada",
    role: "owner",
  },
  {
    dtId: "idea-1", visibility: "private", title: "Japan Campervan", subtitle: "",
    stage: "idea", slug: "japan", role: "owner",
  },
];

const FEED: FeedEntry[] = [
  {
    kind: "item", tripId: "ext-1", tripTitle: "Dolomites", source: "followed-user",
    at: "2026-09-14T10:00:00Z", href: "/t/ext-1/day/0",
    dayIndex: 0, dayTitle: "Day 1", blockTitle: "Rifugio lunch", label: "1 photo added",
    thumbs: [],
  },
  {
    kind: "trip", tripId: "live-1", tripTitle: "Ski Week", source: "my-trip",
    at: "2026-09-14T09:00:00Z", href: "/t/live-1", changes: ["title"],
  },
];

const SHOWCASE: ShowcaseTrip[] = [
  { dtId: "ext-1", title: "Dolomites", subtitle: "", stage: "planned", cover: null },
  { dtId: "booked-1", title: "Canada Heliski", subtitle: "Powder", stage: "booked", cover: null },
];

const GEO: TripGeo[] = [
  {
    dtId: "live-1", title: "Ski Week", stage: "live",
    anchor: { lat: 50.9981, lng: -118.1957, name: "Revelstoke" }, origin: "mine",
  },
  {
    dtId: "ext-1", title: "Dolomites", stage: "planned",
    anchor: { lat: 46.4102, lng: 11.844, name: "Val Gardena" }, origin: "discover",
  },
];

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    net.fetched.push(url);
    if (url === "/api/trips/geo") {
      if (net.geo === "fail") throw new Error("geo down");
      return { ok: true, json: async () => ({ trips: net.geo === "ok" ? GEO : [] }) };
    }
    if (url.startsWith("/api/trips")) {
      if (net.trips === "fail") throw new Error("graph down");
      return { ok: true, json: async () => ({ trips: TRIPS }) };
    }
    if (url.startsWith("/api/feed")) {
      if (net.feed === "fail") throw new Error("graph down");
      return {
        ok: true,
        json: async () => ({ generatedAt: "2026-09-15T00:00:00Z", items: net.feed === "empty" ? [] : FEED }),
      };
    }
    if (url.startsWith("/api/showcase")) {
      if (net.showcase === "fail") throw new Error("graph down");
      const trips =
        net.showcase === "empty" ? [] : net.showcase === "mine-only" ? [SHOWCASE[1]] : SHOWCASE;
      return { ok: true, json: async () => ({ trips }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }),
);

const { LandingPage } = await import("./LandingPage");

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  net.trips = "ok";
  net.feed = "ok";
  net.showcase = "ok";
  net.geo = "empty";
  net.fetched = [];
  authState.isAuthenticated = true;
  authState.isLoading = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function mount(): Promise<HTMLElement> {
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );
  });
  return container!;
}

function bandOrder(el: HTMLElement): string[] {
  return [...el.querySelectorAll("main section[aria-label]")].map(
    (s) => s.getAttribute("aria-label") ?? "",
  );
}

describe("the four bands", () => {
  it("renders Up next, Your trips, Following and Discover in that order", async () => {
    const el = await mount();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Following", "Discover"]);
    expect(el.textContent).toContain("Happening now");
    expect(el.textContent).toContain("Ski Week");
  });

  it("does not duplicate the Up-next trip into the grid", async () => {
    const el = await mount();
    const links = [...el.querySelectorAll('a[href="/t/live-1"]')];
    expect(links).toHaveLength(1);
  });

  it("shows followed writes with the feed link, and keeps the server's rows", async () => {
    const el = await mount();
    expect(el.textContent).toContain("Rifugio lunch");
    expect(el.querySelector('a[href="/feed"]')).toBeTruthy();
    // the my-trip row is not in the Following band — that band is other people
    expect(el.textContent).not.toContain("Updated title");
  });

  it("never shows your own trips in Discover", async () => {
    const el = await mount();
    const discover = el.querySelector('section[aria-label="Discover"]')!;
    expect(discover.textContent).toContain("Dolomites");
    expect(discover.textContent).not.toContain("Canada Heliski");
  });
});

describe("empty bands collapse", () => {
  it("collapses Following and Discover to one line each", async () => {
    net.feed = "empty";
    net.showcase = "empty";
    const el = await mount();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Following", "Discover"]);
    const following = el.querySelector('section[aria-label="Following"]')!;
    expect(following.querySelector("ul")).toBeNull();
    expect(following.textContent).toContain("Nothing here yet");
    const discover = el.querySelector('section[aria-label="Discover"]')!;
    expect(discover.querySelector("a[href^='/t/']")).toBeNull();
    expect(discover.textContent).toContain("No public trips to discover right now.");
  });
});

describe("search and stage filters", () => {
  it("filters the trip bands by text", async () => {
    const el = await mount();
    const input = el.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      input.focus();
      // React 19: native setter + input event drives the controlled input.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "heliski");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    expect(yours.textContent).toContain("Canada Heliski");
    expect(yours.textContent).not.toContain("Japan Campervan");
  });

  it("filters by stage chip, and Up next steps aside while filtering", async () => {
    const el = await mount();
    const chip = [...el.querySelectorAll("button")].find((b) => b.textContent === "idea")!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(bandOrder(el)).toEqual(["Your trips", "Following", "Discover"]);
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    expect(yours.textContent).toContain("Japan Campervan");
    expect(yours.textContent).not.toContain("Canada Heliski");
  });
});

describe("failure isolation", () => {
  it("errors the page when the trips read fails", async () => {
    net.trips = "fail";
    const el = await mount();
    expect(el.querySelector('[role="alert"]')).toBeTruthy();
    expect(el.textContent).toContain("graph down");
  });

  it("collapses the Following and Discover bands when only they fail", async () => {
    net.feed = "fail";
    net.showcase = "fail";
    const el = await mount();
    // no page-level error — your trips still render
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain("Canada Heliski");
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Following", "Discover"]);
  });
});

describe("the map canvas", () => {
  it("collapses the map when there is no geo, keeping the bands", async () => {
    net.geo = "empty";
    const el = await mount();
    expect(el.querySelector("[data-home-map]")).toBeNull();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Following", "Discover"]);
    expect(el.textContent).toContain("Canada Heliski");
  });

  it("collapses the map when the geo read fails, without erroring", async () => {
    net.geo = "fail";
    const el = await mount();
    expect(el.querySelector("[data-home-map]")).toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain("Canada Heliski");
  });

  it("puts the bands beside the map when geo arrives", async () => {
    net.geo = "ok";
    const el = await mount();
    expect(el.querySelector("[data-home-map]")).toBeTruthy();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Following", "Discover"]);
    expect(el.textContent).toContain("Ski Week");
  });

  it("shows the what's-next line in the sheet header", async () => {
    net.geo = "ok";
    const el = await mount();
    expect(el.querySelector('[data-testid="sheet-header"]')!.textContent).toContain("Ski Week");
  });

  it("raises the row a hovered card belongs to, for its pin", async () => {
    net.geo = "ok";
    const el = await mount();
    const card = el.querySelector('a[href="/t/booked-1"]')!;
    await act(async () => {
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(el.querySelector('[data-dtid="booked-1"]')!.className).toContain("outline-accent");
  });
});
