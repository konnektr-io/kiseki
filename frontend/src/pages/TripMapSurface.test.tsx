import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/* PlacePanel renders the v0.23.12 Location metadata (placeId / address /
 * website / types / summary) between the day list and the back button.
 *
 * Render the REAL PlacePanel through SSR with a minimal TripProvider — no
 * DOM, no router needed (the panel itself takes plain props). The module
 * pulls the map chain (RouteMap → maplibre-gl, blocks → MapView), which
 * doesn't resolve under node-env vitest, so both are stubbed — the panel
 * under test touches neither.
 *
 * Pitfall 16 (editor-mode blind spot): the panel tree is auth-agnostic (no
 * role branching), pinned here by rendering one case as editor and one as
 * viewer with the same expectations on the shared content. */
vi.mock("../components/RouteMap", () => ({ RouteMap: () => null }));
vi.mock("../components/MapView", () => ({ MapView: () => null, TripMap: () => null }));

import { PlacePanel } from "./TripMapSurface";
import { TripProvider } from "../components/theme";
import type { Trip, TripLocation } from "../lib/types";

function tripWith(place: TripLocation, myRole = "viewer"): Trip {
  return {
    id: "t1",
    slug: "test",
    title: "Test trip",
    stage: "planned",
    visibility: "private",
    myRole,
    crew: [],
    practical: {},
    locations: [place],
    days: [{ id: "d0", date: "2027-03-01", title: "Arrival", blocks: [] }],
  } as unknown as Trip;
}

function renderPanel(trip: Trip): string {
  const place = trip.locations![0];
  const children = createElement(PlacePanel, {
    place,
    days: [0],
    onClear: () => {},
    onOpenDay: () => {},
  });
  return renderToString(
    createElement(TripProvider, { trip, apply: () => {}, children }),
  );
}

const fullPlace: TripLocation = {
  name: "Banff",
  lat: 51.18,
  lng: -115.57,
  placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
  address: "123 Mountain Ave, Banff AB",
  website: "https://banff.example.com",
  types: ["ski_area", "park"],
  summary: "Home of the **powder**.",
};

describe("PlacePanel location metadata", () => {
  it("renders link + address + website + types + summary when all fields are present", () => {
    const html = renderPanel(tripWith(fullPlace, "editor"));
    // Google Maps link uses the place_id deep-link form …
    expect(html).toContain("Open in Google Maps");
    expect(html).toContain("query_place_id=");
    expect(html).toContain("ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(html).toContain('target="_blank"');
    // … then the facts …
    expect(html).toContain("123 Mountain Ave, Banff AB");
    expect(html).toContain('href="https://banff.example.com"');
    expect(html).toContain("ski_area");
    expect(html).toContain("park");
    // … then the agent-authored summary, rendered as markdown.
    expect(html).toContain("<strong>powder</strong>");
    // Existing chrome survives: marker pill, day list, back button.
    expect(html).toContain("Back to the route");
    expect(html).toContain("Day 1");
  });

  it("still renders a name-only Maps link with no metadata at all (pre-v0.23.12 trips)", () => {
    const html = renderPanel(tripWith({ name: "Banff", lat: 51.18, lng: -115.57 }, "viewer"));
    expect(html).toContain("Open in Google Maps");
    expect(html).toContain("query=Banff");
    expect(html).not.toContain("query_place_id=");
    // Absence IS the empty state — no placeholder rows. The single https://
    // in the tree is the name-only Maps link itself (no website row).
    expect(html).not.toContain("Place types");
    expect(html.match(/https:\/\//g)).toHaveLength(1);
    expect(html).toContain("Back to the route");
  });

  it("renders only the summary when that is the sole field set", () => {
    const html = renderPanel(
      tripWith({ name: "Banff", lat: 51.18, lng: -115.57, summary: "A quiet *valley* town." }),
    );
    expect(html).toContain("Open in Google Maps");
    expect(html).toContain("query=Banff");
    expect(html).toContain("<em>valley</em>");
    expect(html).not.toContain("Place types");
    expect(html).toContain("Back to the route");
  });
});
