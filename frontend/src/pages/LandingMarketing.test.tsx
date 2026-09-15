// @vitest-environment jsdom
/**
 * The signed-out landing page (#249).
 *
 * This page has one job — tell a stranger what Kiseki is and get them into a
 * trip — and three constraints worth a test each:
 *
 * - **The claim stands alone.** Copy renders with no data at all, so the front
 *   door is readable when the graph is not (and prerenderable later).
 * - **The examples are fetched, never baked in.** This repo is public and
 *   carries no trip data (AGENTS.md); with nothing fetched, the page contains
 *   no trip links and no media URLs — that absence is asserted, not assumed.
 * - **No dead ends for a stranger.** An empty, failed or unreachable showcase
 *   collapses the band silently: no error copy, no spinner, no broken layout.
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
const { sortShowcaseTrips } = await import("../lib/marketing");

// Placeholder ids and titles — never real trip data (this repo is public).
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function card(dtId: string, title: string, stage: string, startDate: string, endDate?: string) {
  return { dtId, title, subtitle: "Somewhere", stage, startDate, endDate, cover: `/media/${dtId}/c.jpg` };
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
    expect(out).toContain("The trip as a living document.");
    expect(out).toContain("Three steps, no forms.");
    expect(out).toContain("One document, the whole trip.");
    expect(out).toContain("Start with the trip you are already planning.");
    // The message for someone arriving with a link someone sent them.
    expect(out).toContain("reading a trip needs no account");
  });

  it("carries no trip links or media of its own", () => {
    // With no fetch, an examples band would have to come from baked-in data.
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

  it("keeps one h1 on the page (the brand bar owns it)", () => {
    const h1s = ssr(<MarketingLanding />).match(/<h1[\s>]/g) ?? [];
    expect(h1s).toHaveLength(1);
  });
});

describe("the examples band", () => {
  it("shows what the API returns, linking each card to its trip route", async () => {
    stubFetch({ trips: [card(A, "A placeholder trip", "booked", "2027-02-15", "2027-03-02")] });
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).toContain("A placeholder trip");
    const link = el.querySelector(`a[href="/t/${A}"]`);
    expect(link).not.toBeNull();
    // The span is humanised ("2 weeks"), not a raw ISO range.
    expect(el.textContent).toMatch(/\d+ (day|days|week|weeks)/);
  });

  it("asks for the showcase once, anonymously, and for nothing else", async () => {
    const spy = stubFetch({ trips: [] });
    await mount(<MarketingLanding />);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe("/api/showcase");
    // No Authorization: the front door must never look like a signed-in read.
    expect(JSON.stringify(init ?? {})).not.toContain("Authorization");
    expect(JSON.stringify(init ?? {})).not.toContain("Bearer");
  });

  it("collapses silently when the graph returns nothing", async () => {
    stubFetch({ trips: [] });
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).not.toContain("Real trips");
    expect(el.textContent).not.toContain("Already being planned");
    // Still a complete page: the claim and the closing CTA are unaffected.
    expect(el.textContent).toContain("The trip as a living document.");
    expect(el.querySelector("#how")).not.toBeNull();
  });

  it("says nothing about a failure — a stranger sees no error state", async () => {
    stubFetch({ detail: "boom" }, false);
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).not.toContain("Real trips");
    for (const word of ["error", "Error", "failed", "Failed", "unavailable"]) {
      expect(el.textContent).not.toContain(word);
    }
    expect(el.textContent).toContain("The trip as a living document.");
  });

  it("survives an unreachable server", async () => {
    const spy = vi.fn(async () => {
      throw new TypeError("NetworkError");
    });
    vi.stubGlobal("fetch", spy);
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).toContain("The trip as a living document.");
    expect(el.textContent).not.toContain("Real trips");
  });

  it("survives a body in the wrong shape", async () => {
    stubFetch({ trips: "not-an-array" });
    const el = await mount(<MarketingLanding />);
    expect(el.textContent).toContain("The trip as a living document.");
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
});
