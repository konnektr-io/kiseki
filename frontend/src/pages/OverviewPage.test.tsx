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
