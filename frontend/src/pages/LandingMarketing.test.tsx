// @vitest-environment jsdom
/**
 * The signed-out landing page (#249).
 *
 * This page has one job — tell a stranger what Kiseki is and get them into a
 * trip — and four constraints worth a test each:
 *
 * - **The claim stands alone.** Copy renders with no data at all, so the front
 *   door is readable when the graph is not (and prerenderable later).
 * - **The examples are fetched, never baked in.** This repo is public and
 *   carries no trip data (AGENTS.md); with nothing fetched, the page contains
 *   no trip links and no media URLs — that absence is asserted, not assumed.
 * - **The photography is real or absent, never fake.** The hero photograph is
 *   the lead trip's own cover, and with no trip it degrades to a designed panel
 *   rather than a broken image or a grey box.
 * - **No social proof we do not have.** No ratings, review counts, user numbers
 *   or testimonials — the page must not grow them by accident.
 *
 * The real `fetchShowcase` runs against a stubbed `fetch`, so the request the
 * page makes (and the absence of credentials on it) is under test too.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  loginWithRedirect: vi.fn(async () => undefined),
}));

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: false,
    isLoading: false,
    user: undefined,
    getAccessTokenSilently: vi.fn(async () => "test-token"),
    loginWithRedirect: authState.loginWithRedirect,
    logout: vi.fn(async () => undefined),
  }),
}));

const { MarketingLanding } = await import("./LandingMarketing");
const { sortShowcaseTrips, leadShowcaseTrip, closingShowcaseTrip } = await import(
  "../lib/marketing"
);

// Placeholder ids and titles — never real trip data (this repo is public).
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function card(
  dtId: string,
  title: string,
  stage: string,
  startDate: string,
  endDate?: string,
  cover: string | null = `/media/${dtId}/c.jpg`,
) {
  return { dtId, title, subtitle: "Somewhere", stage, startDate, endDate, cover };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Stub global fetch; returns the spy so a test can inspect the request. */
function stubFetch(body: unknown, ok = true) {
  const spy = vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function ssr(node: ReactElement): string {
  return renderToString(<MemoryRouter>{node}</MemoryRouter>)
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Mount and let the showcase effect settle. */
async function mount(node: ReactElement): Promise<HTMLElement> {
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container!;
}

describe("the claim", () => {
  it("renders with no data at all — no fetch resolution needed", () => {
    const out = ssr(<MarketingLanding />);
    expect(out).toContain("Every trip, from first idea to printed book.");
    expect(out).toContain("A trip moves through three stages.");
    expect(out).toContain("Something you can hold.");
    expect(out).toContain("Every trip carries the same parts.");
    expect(out).toContain("Private until you say otherwise.");
    expect(out).toContain("Start with the trip you are already planning.");
    // The message for someone arriving with a link someone sent them.
    expect(out).toContain("reading a trip needs no account");
  });

  it("carries no trip links or media of its own", () => {
    // With no fetch, a trips band would have to come from baked-in data.
    // There is none: this repo is public and holds no trip data.
    const out = ssr(<MarketingLanding />);
    expect(out).not.toContain('href="/t/');
    expect(out).not.toContain("/media/");
    expect(out).not.toContain(">Real trips<");
  });

  it("offers the sign-in CTA in the hero only when the page was given one", () => {
    const CTA = <a href="#sign-in-sentinel">Sign in</a>;
    expect(ssr(<MarketingLanding />)).not.toContain("sign-in-sentinel");
    expect(ssr(<MarketingLanding signIn={CTA} />)).toContain("sign-in-sentinel");
  });

  it("does not put a second sign-in beside the hero's trip CTA", async () => {
    // The bar already carries Sign in. A trip to open is the hero's action, so
    // the only sign-in left on the page is the closing band's — one, not two.
    const CTA = <a href="#sign-in-sentinel">Sign in</a>;
    stubFetch({ trips: [card(A, "A placeholder trip", "booked", "2027-02-15")] });
    const el = await mount(<MarketingLanding signIn={CTA} />);
    expect(el.querySelectorAll('a[href="#sign-in-sentinel"]')).toHaveLength(1);
  });

  it("falls back to signing in as the hero's action when there is nothing to open", async () => {
    // Its own test on purpose: re-rendering the same component type into one
    // root PRESERVES state, so a second `mount` in the same test would still be
    // looking at the first fetch's trips.
    const CTA = <a href="#sign-in-sentinel">Sign in</a>;
    stubFetch({ trips: [] });
    const el = await mount(<MarketingLanding signIn={CTA} />);
    expect(el.querySelectorAll('a[href="#sign-in-sentinel"]')).toHaveLength(2);
  });

  it("keeps one h1 on the page (the brand bar owns it)", () => {
    const h1s = ssr(<MarketingLanding />).match(/<h1[\s>]/g) ?? [];
    expect(h1s).toHaveLength(1);
  });

  it("never invents social proof", async () => {
    stubFetch({ trips: [card(A, "A placeholder trip", "booked", "2027-02-15")] });
    const el = await mount(<MarketingLanding />);
    for (const fabricated of ["★", "review", "Review", "testimonial", "million", "trusted by"]) {
      expect(el.textContent).not.toContain(fabricated);
    }
  });
});

describe("the photography", () => {
  it("leads with the lead trip's own cover, eagerly loaded", async () => {
    stubFetch({
      trips: [card(B, "Second trip", "planned", "2027-05-01"), card(A, "Lead trip", "live", "2027-02-01")],
    });
    const el = await mount(<MarketingLanding />);
    // `live` sorts first, so its cover is the one at full bleed.
    const hero = el.querySelector(`img[src="/media/${A}/c.jpg"]`);
    expect(hero).not.toBeNull();
    // The hero is above the fold: never lazy (§9).
    expect(hero!.getAttribute("loading")).toBeNull();
    // And it is a door onto the real trip.
    expect(el.querySelector(`a[href="/t/${A}"]`)).not.toBeNull();
  });

  it("shows no photograph at all — but the same design — with nothing to show", async () => {
    stubFetch({ trips: [] });
    const el = await mount(<MarketingLanding />);
    expect(el.querySelector('img[src^="/media/"]')).toBeNull();
    expect(el.textContent).toContain("Every trip, from first idea to printed book.");
  });

  it("leads with a coverless trip rather than no hero at all", async () => {
    stubFetch({ trips: [card(A, "No cover yet", "idea", "2027-02-01", undefined, null)] });
    const el = await mount(<MarketingLanding />);
    expect(el.querySelector('img[src^="/media/"]')).toBeNull();
    expect(el.querySelector(`a[href="/t/${A}"]`)).not.toBeNull();
  });

  it("survives a cover that fails to load", async () => {
    stubFetch({ trips: [card(A, "Broken cover", "booked", "2027-02-15")] });
    const el = await mount(<MarketingLanding />);
    const hero = el.querySelector(`img[src="/media/${A}/c.jpg"]`)!;
    await act(async () => {
      hero.dispatchEvent(new Event("error"));
    });
    expect(el.textContent).toContain("Every trip, from first idea to printed book.");
    expect(el.querySelector(`a[href="/t/${A}"]`)).not.toBeNull();
  });

  it("puts the trip's real day count on the booklet cover", async () => {
    stubFetch({ trips: [card(A, "A placeholder trip", "booked", "2027-02-15", "2027-03-02")] });
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).toContain("A placeholder trip");
    expect(el.textContent).toMatch(/\d+ days/);
  });
});

describe("the trips band", () => {
  it("shows what the API returns, linking each trip to its route", async () => {
    stubFetch({
      trips: [
        card(A, "A placeholder trip", "booked", "2027-02-15", "2027-03-02"),
        card(B, "Another trip", "idea", "2027-04-01"),
        card(C, "A third trip", "planned", "2027-06-01"),
      ],
    });
    const el = await mount(<MarketingLanding />);
    for (const id of [A, B, C]) {
      expect(el.querySelector(`a[href="/t/${id}"]`)).not.toBeNull();
    }
    // The span is humanised ("2 weeks"), not a raw ISO range.
    expect(el.textContent).toMatch(/\d+ (day|days|week|weeks)/);
  });

  it("asks for the showcase once, anonymously, and for nothing else", async () => {
    const spy = stubFetch({ trips: [] });
    await mount(<MarketingLanding />);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe("/api/showcase");
    // No Authorization: the signed-out door must never look like a signed-in read.
    expect(JSON.stringify(init ?? {})).not.toContain("Authorization");
    expect(JSON.stringify(init ?? {})).not.toContain("Bearer");
  });

  it("collapses silently when the graph returns nothing", async () => {
    stubFetch({ trips: [] });
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).not.toContain("Being planned right now.");
    expect(el.textContent).not.toContain("Real trips");
    // Still a complete page: the claim and the closing CTA are unaffected.
    expect(el.textContent).toContain("Every trip, from first idea to printed book.");
    expect(el.querySelector("#how")).not.toBeNull();
  });

  it("says nothing about a failure — a stranger sees no error state", async () => {
    stubFetch({ detail: "boom" }, false);
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).not.toContain("Real trips");
    for (const word of ["error", "Error", "failed", "Failed", "unavailable"]) {
      expect(el.textContent).not.toContain(word);
    }
    expect(el.textContent).toContain("Every trip, from first idea to printed book.");
  });

  it("survives an unreachable server", async () => {
    const spy = vi.fn(async () => {
      throw new TypeError("NetworkError");
    });
    vi.stubGlobal("fetch", spy);
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).toContain("Every trip, from first idea to printed book.");
    expect(el.textContent).not.toContain("Real trips");
  });

  it("survives a body in the wrong shape", async () => {
    stubFetch({ trips: "not-an-array" });
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).toContain("Every trip, from first idea to printed book.");
    expect(el.textContent).not.toContain("Real trips");
  });
});

describe("the ordering rule", () => {
  it("sorts furthest-along first, then soonest, then title", () => {
    const ordered = sortShowcaseTrips([
      card(C, "Zeta", "idea", "2027-01-01"),
      card(A, "Alpha", "booked", "2027-09-01"),
      card(B, "Beta", "booked", "2027-03-01"),
    ] as never);
    expect(ordered.map((t) => t.title)).toEqual(["Beta", "Alpha", "Zeta"]);
  });

  it("leads with a trip happening right now", () => {
    const ordered = sortShowcaseTrips([
      card(A, "Booked", "booked", "2027-01-01"),
      card(B, "Live", "live", "2027-06-01"),
    ] as never);
    expect(ordered[0].title).toBe("Live");
  });

  it("keeps an unknown stage instead of dropping the trip", () => {
    const ordered = sortShowcaseTrips([
      card(A, "Known", "planned", "2027-01-01"),
      card(B, "Novel", "something-new", "2026-01-01"),
    ] as never);
    expect(ordered.map((t) => t.title)).toEqual(["Known", "Novel"]);
  });

  it("leads with a trip that can carry a photograph", () => {
    const coverless = card(A, "No cover", "booked", "2027-01-01", undefined, null);
    const withCover = card(B, "Has cover", "idea", "2027-02-01");
    expect(leadShowcaseTrip([coverless, withCover] as never)?.dtId).toBe(B);
    // Nothing to choose from: the coverless trip still leads, never null.
    expect(leadShowcaseTrip([coverless] as never)?.dtId).toBe(A);
    expect(leadShowcaseTrip([])).toBeNull();
  });

  it("never spends the lead's photo twice in the closing band", () => {
    const lead = card(A, "Lead", "booked", "2027-01-01");
    const other = card(B, "Other", "idea", "2027-02-01");
    expect(closingShowcaseTrip([lead, other] as never, lead as never)?.dtId).toBe(B);
    expect(closingShowcaseTrip([lead] as never, lead as never)).toBeNull();
  });
});
