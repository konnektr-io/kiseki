import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/* Folded (multi-day) cards navigate like every other scan row.
 *
 * The fold card used to render a plain <div>: the combined card went nowhere
 * and neither did its days, so a folded stretch of the itinerary was a dead
 * end on the scan level (Niko's review). The contract now: the card body
 * links to the FIRST folded day (same scan → day deal as DaySummaryRow) and
 * a per-day nav below it links each folded day to its own day page — as
 * sibling anchors, never nested (nested <a> is invalid HTML and React
 * routers resolve the outer href on click).
 *
 * SSR pins the hrefs; the browser harness owns the tap geometry.
 */
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import { FoldedDayCard } from "./DaySummaryRow";
import type { Day } from "../lib/types";

function day(id: string, date: string, title: string): Day {
  return {
    id,
    date,
    title,
    blocks: [{ kind: "activity", title: `Ski ${title}`, location: "Revelstoke" }],
  } as unknown as Day;
}

const DAYS = [day("d7", "2027-02-20", "First turns"), day("d8", "2027-02-21", "Whiteout"), day("d9", "2027-02-22", "Last lift")];

function renderFold(activeDayIdx?: number | null): string {
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: ["/t/t1/itinerary"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/t/:tripId/itinerary",
          element: createElement(FoldedDayCard, {
            days: DAYS,
            indices: [6, 7, 8],
            title: "Heli days",
            startNo: 7,
            activeDayIdx,
          }),
        }),
      ),
    ),
  );
}

describe("FoldedDayCard navigation", () => {
  it("links the card body to the first folded day", () => {
    const html = renderFold();
    expect(html).toContain('aria-label="Days 7–9: Heli days — open day 7"');
    expect(html).toContain('href="/t/t1/day/6"');
    expect(html).toContain("Open day");
  });

  it("links each folded day to its own day page, outside the card link", () => {
    const html = renderFold();
    for (const [idx, dayNo] of [[6, 7], [7, 8], [8, 9]] as const) {
      expect(html).toContain(`href="/t/t1/day/${idx}"`);
      expect(html).toContain(`aria-label="Day ${dayNo}:`);
    }
    // Sibling anchors, never nested: every per-day link's ancestors contain
    // no other anchor (the card body link is its preceding sibling).
    const nav = html.slice(html.indexOf("<nav"));
    const anchors = [...nav.matchAll(/<a /g)].length;
    expect(anchors).toBe(3);
    expect(nav).not.toMatch(/<a [^>]*>[^<]*<a /);
  });

  it("marks the open day's pill current", () => {
    const html = renderFold(7);
    expect(html).toContain('href="/t/t1/day/7"');
    expect(html).toContain('aria-current="page"');
  });
});
