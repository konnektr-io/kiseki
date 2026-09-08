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

// The lodging card embeds `TripMap` (MapLibre) and located cards embed a
// `MapView` minimap — that import chain pulls maplibre-gl +
// maplibre-contour, which don't resolve under node-env vitest. The map
// thumbnails are irrelevant to the letter/card wiring under test.
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

import { DayBlocks, resolveBlockPlace } from "./blocks";
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

/* Registry placeId wins on block Maps links + PlaceFacts render on day-view
 * cards (#place-facts): a block whose `location` (or title, via the #104
 * matcher) resolves to a registry place deep-links with that place's
 * place_id and carries the place facts above its own prose — and since the
 * card-polish pass the links-row Maps pill is SUPPRESSED when the block
 * resolves (PlaceFacts owns the canonical deep link), so exactly ONE
 * "Open in Google Maps" anchor renders per card. Unresolved blocks keep
 * their own mapsQuery/googlePlaceId fallback pill.
 *
 * Pitfall 16: DayBlocks routes editors through EditableBlockList and viewers
 * through the plain list — both must render the same links + facts. */
const tripWithPlaces = {
  id: "t1",
  slug: "test",
  title: "Test trip",
  stage: "booked",
  myRole: "owner",
  locations: [
    {
      name: "Banff",
      lat: 51.18,
      lng: -115.57,
      placeId: "REGISTRY-PLACE-ID",
      address: "123 Mountain Ave, Banff AB",
      summary: "Home of the **powder**.",
    },
    { name: "Lake Louise", lat: 51.43, lng: -116.18, placeId: "LOUISE-PLACE-ID" },
  ],
  days: [],
} as unknown as Trip;

function renderWithPlaces(blocks: Block[], extra: Record<string, unknown> = {}): string {
  const children = createElement(DayBlocks, { blocks, ...extra } as never);
  return renderToString(
    createElement(TripProvider, {
      trip: tripWithPlaces,
      apply: () => {},
      children,
    }),
  );
}

describe("block Maps links resolve the registry place", () => {
  const located: Block = {
    id: "b10",
    kind: "activity",
    title: "Ski day",
    location: "Banff",
    order: 0,
  } as unknown as Block;

  it.each([true, false])(
    "uses the registry place_id + renders facts, with exactly ONE Maps anchor (editable: %s)",
    (editable) => {
      const html = renderWithPlaces(
        [located],
        editable ? { editable: true, containerId: "day-1" } : {},
      );
      // The links-row Maps pill is suppressed once the block resolves —
      // PlaceFacts owns the canonical place_id deep link …
      expect(html).not.toContain(">Google Maps<");
      expect(html.match(/Open in Google Maps/g) ?? []).toHaveLength(1);
      expect(html).toContain("query_place_id");
      expect(html).toContain("REGISTRY-PLACE-ID");
      // … and the place facts render above the block's own prose.
      expect(html).toContain("123 Mountain Ave, Banff AB");
      expect(html).toContain("<strong>powder</strong>");
    },
  );

  it("renders PlaceFacts above the block description (registry content first)", () => {
    const html = renderWithPlaces([
      {
        id: "b10n",
        kind: "activity",
        title: "Ski day",
        location: "Banff",
        description: "My own **note** on the day.",
        order: 0,
      } as unknown as Block,
    ]);
    expect(html).toContain("Open in Google Maps");
    expect(html).toContain("<strong>note</strong>");
    expect(html.indexOf("Open in Google Maps")).toBeLessThan(html.indexOf("<strong>note</strong>"));
  });

  it("keeps the query-only fallback when nothing resolves", () => {
    const html = renderWithPlaces([
      { id: "b11", kind: "activity", title: "Rest afternoon", order: 0 } as unknown as Block,
    ]);
    expect(html).toContain("Google Maps");
    expect(html).not.toContain("query_place_id");
    expect(html).not.toContain("Open in Google Maps");
    expect(html).not.toContain("123 Mountain Ave");
  });

  it("resolves the place through the block title (#104 matcher)", () => {
    const html = renderWithPlaces([
      { id: "b12", kind: "meal", title: "Dinner in Banff", order: 0 } as unknown as Block,
    ]);
    expect(resolveBlockPlace(tripWithPlaces, {
      id: "b12",
      kind: "meal",
      title: "Dinner in Banff",
    } as Block)?.name).toBe("Banff");
    expect(html).toContain("REGISTRY-PLACE-ID");
    expect(html).toContain("123 Mountain Ave, Banff AB");
  });

  it("suppresses the links-row Maps pill when the block resolves, even with its own googlePlaceId", () => {
    const html = renderWithPlaces([
      {
        id: "b13",
        kind: "activity",
        title: "Ski day",
        location: "Banff",
        googlePlaceId: "OWN-PLACE-ID",
        order: 0,
      } as unknown as Block,
    ]);
    // The resolved registry place owns the card's Maps anchor — the block's
    // own pinned venue id no longer gets a second pill …
    expect(html).not.toContain("OWN-PLACE-ID");
    expect(html).not.toContain(">Google Maps<");
    // … while the resolved registry place's own facts button keeps the
    // registry id (it links the place, not the block's venue).
    expect(html.match(/Open in Google Maps/g) ?? []).toHaveLength(1);
    expect(html).toContain("query_place_id=REGISTRY-PLACE-ID");
    expect(html).toContain("123 Mountain Ave, Banff AB");
  });

  it("keeps the block's own googlePlaceId fallback when nothing resolves", () => {
    const html = renderWithPlaces([
      {
        id: "b13b",
        kind: "activity",
        title: "Ski day",
        location: "Nowhereville",
        googlePlaceId: "OWN-PLACE-ID",
        order: 0,
      } as unknown as Block,
    ]);
    // No registry match — the links-row pill stays, deep-linking the pinned venue …
    expect(html).toContain(">Google Maps<");
    expect(html).toContain("query_place_id=OWN-PLACE-ID");
    // … and no PlaceFacts button renders (nothing resolved).
    expect(html).not.toContain("Open in Google Maps");
  });

  it("passes place ids on the drive-card directions link when both ends resolve", () => {
    const html = renderWithPlaces([
      {
        id: "b14",
        kind: "transport",
        title: "Drive to the lake",
        from: "Banff",
        to: "Lake Louise",
        order: 0,
      } as unknown as Block,
    ]);
    expect(html).toContain("origin_place_id");
    expect(html).toContain("REGISTRY-PLACE-ID");
    expect(html).toContain("destination_place_id");
    expect(html).toContain("LOUISE-PLACE-ID");
    // The human-readable queries stay alongside the ids.
    expect(html).toContain("Banff");
    expect(html).toContain("Lake Louise");
  });

  it("renders from → to in the title row with a single Directions CTA (card polish)", () => {
    const html = renderWithPlaces([
      {
        id: "b16",
        kind: "transport",
        title: "Drive to the lake",
        from: "Banff",
        to: "Lake Louise",
        duration: "1 h 35",
        order: 0,
      } as unknown as Block,
    ]);
    // Endpoints moved into the title row (pills + names with the → separator) …
    expect(html).toContain("Banff");
    expect(html).toContain("Lake Louise");
    expect(html).toContain("→");
    // … and the directions link is a single-label CTA (no trailing-tag game).
    expect(html).toContain(">Directions<");
    expect(html).not.toContain(">directions<");
    // SSR/print render shows the static values — live HERE time only ever
    // swaps in on the client (effects never run here or in the booklet PDF).
    expect(html).toContain("1 h 35");
    expect(html).not.toContain(">live<");
  });

  it("sends only the resolving end's place id on directions (mixed)", () => {
    const html = renderWithPlaces([
      {
        id: "b15",
        kind: "transport",
        title: "Drive in from nowhere",
        from: "Banff",
        to: "Nowhereville",
        order: 0,
      } as unknown as Block,
    ]);
    expect(html).toContain("origin_place_id");
    expect(html).toContain("REGISTRY-PLACE-ID");
    expect(html).not.toContain("destination_place_id");
    expect(html).toContain("travelmode");
  });
});
