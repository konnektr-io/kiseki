// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/* The #231 contract on the page that owns the grey area: the practical page
 * renders the TriCount card ONLY for a trip that actually has a connection.
 * An unlinked trip used to carry the owner's whole setup card at the top of
 * this page — for a trip that may never use TriCount, that was the wrong
 * prominence (the connect affordance now lives in the trip actions menu, see
 * `components/trip-controls.test.tsx`).
 *
 * SSR is enough here: both branches are plain render conditionals, and a
 * server render runs no effects, so the connected panel paints its
 * pre-fetch state deterministically. Every assertion is paired with a
 * positive one, so a page that rendered nothing at all cannot pass. */

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchTricountSnapshot: vi.fn() };
});

import { PracticalsPage } from "./PracticalsPage";
import { TripProvider } from "../components/theme";
import { EditModeProvider } from "../components/edit-mode";
import * as api from "../lib/api";
import type { Trip } from "../lib/types";

function tripWith(practical: Trip["practical"], role = "owner"): Trip {
  return {
    id: "t-231",
    slug: "tricount-trip",
    title: "Tricount trip",
    stage: "planned",
    visibility: "private",
    myRole: role as Trip["myRole"],
    locations: [],
    sections: [],
    crew: [],
    days: [],
    // A todo keeps the page's own content on screen: the regression guard is
    // "the TriCount card is gone", never "the page is blank".
    practical: { todos: [{ label: "Book the ferry", done: false }], ...practical },
  } as unknown as Trip;
}

function renderPage(practical: Trip["practical"], role = "owner"): string {
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: ["/t/t-231/practical"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/t/:tripId/practical",
          element: createElement(TripProvider, {
            trip: tripWith(practical, role),
            apply: () => {},
            children: createElement(PracticalsPage),
          }),
        }),
      ),
    ),
  );
}

describe("practicals page — TriCount card (#231)", () => {
  it("owner, nothing linked: no TriCount card on the page at all", () => {
    const html = renderPage({});
    expect(html).not.toContain("TriCount");
    // The old setup copy is gone with it.
    expect(html).not.toContain("shared expense pot");
    // Positive control: the page rendered its real content.
    expect(html).toContain("Book the ferry");
  });

  it("owner, linked: the connected panel renders with the trip's TriCount link", () => {
    const html = renderPage({ tricount: { registryKey: "tAbC123" } });
    expect(html).toContain("TriCount");
    expect(html).toContain("Open in Tricount");
    expect(html).toContain("https://tricount.com/tAbC123");
    // The pre-fetch state, not an empty shell.
    expect(html).toContain("No data.");
    // And no connect field sneaks onto the page.
    expect(html).not.toContain("Tricount sharing link or key");
  });

  it("crew (viewer), nothing linked: no TriCount card — the page is not a settings surface", () => {
    const html = renderPage({}, "viewer");
    expect(html).not.toContain("TriCount");
    expect(html).toContain("Book the ferry");
  });

  it("follower, nothing linked: no TriCount card either", () => {
    const html = renderPage({}, "follower");
    expect(html).not.toContain("TriCount");
    expect(html).toContain("Book the ferry");
  });
});

/* #254 — a roadbook's practicalities used to collapse into the single `notes`
 * string (one 688-char blob on the live trip). They now come in as titled
 * `blocks[]`, each rendering under its own heading in list order. The legacy
 * blob is NOT migrated on read: a trip that has one keeps showing it. */
describe("practicals page — titled practicalities blocks (#254)", () => {
  // The issue's own acceptance case: a roadbook section with these three
  // headings produces three titled blocks, in this order.
  const blocks: NonNullable<Trip["practical"]["blocks"]> = [
    { title: "Driving times", body: "San José to Tortuguero: 3 h 30 + 1 h 30 boat" },
    { title: "Money & tipping", body: "10 % service charge; cash at the SINAC gates" },
    { title: "Water & health", body: "Tap water is fine in San José; repellent on the Caribbean coast" },
  ];

  it("renders each block under its own heading, in list order", () => {
    const html = renderPage({ blocks });
    expect(html).toContain("Driving times");
    expect(html).toContain("Tortuguero");
    // React escapes `&` in text nodes (SSR writes `&amp;`) — the heading still
    // has to be the roadbook's, verbatim.
    expect(html).toMatch(/Money &(amp;)? tipping/);
    expect(html).toContain("SINAC gates");
    expect(html).toMatch(/Water &(amp;)? health/);
    // Order is the data's, not the renderer's.
    const order = ["Driving times", /Money &(amp;)? tipping/, /Water &(amp;)? health/];
    const positions = order.map((s) =>
      typeof s === "string" ? html.indexOf(s) : html.search(s as RegExp),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps a legacy notes blob beside the blocks — nothing is migrated away", () => {
    const html = renderPage({ notes: "Tap water is fine in San José only.", blocks });
    expect(html).toContain("Tap water is fine");
    expect(html).toContain("At a glance");
    expect(html).toContain("Driving times");
  });

  it("a notes-only trip renders exactly as before — no stray headings, no empty sections", () => {
    const html = renderPage({ notes: "Bring the puffer." });
    expect(html).toContain("Bring the puffer.");
    expect(html).not.toContain("Driving times");
    expect(html).not.toMatch(/Money &(amp;)? tipping/);
  });

  it("blocks sit between the checklist and the contacts", () => {
    const html = renderPage({
      blocks,
      contacts: [{ label: "Lodge", value: "+1 555 0100" }],
    });
    const positions = ["Book the ferry", "Driving times", "Lodge"].map((s) => html.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

/* #296 — practical blocks fix inline (title/body), addressed by list
 * position with exact payloads. Mounted for real (jsdom): the pencil →
 * field → save loop and the role gates on BOTH sides (editor saves with an
 * exact payload; viewer sees no chrome and fires no request). */
describe("practicals page — inline block edit (#296)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const blocks: NonNullable<Trip["practical"]["blocks"]> = [
    { title: "Money & tipping", body: "Cash at the gates" },
  ];

  function Harness({ role, editMode }: { role: string; editMode: boolean }) {
    const [trip, setTrip] = useState(tripWith({ blocks }, role));
    return createElement(TripProvider, {
      trip,
      apply: setTrip,
      children: createElement(EditModeProvider, {
        tripId: "t-231",
        initial: editMode,
        children: createElement(
          MemoryRouter,
          { initialEntries: ["/t/t-231/practical"] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/t/:tripId/practical",
              element: createElement(PracticalsPage),
            }),
          ),
        ),
      }),
    });
  }

  async function mountInteractive(role: string, editMode = false) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Harness, { role, editMode }));
    });
  }

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function click(el: Element) {
    await act(async () => {
      (el as HTMLElement).click();
      await Promise.resolve();
    });
  }

  it("editor: saving a body sends the exact payload (index + changed field only)", async () => {
    // Echoes the patch back like the server's canonical document would.
    const putSpy = vi
      .spyOn(api, "putPracticalBlock")
      .mockImplementation(
        async (_tripId: string, index: number, patch: { title?: string; body?: string }) => ({
          ...tripWith({ blocks }, "editor"),
          practical: {
            todos: [{ label: "Book the ferry", done: false }],
            blocks: blocks.map((b, i) => (i === index ? { ...b, ...patch } : b)),
          },
        }) as unknown as Trip,
      );
    await mountInteractive("editor", true);
    const pencil = container!.querySelector(
      'button[aria-label="Edit Practical section body"]',
    ) as HTMLButtonElement;
    expect(pencil).not.toBeNull();
    await click(pencil);
    const area = container!.querySelector("textarea") as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(area, "Cards everywhere now");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "Save",
    ) as HTMLButtonElement;
    await click(save);
    await flush();
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith("t-231", 0, { body: "Cards everywhere now" }, "test-token");
    // The canonical doc landed: the new body reads back on the page.
    expect(container!.textContent).toContain("Cards everywhere now");
  });

  it("editor with edit mode OFF reads: no pencil, no request", async () => {
    const putSpy = vi.spyOn(api, "putPracticalBlock");
    await mountInteractive("editor", false);
    await flush();
    expect(container!.textContent).toMatch(/Money &(amp;)? tipping/);
    expect(container!.textContent).toContain("Cash at the gates");
    expect(container!.querySelectorAll("button").length).toBe(0);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("viewer: block content renders with no edit chrome and no request", async () => {
    const putSpy = vi.spyOn(api, "putPracticalBlock");
    await mountInteractive("viewer");
    await flush();
    expect(container!.textContent).toMatch(/Money &(amp;)? tipping/);
    expect(container!.textContent).toContain("Cash at the gates");
    expect(container!.querySelectorAll("button").length).toBe(0);
    expect(putSpy).not.toHaveBeenCalled();
  });
});
/* #301 — `practical.links` and a todo's own links are content-supplied targets
 * too, and both rendered `<a target="_blank">`: an in-app target (the trip's own
 * day route) opened a second tab, an off-app one should. */
const ANCHORS = /<a\b[^>]*>/g;

describe("practicals page content links follow their target (#301)", () => {
  const DAY_URL = "/t/t-231/day/3";

  function anchorsFor(html: string, href: string): string[] {
    return (html.match(ANCHORS) ?? []).filter((a) => a.includes(`href="${href}"`));
  }

  it("keeps the practical links and a todo's link in the app", () => {
    const html = renderPage({
      links: [
        { label: "Open the day", url: DAY_URL },
        { label: "Strava", url: "https://www.strava.com/activities/9001" },
      ],
      todos: [{ label: "Book the ferry", done: false, links: [{ label: "Open the day", url: DAY_URL }] }],
    });
    const internal = anchorsFor(html, DAY_URL);
    // the todo's pill + the "Important links" row
    expect(internal.length).toBeGreaterThanOrEqual(2);
    for (const a of internal) expect(a).not.toContain('target="_blank"');

    const external = anchorsFor(html, "https://www.strava.com/activities/9001");
    expect(external.length).toBe(1);
    expect(external[0]).toContain('target="_blank"');
  });
});

/* #315 — the Group card is who is coming: followers are a count linking to the
 * crew page, never rows of their own on the trip's practicalities. */
describe("practicals page — group vs followers (#315)", () => {
  function renderCrew(crew: Trip["crew"]): string {
    const trip = { ...tripWith({}), crew } as unknown as Trip;
    return renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ["/t/t-231/practical"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/t/:tripId/practical",
            element: createElement(TripProvider, {
              trip,
              apply: () => {},
              children: createElement(PracticalsPage),
            }),
          }),
        ),
      ),
    );
  }

  it("renders the crew as people and the followers as a count that links out", () => {
    const html = renderCrew([
      { id: "u1", name: "Niko Owner", role: "owner", claimed: true },
      { id: "u2", name: "Sam Follower", role: "follower", claimed: true },
    ] as Trip["crew"]);
    expect(html).toContain("Niko Owner");
    expect(html).not.toContain("Sam Follower");
    // SSR inserts comment nodes between interpolations: match the count loosely
    expect(html).toMatch(/1(?:<!-- -->)?\s*(?:<!-- -->)?follower(?:s)?/);
    expect(html).toContain('href="/t/t-231/crew#followers"');
  });

  it("a followers-only trip renders the card with the count and no member rows", () => {
    const html = renderCrew([
      { id: "u2", name: "Sam Follower", role: "follower", claimed: true },
      { id: "u3", name: "Kim Watcher", role: "follower", claimed: true },
    ] as Trip["crew"]);
    expect(html).toContain("Group");
    expect(html).toMatch(/2(?:<!-- -->)?\s*(?:<!-- -->)?followers/);
    expect(html).not.toContain("Sam Follower");
  });
});
