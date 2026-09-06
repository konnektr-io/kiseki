import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/* The prod bug this pins (#104): DayBlocks routes signed-in editors to
 * EditableBlockList, which used to DROP `letters` and `cardProps` — so on the
 * map surface, an editor's cards had no letter badge and no tap↔card wiring
 * while the same surface worked fine signed-out. The anonymous render path
 * was the only one the old smokes exercised, which is how the bug shipped.
 *
 * We render the REAL component tree (DayBlocks → EditableBlockList →
 * BlockView) with renderToString — no DOM needed to assert the contract — and
 * mock the Auth0 hook so useTripWrite's context requirement is satisfied.
 * Writes never fire in a server render. */
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

// The lodging card embeds `TripMap` (MapLibre) — that import chain pulls
// maplibre-gl + maplibre-contour, which don't resolve under node-env vitest.
// The map thumbnail is irrelevant to the letter/card wiring under test.
vi.mock("./MapView", () => ({ TripMap: () => null }));

import { DayBlocks } from "./blocks";
import { TripProvider } from "./theme";
import type { Block, Trip } from "../lib/types";

const trip = {
  id: "t1",
  slug: "test",
  title: "Test trip",
  stage: "booked",
  myRole: "owner",
  locations: [{ name: "Banff", lat: 51.18, lng: -115.57 }],
  days: [],
} as unknown as Trip;

const lodging: Block = {
  id: "b2",
  kind: "lodging",
  title: "Stay: Banff (2nd night)",
  order: 0,
} as unknown as Block;

function renderDayBlocks(props: Record<string, unknown>): string {
  const children = createElement(DayBlocks, props as never);
  return renderToString(
    createElement(TripProvider, {
      trip,
      apply: () => {},
      children,
    }),
  );
}

describe("DayBlocks editor mode keeps the map-surface card wiring (#104)", () => {
  it("stamps the letter badge and card props on an EDITOR's cards too", () => {
    const html = renderDayBlocks({
      blocks: [lodging],
      editable: true,
      containerId: "day-1",
      letters: new Map([["b2", "A"]]),
      cardProps: (b: Block) => ({
        "data-block-id": b.id,
        "data-active-block": "true",
      }),
    });
    // The letter badge renders (previously: editor cards had NO badge at all).
    expect(html).toContain("route-chip-badge");
    expect(html).toContain(">A<");
    // The tap↔card hooks survive (scroll target + active-card pulse attr).
    expect(html).toContain('data-block-id="b2"');
    expect(html).toContain('data-active-block="true"');
  });

  it("still renders plain cards when no letters are passed (booklet/today)", () => {
    const html = renderDayBlocks({
      blocks: [lodging],
      editable: true,
      containerId: "day-1",
    });
    expect(html).not.toContain("route-chip-badge");
    expect(html).not.toContain('data-block-id="b2"');
  });
});
