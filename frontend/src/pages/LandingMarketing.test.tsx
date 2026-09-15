// @vitest-environment jsdom
/**
 * The signed-out landing page (#249).
 *
 * This page has one job — tell a stranger what Kiseki is — and four constraints
 * worth a test each:
 *
 * - **It makes no network call at all.** The page shows an INVENTED example, not
 *   the graph. That is the fix for the leak this revision exists for: a stranger
 *   following a link from here landed on real trips, with booking codes, costs and
 *   the crew's checklist in them. Nothing fetched means nothing to leak, nothing to
 *   degrade and no empty state — and the prerender carries the whole page.
 * - **No real trip surface anywhere in it:** no `/t/` link, no `/media/` URL, no
 *   trip id, no booking code.
 * - **Photography is committed, local and present.** Every `<img>` points at
 *   `/marketing/…` and that file exists on disk — a typo here is a broken hero in
 *   production, which no unit test would otherwise catch.
 * - **No social proof we do not have.** No ratings, review counts or user numbers.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

// `import.meta.url` is an http:// URL under vitest's jsdom environment, so
// `fileURLToPath` refuses it — resolve from the frontend root instead (vitest runs
// with that as its cwd).
const PUBLIC_DIR = resolve(process.cwd(), "public");

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

function ssr(node: ReactElement): string {
  return renderToString(<MemoryRouter>{node}</MemoryRouter>)
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

async function mount(node: ReactElement): Promise<HTMLElement> {
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container!;
}

describe("the claim", () => {
  it("renders the whole page with no data and no fetch", () => {
    const out = ssr(<MarketingLanding />);
    expect(out).toContain("Plan it together. Live it for real.");
    expect(out).toContain("A trip moves through three stages.");
    expect(out).toContain("Nine days in Tokyo.");
    expect(out).toContain("Something you can hold.");
    expect(out).toContain("Every trip carries the same parts.");
    expect(out).toContain("Private until you say otherwise.");
    expect(out).toContain("Start with the trip you are already planning.");
    // The message for someone arriving with a link someone sent them.
    expect(out).toContain("reading a trip needs no account");
  });

  it("never calls the network — that is the whole point of the invented example", async () => {
    const spy = vi.fn(() => {
      throw new Error("the landing page must not fetch anything");
    });
    vi.stubGlobal("fetch", spy);
    await mount(<MarketingLanding />);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not explain itself to the visitor", () => {
    // Niko's call, and right: nobody cares whether the trip is an example. A note
    // about fiction is a note to the reviewer, not copy for a stranger — the band is
    // a view of the product, and the page claims nothing about it that would need
    // correcting. Where the honesty belongs is `lib/marketing.ts` and CREDITS.md.
    const out = ssr(<MarketingLanding />);
    for (const explaining of ["invented", "fictional", "fiction", "example trip"]) {
      expect(out).not.toContain(explaining);
    }
  });

  it("carries the drawn route, so the band shows a map before the map loads", () => {
    expect(ssr(<MarketingLanding />)).toContain("A route drawn as a dashed line");
  });

  it("carries no trip link, media URL or trip id", () => {
    const out = ssr(<MarketingLanding />);
    expect(out).not.toContain('href="/t/');
    expect(out).not.toContain("/media/");
    // The codes that were actually readable on a live public trip before v0.41.1:
    // if real content ever comes back to this page, one of these will trip.
    for (const leaked of ["9GMOL3", "STHS", "b16680e7", "bf29a027"]) {
      expect(out).not.toContain(leaked);
    }
  });

  it("never invents social proof", () => {
    const text = ssr(<MarketingLanding />);
    for (const fabricated of ["★", "review", "Review", "testimonial", "million", "trusted by"]) {
      expect(text).not.toContain(fabricated);
    }
  });

  it("keeps one h1 on the page (the brand bar owns it)", () => {
    const h1s = ssr(<MarketingLanding />).match(/<h1[\s>]/g) ?? [];
    expect(h1s).toHaveLength(1);
  });

  it("offers the sign-in CTA only when the page was given one", () => {
    const CTA = <a href="#sign-in-sentinel">Sign in</a>;
    expect(ssr(<MarketingLanding />)).not.toContain("sign-in-sentinel");
    expect(ssr(<MarketingLanding signIn={CTA} />)).toContain("sign-in-sentinel");
  });

  it("keeps the hero to ONE action, so it cannot duplicate the bar's Sign in", () => {
    // The bar carries Sign in. A second one beside the hero's CTA was a real
    // review catch on the previous revision.
    const CTA = <a href="#sign-in-sentinel">Sign in</a>;
    const html = ssr(<MarketingLanding signIn={CTA} />);
    expect(html.match(/#sign-in-sentinel/g) ?? []).toHaveLength(1);
    expect(html).toContain('href="#demo"');
  });
});

describe("the photography", () => {
  it("uses only committed local assets, and every one of them exists", async () => {
    const el = await mount(<MarketingLanding />);
    // `main img` — the header's logo lives outside it and is not a marketing asset.
    const srcs = [...el.querySelectorAll("main img")].map((img) => img.getAttribute("src") ?? "");
    expect(srcs.length).toBeGreaterThanOrEqual(5);
    for (const src of srcs) {
      expect(src.startsWith("/marketing/"), `${src} is not a committed asset`).toBe(true);
      expect(existsSync(`${PUBLIC_DIR}${src}`), `${src} is missing from frontend/public`).toBe(
        true,
      );
    }
  });

  it("loads the hero eagerly and everything below it lazily (§9)", async () => {
    const el = await mount(<MarketingLanding />);
    const images = [...el.querySelectorAll("main img")];
    const hero = images.find((img) => img.getAttribute("src") === "/marketing/hero.jpg");
    expect(hero).toBeTruthy();
    expect(hero!.getAttribute("loading")).toBeNull();
    for (const img of images.filter((i) => i !== hero)) {
      expect(img.getAttribute("loading"), `${img.getAttribute("src")} is not lazy`).toBe("lazy");
    }
  });

  it("gives every image alt text, and the decorative ones an empty alt", async () => {
    const el = await mount(<MarketingLanding />);
    for (const img of el.querySelectorAll("img")) {
      expect(img.hasAttribute("alt"), `${img.getAttribute("src")} has no alt`).toBe(true);
    }
  });
});

describe("the example trip", () => {
  it("shows the parts that make it legible as a trip", async () => {
    const el = await mount(<MarketingLanding />);
    const text = el.textContent ?? "";
    expect(text).toContain("Nine days in Tokyo");
    expect(text).toContain("Day 3");
    expect(text).toContain("Golden Gai");
    expect(text).toContain("Booked · confirmation on file");
    expect(text).toContain("Shinjuku");
  });

  it("shows a booking chip with no code in it", async () => {
    const el = await mount(<MarketingLanding />);
    const chip = [...el.querySelectorAll("p")].find((p) =>
      (p.textContent ?? "").includes("confirmation on file"),
    );
    expect(chip).toBeTruthy();
    // The feature, without anyone's reference: no code-like token in the chip.
    expect(chip!.textContent ?? "").not.toMatch(/\b[A-Z0-9]{5,}\b/);
  });
});

describe("the ordering rule (kept for the signed-in discovery home)", () => {
  it("sorts furthest-along first, then soonest, then title", () => {
    const ordered = sortShowcaseTrips([
      { dtId: "c", title: "Zeta", subtitle: "", stage: "idea", startDate: "2027-01-01", cover: null },
      { dtId: "a", title: "Alpha", subtitle: "", stage: "booked", startDate: "2027-09-01", cover: null },
      { dtId: "b", title: "Beta", subtitle: "", stage: "booked", startDate: "2027-03-01", cover: null },
    ] as never);
    expect(ordered.map((t) => t.title)).toEqual(["Beta", "Alpha", "Zeta"]);
  });

  it("keeps an unknown stage instead of dropping the trip", () => {
    const ordered = sortShowcaseTrips([
      { dtId: "a", title: "Known", subtitle: "", stage: "planned", startDate: "2027-01-01", cover: null },
      { dtId: "b", title: "Novel", subtitle: "", stage: "something-new", startDate: "2026-01-01", cover: null },
    ] as never);
    expect(ordered.map((t) => t.title)).toEqual(["Known", "Novel"]);
  });
});
