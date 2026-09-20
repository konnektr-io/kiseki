// @vitest-environment jsdom
/**
 * The signed-in discovery home (#249, slice 2).
 *
 * The REAL LandingPage mounted into a DOM (the bands load in an effect, so
 * renderToString can't reach them), with `fetch` stubbed per URL and the Auth0
 * context controlled through a hoisted mock.
 *
 * Gates under test:
 * - the bands render in the documented order (Up next → Your trips →
 *   [Trips you follow] → Updates → Discover), and Up next does not duplicate
 *   into the grid;
 * - an empty band collapses to one line of copy, never an empty frame;
 * - the search box filters the trip bands by name, note and place;
 * - the facets (stage, season/month, Mine⇄Following provenance, visibility)
 *   live behind the Filters door and filter the trip bands when opened; feed
 *   rows take the text only, never the facets;
 * - Discover never shows your own trips;
 * - the map canvas renders beside the bands when geo arrives, and collapses
 *   (bands as-is, no error) when geo is empty or fails; hovering a card
 *   raises its row for the pin;
 * - a trips failure errors the page, but a feed/showcase/geo failure only
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
    detent,
  }: {
    header: React.ReactNode;
    content: React.ReactNode;
    map: (padding: { top: number; right: number; bottom: number; left: number }) => React.ReactNode;
    /** Exposed so the page-level test can pin which detent the page asks for. */
    detent?: string;
  }) => (
    <main data-detent={detent}>
      <div data-testid="sheet-header">{header}</div>
      {content}
      {map({ top: 0, right: 0, bottom: 0, left: 0 })}
    </main>
  ),
}));

const net = vi.hoisted(() => ({
  trips: "ok" as "ok" | "fail" | "empty" | "no-live" | "follower" | "follower-only",
  feed: "ok" as "ok" | "fail" | "empty",
  showcase: "ok" as "ok" | "fail" | "empty" | "mine-only",
  geo: "empty" as "ok" | "empty" | "fail",
  fetched: [] as string[],
  /** POST /api/trips/<id>/follow calls, in order. */
  followed: [] as string[],
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

/**
 * Someone else's trip the viewer follows (role=`follower`). Kept OUT of the
 * base TRIPS fixture on purpose: the "follower" fetch mode appends it, so the
 * follower-free tests above keep asserting the four-band order while the
 * suites below pin the split.
 */
const FOLLOWED_TRIP: TripSummary = {
  dtId: "followed-1", visibility: "public", title: "Lofoten", subtitle: "Arctic",
  stage: "planned", startDate: "2027-05-01", endDate: "2027-05-09", slug: "lofoten",
  role: "follower",
};

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
    dtId: "booked-1", title: "Canada Heliski", stage: "booked",
    anchor: { lat: 51.0, lng: -118.0, name: "Selkirks" }, origin: "mine",
  },
  {
    dtId: "ext-1", title: "Dolomites", stage: "planned",
    anchor: { lat: 46.4102, lng: 11.844, name: "Val Gardena" }, origin: "discover",
  },
];

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: { method?: string }) => {
    net.fetched.push(url);
    // Follow a public trip (#249 review) — the one write this page makes.
    if (url.endsWith("/follow") && init?.method === "POST") {
      net.followed.push(url);
      return { ok: true, json: async () => ({ dtId: url.split("/")[3] }) };
    }
    if (url === "/api/trips/geo") {
      if (net.geo === "fail") throw new Error("geo down");
      return { ok: true, json: async () => ({ trips: net.geo === "ok" ? GEO : [] }) };
    }
    if (url.startsWith("/api/trips")) {
      if (net.trips === "fail") throw new Error("graph down");
      if (net.trips === "empty") return { ok: true, json: async () => ({ trips: [] }) };
      if (net.trips === "follower") {
        return { ok: true, json: async () => ({ trips: [...TRIPS, FOLLOWED_TRIP] }) };
      }
      if (net.trips === "follower-only") {
        return { ok: true, json: async () => ({ trips: [FOLLOWED_TRIP] }) };
      }
      if (net.trips === "no-live") {
        return { ok: true, json: async () => ({ trips: TRIPS.filter((t) => t.stage !== "live") }) };
      }
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
  net.followed = [];
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
  it("renders Up next, Your trips, Updates and Discover in that order", async () => {
    const el = await mount();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Updates", "Discover"]);
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
    // the my-trip row is not in the Updates band — that band is other people
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
  it("collapses Updates and Discover to one line each", async () => {
    net.feed = "empty";
    net.showcase = "empty";
    const el = await mount();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Updates", "Discover"]);
    const updates = el.querySelector('section[aria-label="Updates"]')!;
    expect(updates.querySelector("ul")).toBeNull();
    expect(updates.textContent).toContain("Nothing here yet");
    const discover = el.querySelector('section[aria-label="Discover"]')!;
    expect(discover.querySelector("a[href^='/t/']")).toBeNull();
    expect(discover.textContent).toContain("No public trips to discover right now.");
  });
});

/**
 * The three interactions the search row and the Filters door are driven with.
 * Module scope, so both the search test and the facets block reach the same
 * helpers — a local copy in one `describe` is how the two drift apart.
 */
async function openFilters(el: HTMLElement): Promise<void> {
  const door = [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Filters"))!;
  await act(async () => {
    door.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setSearch(el: HTMLElement, value: string): Promise<void> {
  const input = el.querySelector('input[type="search"]') as HTMLInputElement;
  await act(async () => {
    input.focus();
    // React 19: native setter + input event drives the controlled input.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Click a facet chip, opening the door first when it is not on screen yet. */
async function clickChip(el: HTMLElement, text: string): Promise<void> {
  let chip = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!chip) {
    await openFilters(el);
    chip = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  }
  await act(async () => {
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

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
    await openFilters(el);
    const chip = [...el.querySelectorAll("button")].find((b) => b.textContent === "idea")!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(bandOrder(el)).toEqual(["Your trips", "Updates", "Discover"]);
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

  it("collapses the Updates and Discover bands when only they fail", async () => {
    net.feed = "fail";
    net.showcase = "fail";
    const el = await mount();
    // no page-level error — your trips still render
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain("Canada Heliski");
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Updates", "Discover"]);
  });
});

describe("the map canvas", () => {
  it("collapses the map when there is no geo, keeping the bands", async () => {
    net.geo = "empty";
    const el = await mount();
    expect(el.querySelector("[data-home-map]")).toBeNull();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Updates", "Discover"]);
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
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Updates", "Discover"]);
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

describe("the global trip map layer", () => {
  it("toggles the discoverable pins, default on", async () => {
    net.geo = "ok";
    const el = await mount();
    const toggle = el.querySelector('button[aria-label^="Discoverable trips"]')!;
    const mapLabel = () => el.querySelector('[role="img"]')?.getAttribute("aria-label");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toContain("Discover · 1");
    expect(mapLabel()).toBe("Map of 3 trip locations");
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(mapLabel()).toBe("Map of 2 trip locations");
  });

  it("opens the trip card for the raised row, and closes it", async () => {
    net.geo = "ok";
    const el = await mount();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    const card = el.querySelector('a[href="/t/booked-1"]')!;
    await act(async () => {
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const preview = el.querySelector('[role="dialog"]')!;
    expect(preview.textContent).toContain("Canada Heliski");
    expect(preview.querySelector('a[href="/t/booked-1"]')).toBeTruthy();
    const close = preview.querySelector(
      'button[aria-label="Close trip preview"]',
    ) as HTMLElement;
    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it("hides the toggle when there is nothing to toggle", async () => {
    net.geo = "empty";
    const el = await mount();
    expect(el.querySelector('button[aria-label^="Discoverable trips"]')).toBeNull();
  });
});

describe("search and the Filters door", () => {
  const door = (el: HTMLElement) =>
    [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Filters"))!;

  it("hides every facet behind the door, and shows none of them by default", async () => {
    const el = await mount();
    // The door is the only facet control on screen: no season/stage/whichever
    // pills, and no second text box for the place.
    expect(door(el)).toBeTruthy();
    expect(door(el).getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector("[data-home-filters]")).toBeNull();
    expect(el.querySelector('input[placeholder="Place or region"]')).toBeNull();
    expect(el.querySelectorAll('input[type="search"]')).toHaveLength(1);
    for (const label of ["winter", "public", "Mine", "idea"]) {
      expect([...el.querySelectorAll("button")].some((b) => b.textContent === label)).toBe(false);
    }
    await openFilters(el);
    expect(door(el).getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector("[data-home-filters]")).toBeTruthy();
    // …and the panel renders in the page flow, not as a floating popover.
    expect(el.querySelector("[data-home-filters]")!.className).not.toContain("absolute");
  });

  it("badges the door with the facet count, and clears them all", async () => {
    const el = await mount();
    expect(door(el).textContent).not.toMatch(/\d/);
    await clickChip(el, "Mine");
    expect(door(el).textContent).toContain("1");
    await clickChip(el, "public");
    expect(door(el).textContent).toContain("2");
    const clear = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Clear all filters"),
    )!;
    await act(async () => {
      clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(door(el).textContent).not.toMatch(/\d/);
    // Clearing facets leaves the search text alone — it is visible, so wiping
    // it would be a surprise.
    await setSearch(el, "heliski");
    expect((el.querySelector('input[type="search"]') as HTMLInputElement).value).toBe("heliski");
    await clickChip(el, "Mine");
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Clear all filters"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect((el.querySelector('input[type="search"]') as HTMLInputElement).value).toBe("heliski");
  });

  it("filters by season, from the start date", async () => {
    const el = await mount();
    await clickChip(el, "winter");
    // February starts stay; September and the dateless go. Up next steps aside.
    expect(bandOrder(el)).toEqual(["Your trips", "Updates", "Discover"]);
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    expect(yours.textContent).toContain("Canada Heliski");
    expect(yours.textContent).not.toContain("Japan Campervan");
  });

  it("searches the place as well as the words, off the geo anchors", async () => {
    net.geo = "ok"; // anchors come from the geo read
    const el = await mount();
    await setSearch(el, "selk");
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    expect(yours.textContent).toContain("Canada Heliski");
    expect(yours.textContent).not.toContain("Japan Campervan");
  });

  it("filters by provenance: Mine hides the discover shelf", async () => {
    const el = await mount();
    await clickChip(el, "Mine");
    const discover = el.querySelector('section[aria-label="Discover"]')!;
    expect(discover.querySelector("a[href^='/t/']")).toBeNull();
    expect(discover.textContent).toContain("No public trips match this search.");
    // Your own trips are untouched by the same facet.
    expect(el.querySelector('section[aria-label="Your trips"]')!.textContent).toContain(
      "Canada Heliski",
    );
  });

  it("filters by visibility", async () => {
    const el = await mount();
    await clickChip(el, "public");
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    expect(yours.textContent).toContain("Canada Heliski");
    expect(yours.textContent).not.toContain("Japan Campervan");
  });

  it("applies the search text to the Updates band, and skips the facets there", async () => {
    const el = await mount();
    await setSearch(el, "rifugio");
    const updates = el.querySelector('section[aria-label="Updates"]')!;
    expect(updates.textContent).toContain("Rifugio lunch");
    await setSearch(el, "nowhere-near-anything");
    expect(el.querySelector('section[aria-label="Updates"]')!.querySelector("ul")).toBeNull();
  });

  it("closes the door on Escape", async () => {
    const el = await mount();
    await openFilters(el);
    expect(el.querySelector("[data-home-filters]")).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(el.querySelector("[data-home-filters]")).toBeNull();
  });
});

describe("the phone's first impression", () => {
  it("opens the sheet at `half` — the bands first, the map a swipe down", async () => {
    net.geo = "ok"; // the canvas branch is the one with a detent
    const el = await mount();
    // Niko's call (2026-09-16 review): the bands give more context on arrival,
    // and swiping DOWN for the map beats swiping UP for your trips. (An earlier
    // revision opened at `peek` so every pin cleared the sheet; the camera
    // stays honest either way — see DESIGN.md §2.2 on the zoom floor.)
    expect(el.querySelector("[data-detent]")!.getAttribute("data-detent")).toBe("half");
  });

  it("still renders every band under the collapsed sheet", async () => {
    const el = await mount();
    expect(bandOrder(el)).toEqual(["Up next", "Your trips", "Updates", "Discover"]);
  });
});

describe("a brand-new account", () => {
  it("gets something to look at: the public shelf, not just a button", async () => {
    net.trips = "empty";
    const el = await mount();
    expect(el.textContent).toContain("No trips yet");
    // 2026-09-16 review: "No trips yet" + one button asked a stranger to take
    // the product on faith — show the discoverable shelf instead.
    expect(el.textContent).toContain("Trips worth a look");
    const shelf = el.querySelector('section[aria-label="Trips worth a look"]')!;
    expect(shelf.querySelectorAll('a[href^="/t/"]').length).toBeGreaterThan(0);
  });

  it("makes every shelf card followable, without opening it", async () => {
    net.trips = "empty";
    const el = await mount();
    // Target one card BY NAME: the shelf is sorted (booked before planned), so
    // "the first button" would silently depend on the comparator.
    const follow = el.querySelector(
      'button[aria-label="Follow Canada Heliski"]',
    ) as HTMLElement;
    expect(follow).toBeTruthy();
    // Never nested in the card's link: a button inside an anchor is invalid
    // HTML and the click would fight the navigation.
    expect(follow.closest("a")).toBeNull();
    await act(async () => {
      follow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(net.followed).toEqual(["/api/trips/booked-1/follow"]);
    expect(el.textContent).toContain("Following");
    // Followed = a role on it, so the home re-reads and the trip moves into
    // "Trips you follow" instead of lingering on the shelf.
    expect(net.fetched.filter((u) => u === "/api/trips").length).toBeGreaterThan(1);
  });

  it("skips your own trips on the shelf", async () => {
    net.trips = "empty";
    const el = await mount();
    const shelf = el.querySelector('section[aria-label="Trips worth a look"]')!;
    // SHOWCASE has two trips, one of which (booked-1) is in TRIPS — with an
    // empty account neither is "mine", so both are shelf material.
    expect(shelf.querySelectorAll('a[href^="/t/"]').length).toBe(2);
  });
});

describe("the peek line is a door, not a label", () => {
  const stripLink = (el: HTMLElement, href: string) =>
    el.querySelector(`[data-testid="sheet-header"] a[href="${href}"]`);

  it("links the Up next title to its trip", async () => {
    net.geo = "ok";
    const el = await mount();
    // The default fixtures have a LIVE trip, and `nextUpTrip` prefers it.
    expect(stripLink(el, "/t/live-1")).toBeTruthy();
  });

  it("offers Today while a trip is happening", async () => {
    net.geo = "ok";
    const el = await mount();
    // A live trip's useful destination is the day it is on right now (§7.5's
    // live swap), so the strip carries both doors.
    expect(stripLink(el, "/t/live-1/today")).toBeTruthy();
  });

  it("offers no Today link when nothing is live", async () => {
    net.geo = "ok";
    net.trips = "no-live";
    const el = await mount();
    expect(stripLink(el, "/t/booked-1")).toBeTruthy();
    expect(el.querySelector('[data-testid="sheet-header"] a[href$="/today"]')).toBeNull();
  });
});

describe("the auth transition (React #310)", () => {
  /**
   * What shipped broken in v0.58.0: the four follow hooks sat BELOW the two
   * early returns in `AuthenticatedLanding`, so the first paint (`authLoading`)
   * rendered fewer hooks than the signed-in paint. React throws #310 —
   * "Rendered more hooks than during the previous render" — the moment auth
   * resolves, and the signed-in home died for real users.
   *
   * Nothing caught it: every test in this file starts authenticated, and the
   * browser probe's `?kiseki_e2e=1` seam stubs auth as ALREADY resolved, so no
   * test — unit or browser — ever rendered the transition. These two do, on one
   * component instance, which is the only shape that can catch it.
   */
  async function rerender(): Promise<void> {
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>,
      );
    });
  }

  it("survives auth loading → signed in", async () => {
    authState.isLoading = true;
    const el = await mount();
    expect(el.textContent).toContain("Loading…");
    authState.isLoading = false;
    authState.isAuthenticated = true;
    await rerender();
    expect(el.textContent).toContain("Home");
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("survives anonymous → signed in", async () => {
    authState.isAuthenticated = false;
    const el = await mount();
    // Signed out, the front door is the marketing page.
    expect(el.textContent).toContain("Sign in");
    authState.isAuthenticated = true;
    await rerender();
    expect(el.textContent).toContain("Home");
  });

  it("keeps the follow action working after the transition", async () => {
    // The hooks that caused #310 are the follow ones, so prove they are alive
    // on the far side of the transition — not merely present.
    authState.isLoading = true;
    const el = await mount();
    authState.isLoading = false;
    net.trips = "empty";
    await rerender();
    const follow = el.querySelector('button[aria-label^="Follow "]') as HTMLElement;
    expect(follow).toBeTruthy();
    await act(async () => {
      follow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(net.followed).toHaveLength(1);
  });
});

describe("followed trips are not your trips", () => {
  it("bands a followed trip under 'Trips you follow', never 'Your trips'", async () => {
    net.trips = "follower";
    const el = await mount();
    expect(bandOrder(el)).toEqual([
      "Up next",
      "Your trips",
      "Trips you follow",
      "Updates",
      "Discover",
    ]);
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    expect(yours.textContent).not.toContain("Lofoten");
    const followedBand = el.querySelector('section[aria-label="Trips you follow"]')!;
    expect(followedBand.textContent).toContain("Lofoten");
    // The card is honest about whose trip it is.
    expect(followedBand.textContent).toContain("follower");
  });

  it("hides followed trips behind the Mine facet, with the band's one-line collapse", async () => {
    net.trips = "follower";
    const el = await mount();
    await clickChip(el, "Mine");
    // Your own trips are untouched by the same facet.
    expect(el.querySelector('section[aria-label="Your trips"]')!.textContent).toContain(
      "Canada Heliski",
    );
    // The band stays (a filter is hiding its rows) and says so in one line.
    const followedBand = el.querySelector('section[aria-label="Trips you follow"]')!;
    expect(followedBand.textContent).toContain("No followed trips match this search.");
    expect(followedBand.querySelector('a[href^="/t/"]')).toBeNull();
  });

  it("never sprouts the band on a follower-free home, filtering or not", async () => {
    const el = await mount();
    expect(el.querySelector('section[aria-label="Trips you follow"]')).toBeNull();
    await clickChip(el, "idea");
    expect(bandOrder(el)).toEqual(["Your trips", "Updates", "Discover"]);
    expect(el.querySelector('section[aria-label="Trips you follow"]')).toBeNull();
  });
});

describe("a brand-new account on the canvas", () => {
  it("shows the discovery map behind the empty state, with the agent one tap away", async () => {
    net.trips = "empty";
    net.geo = "ok";
    const el = await mount();
    // The canvas is the empty state's backdrop now, not a collapse case.
    expect(el.querySelector("[data-home-map]")).toBeTruthy();
    expect(el.querySelector("[data-detent]")).toBeTruthy();
    expect(el.textContent).toContain("No trips yet");
    // Plan-a-trip stays the obvious CTA — the card's own button…
    const plan = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Plan a trip"),
    )!;
    expect(plan).toBeTruthy();
    // …and the header chat toggle — the agent's generic door, same slot as
    // the in-trip chat.
    const toggle = el.querySelector('header button[aria-label="Open chat"]');
    expect(toggle).toBeTruthy();
    // The sheet header points at the discovery pins, not a "0 trips" count.
    expect(el.querySelector('[data-testid="sheet-header"]')!.textContent).toContain(
      "to discover on the map",
    );
  });

  it("still collapses to the reading column when there is nothing to stand on", async () => {
    net.trips = "empty";
    net.geo = "empty";
    const el = await mount();
    expect(el.querySelector("[data-home-map]")).toBeNull();
    expect(el.textContent).toContain("No trips yet");
    expect(el.textContent).toContain("Trips worth a look");
    // The agent doors survive the collapse too: header toggle + card button.
    expect(el.querySelector('header button[aria-label="Open chat"]')).toBeTruthy();
    expect(el.textContent).toContain("Plan a trip");
  });
});

describe("creation stays visible on populated homes (#347)", () => {
  it("keeps a Plan-a-trip action on Your trips next to the header toggle", async () => {
    const el = await mount();
    // One generic door (header toggle) plus one intent-framed action — never
    // two labelled buttons to the same chat.
    expect(el.textContent).not.toContain("Ask Kiseki");
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    const plan = [...yours.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Plan a trip"),
    );
    expect(plan).toBeTruthy();
    expect(plan?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(el.querySelector('header button[aria-label="Open chat"]')).toBeTruthy();
  });

  it("keeps both doors on a follow-only home, where the empty card never renders", async () => {
    net.trips = "follower-only";
    const el = await mount();
    // The reported shape: trips is non-empty (a followed trip), so the "No
    // trips yet" card is gone — creation must still be one tap away.
    expect(el.textContent).not.toContain("No trips yet");
    const yours = el.querySelector('section[aria-label="Your trips"]')!;
    expect(yours.textContent).toContain("Trips you plan or join will land here.");
    const plan = [...yours.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Plan a trip"),
    );
    expect(plan).toBeTruthy();
    expect(el.querySelector('header button[aria-label="Open chat"]')).toBeTruthy();
  });
});
