import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/* Stray-`0` on the trip overview (reported 2026-09-10 on
 * /t/b16680e7-a338-4c76-9cd7-fa13d45be594): the practical-preview gate was
 *   {(totalTodos > 0 || trip.practical.links?.length) && (<Card …>)}
 * When a trip has no todos and `links` is an EMPTY array (not undefined),
 * the left side is `false || 0` → the number `0` — and React renders the
 * number 0 as a text node (`{0 && …}` renders "0", unlike
 * `false`/`undefined`/`null` which render nothing). The live trip that
 * reported this had empty todos + an empty links array, hence the stray
 * "0" after the crew card. The fix coerces the length to a boolean.
 *
 * We render the REAL OverviewPage through SSR inside a MemoryRouter with a
 * minimal TripProvider — no DOM, no map needed. The module pulls the map
 * chain (OverviewPage → MapView → maplibre-gl + CSS), which doesn't resolve
 * under node-env vitest, so it is stubbed — the conditional under test
 * touches none of its internals (same pattern as blocks.test.tsx).
 */
vi.mock("../components/MapView", () => ({ MapView: () => null, TripMap: () => null }));

import { OverviewPage, statValueClass } from "./OverviewPage";
import { TripProvider } from "../components/theme";
import type { Trip } from "../lib/types";

function tripWith(practical: Trip["practical"]): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Urban Legends & Neon Dreams",
    stage: "idea",
    crew: [{ name: "Niko Raes", role: "owner" }],
    practical,
    days: [],
    sections: [],
    locations: [],
  } as unknown as Trip;
}

function renderOverview(practical: Trip["practical"]): string {
  return renderToString(
    createElement(TripProvider, {
      trip: tripWith(practical),
      apply: () => {},
      children: createElement(MemoryRouter, null, createElement(OverviewPage)),
    }),
  );
}

describe("OverviewPage practical preview gate (stray-0)", () => {
  it.each([{}, { todos: [], links: [] }] as Trip["practical"][])(
    "renders no stray 0 when the trip has no todos and no practical links (%#)",
    (practical) => {
      const html = renderOverview(practical);
      // The bug rendered “…</ul></div>0</div>”: a bare text node after the crew card.
      expect(html).not.toMatch(/>0<\/div>\s*$/);
      expect(html).not.toContain("</ul></div>0</div>");
      // … and no practical card either.
      expect(html).not.toContain("Practical");
    },
  );

  it("still renders the practical card when todos exist", () => {
    const html = renderOverview({ todos: [{ label: "Book flights", done: false }] });
    expect(html).toContain("Practical");
    expect(html).not.toMatch(/>0<\/div>\s*$/);
  });

  it("still renders the practical card when practical links exist", () => {
    const html = renderOverview({ links: [{ label: "JR Pass", url: "https://example.com" }] });
    expect(html).toContain("Practical");
    expect(html).not.toMatch(/>0<\/div>\s*$/);
  });
});

/* Feature media cells (#284: a blank white band under every image in the pair).
 *
 * The defect was a DIVISION OF LABOUR between the cell and the image: `#250`
 * moved the sizing classes (`h-40`, `h-24`, `max-h-64`) from the `<img>` onto
 * the `TripMedia` wrapper, while the `<img>` inside kept its own
 * `aspect-[4/3]` body. The cell then reserved 160px (mobile: the image's 4:3
 * body was only 112.5px tall → a 46.5px white band under every photo, the same
 * for every picture and every ratio, which is exactly what was reported) and on
 * desktop it did the reverse: the ratio-sized image overflowed the 160px cell
 * and `overflow-hidden` clipped 94px of the photo away.
 *
 * CSS geometry is invisible to vitest, so this pins the contract that decides
 * it: whatever sizes the cell, the image inside it must fill the cell
 * (`h-full`) and must not carry a ratio of its own.
 */
const FIGURE = /<figure class="([^"]*)"[^>]*>(.*?)<\/figure>/gs;

function assertCellsFillTheirImage(html: string): void {
  const figures = [...html.matchAll(FIGURE)];
  expect(figures.length).toBeGreaterThanOrEqual(4);
  const sized = figures.filter(([, figCls]) => /\b(h-\d+|aspect-\[)/.test(figCls));
  // the pair (2 cells) + the single image + the card = 4 caller-sized cells
  expect(sized.length).toBeGreaterThanOrEqual(4);
  for (const [, figCls, inner] of sized) {
    const img = /<img[^>]*class="([^"]*)"/.exec(inner);
    if (!img) continue; // a video cell
    expect(img[1], `cell "${figCls}" must let its image fill it`).toContain("h-full");
    expect(img[1], `cell "${figCls}" must not hand a ratio to its image`).not.toContain("aspect-");
  }
}

describe("OverviewPage feature media cells (#284)", () => {
  const FEATURES_TRIP = {
    id: "t1",
    slug: "test",
    title: "Japow 2026",
    stage: "archive",
    crew: [],
    practical: {},
    days: [],
    sections: [],
    locations: [],
    features: [
      { kicker: "centerpiece", title: "pair", images: ["/media/t1/a.jpg", "/media/t1/b.jpg"] },
      { kicker: "centerpiece", title: "single", image: "/media/t1/c.jpg" },
      {
        kicker: "cards",
        title: "cards",
        cards: [{ title: "one", value: "1", image: "/media/t1/d.jpg" }],
      },
    ],
  } as unknown as Trip;

  it("gives every sized cell an image that fills it", () => {
    const html = renderToString(
      createElement(TripProvider, {
        trip: FEATURES_TRIP,
        apply: () => {},
        children: createElement(MemoryRouter, null, createElement(OverviewPage)),
      }),
    );
    expect(html).toContain("pair");
    assertCellsFillTheirImage(html);
  });
});

/* #301 — the content-agent's riding-log cards: `links: [{ label: "Open the
 * day", url: "/t/<trip_id>/day/<idx>" }]` on a feature and on its cards, asking
 * for the trip's OWN days instead of Strava. Every one of these surfaces
 * rendered `<a target="_blank" rel="noreferrer">`, so an in-app target opened a
 * second tab; the seven cards were dropped from the feature and the ask was
 * withdrawn. Off-app links (Strava, Maps, booking pages) must keep the new tab
 * — the fix is per target, never "stop using target=_blank". */
const ANCHORS = /<a\b[^>]*>/g;

describe("OverviewPage content links follow their target (#301)", () => {
  const DAY_URL = "/t/t1/day/3";
  const DAY_LINK = { label: "Open the day", url: DAY_URL };
  const STRAVA = { label: "Strava", url: "https://www.strava.com/activities/9001" };

  function renderTrip(): string {
    const trip = {
      id: "t1",
      slug: "test",
      title: "Japow 2026",
      stage: "archive",
      crew: [],
      days: [],
      sections: [],
      locations: [],
      practical: { links: [DAY_LINK, STRAVA] },
      features: [
        {
          kicker: "centerpiece",
          title: "Riding log",
          links: [DAY_LINK],
          cards: [{ title: "Day 3", value: "12 km", links: [DAY_LINK] }],
        },
      ],
    } as unknown as Trip;
    return renderToString(
      createElement(TripProvider, {
        trip,
        apply: () => {},
        children: createElement(MemoryRouter, null, createElement(OverviewPage)),
      }),
    );
  }

  it("keeps the day card's link in the app — on the card, the feature and the practical preview", () => {
    const html = renderTrip();
    const internal = (html.match(ANCHORS) ?? []).filter((a) => a.includes(`href="${DAY_URL}"`));
    // the card's own link, the feature's link pill, the practical preview row
    expect(internal.length).toBeGreaterThanOrEqual(3);
    for (const a of internal) expect(a).not.toContain('target="_blank"');
  });

  it("still sends an off-app link to a new tab", () => {
    const html = renderTrip();
    const external = (html.match(ANCHORS) ?? []).filter((a) => a.includes(`href="${STRAVA.url}"`));
    expect(external.length).toBeGreaterThanOrEqual(1);
    for (const a of external) expect(a).toContain('target="_blank"');
  });
});

/* #315 — the trip's own surfaces show the crew as people and followers only as
 * a count: an individual follower is never listed here, they live on the crew
 * page's own section. */
describe("OverviewPage crew vs followers (#315)", () => {
  function renderCrew(crew: Trip["crew"]): string {
    const trip = {
      id: "t1",
      slug: "test",
      title: "Japow 2026",
      stage: "planned",
      crew,
      days: [],
      sections: [],
      locations: [],
      practical: {},
    } as unknown as Trip;
    return renderToString(
      createElement(TripProvider, {
        trip,
        apply: () => {},
        children: createElement(
          MemoryRouter,
          { initialEntries: ["/t/t1"] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/t/:tripId", element: createElement(OverviewPage) }),
          ),
        ),
      }),
    );
  }

  it("lists the crew as people, the followers as a count linking to the crew page", () => {
    const html = renderCrew([
      { id: "u1", name: "Niko Raes", role: "owner", claimed: true },
      { id: "u2", name: "Sam Follower", role: "follower", claimed: true },
      { id: "u3", name: "Kim Watcher", role: "follower", claimed: true },
    ] as Trip["crew"]);
    expect(html).toContain("Niko Raes");
    expect(html).not.toContain("Sam Follower");
    expect(html).not.toContain("Kim Watcher");
    // SSR inserts comment nodes between interpolations: match the count loosely
    expect(html).toMatch(/2(?:<!-- -->)?\s*(?:<!-- -->)?followers/);
    expect(html).toContain('href="/t/t1/crew#followers"');
    expect(html).toContain("See who");
  });

  it("counts a single follower in the singular", () => {
    const html = renderCrew([
      { id: "u1", name: "Niko Raes", role: "owner", claimed: true },
      { id: "u2", name: "Sam Follower", role: "follower", claimed: true },
    ] as Trip["crew"]);
    expect(html).toMatch(/1(?:<!-- -->)?\s*(?:<!-- -->)?follower(?:s)?/);
    expect(html).not.toMatch(/1(?:<!-- -->)?\s*(?:<!-- -->)?followers/);
  });

  it("a crew of members only renders no follower line at all", () => {
    const html = renderCrew([
      { id: "u1", name: "Niko Raes", role: "owner", claimed: true },
    ] as Trip["crew"]);
    expect(html).not.toContain("#followers");
    expect(html).not.toContain("follower");
  });
});

/* Overview stat strip — agent-written values sometimes arrive as sentences
 * (Georgia 2028: "BRUSSELS -> BATUMI - ONE STOP, THEN ~3H BY ROAD"), and the
 * old strip rendered every value at text-3xl/4xl, so one long value stretched
 * its cell into a huge box. The font now steps down with length and the cell
 * clamps + wraps; short numbers stay heroic. */
describe("OverviewPage stat strip (long values)", () => {
  it("keeps short numbers heroic, steps medium values down, shrinks sentences", () => {
    expect(statValueClass("16")).toContain("text-3xl");
    expect(statValueClass("2,025 m")).toContain("text-3xl");
    expect(statValueClass("5–7 h/day in the cat")).toContain("text-xl");
    expect(statValueClass("BRUSSELS -> BATUMI - ONE STOP, THEN ~3H BY ROAD")).toContain("text-sm");
    expect(statValueClass("BRUSSELS -> BATUMI - ONE STOP, THEN ~3H BY ROAD")).not.toContain("text-3xl");
  });

  it("renders every stat value clamped and wrapped", () => {
    const trip = {
      id: "t1",
      slug: "test",
      title: "Georgia 2028",
      stage: "planned",
      crew: [],
      days: [],
      sections: [],
      locations: [],
      practical: {},
      stats: [
        { label: "Journey", value: "BRUSSELS -> BATUMI - ONE STOP, THEN ~3H BY ROAD" },
        { label: "Days", value: "8" },
      ],
    } as unknown as Trip;
    const html = renderToString(
      createElement(TripProvider, {
        trip,
        apply: () => {},
        children: createElement(MemoryRouter, null, createElement(OverviewPage)),
      }),
    );
    expect(html).toContain("BRUSSELS");
    expect(html).toContain("line-clamp-3");
    expect(html).toContain("break-words");
  });
});
