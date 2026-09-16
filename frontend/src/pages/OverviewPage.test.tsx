import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
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

import { OverviewPage } from "./OverviewPage";
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
