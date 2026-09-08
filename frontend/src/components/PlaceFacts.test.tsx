import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

/* PlaceFacts renders the v0.23.12 Location metadata (placeId / address /
 * website / types / summary) on day-view blocks that resolve to a registry
 * place — the body the scan-level place panel used to carry, extracted
 * verbatim.
 *
 * The component takes plain props (no TripProvider, no router), so SSR is
 * enough. Web-only via the `no-print` wrapper (booklet byte-stability).
 *
 * Pitfall 16 (editor-mode blind spot): the facts tree is auth-agnostic (no
 * role branching) — there is nothing role-specific to pin, and the block
 * wiring in both editor and viewer mode is pinned in blocks.test.tsx. */

import { PlaceFacts, placeHasFacts } from "./PlaceFacts";
import type { TripLocation } from "../lib/types";

function renderFacts(place: TripLocation): string {
  return renderToString(createElement(PlaceFacts, { place }));
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

describe("PlaceFacts location metadata", () => {
  it("renders link + address + website + types + summary when all fields are present", () => {
    const html = renderFacts(fullPlace);
    // Google Maps link uses the place_id deep-link form …
    expect(html).toContain("Open in Google Maps");
    expect(html).toContain("query_place_id=");
    expect(html).toContain("ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(html).toContain('target="_blank"');
    // … the website renders as a hostname chip-button (never raw URL text) …
    expect(html).toContain('href="https://banff.example.com"');
    expect(html).toContain(">banff.example.com<");
    // … then the facts …
    expect(html).toContain("123 Mountain Ave, Banff AB");
    expect(html).toContain("ski_area");
    expect(html).toContain("park");
    // … then the agent-authored summary, rendered as markdown.
    expect(html).toContain("<strong>powder</strong>");
    // Web-only: the booklet keeps its own prose.
    expect(html).toContain("no-print");
  });

  it("falls back to the raw string when the website is not a valid URL", () => {
    const html = renderFacts({
      name: "Hut",
      lat: 51.18,
      lng: -115.57,
      website: "not a url",
    });
    expect(html).toContain('href="not a url"');
    expect(html).toContain(">not a url<");
  });

  it("renders nothing with no metadata at all (pre-v0.23.12 trips)", () => {
    const html = renderFacts({ name: "Banff", lat: 51.18, lng: -115.57 });
    // Absence IS the empty state — no placeholder rows, not even the Maps
    // link (the block's own Google Maps pill already covers the name).
    expect(html).toBe("");
    expect(placeHasFacts({ name: "Banff" })).toBe(false);
  });

  it("renders only the summary when that is the sole field set", () => {
    const html = renderFacts({
      name: "Banff",
      lat: 51.18,
      lng: -115.57,
      summary: "A quiet *valley* town.",
    });
    expect(html).toContain("Open in Google Maps");
    expect(html).toContain("query=Banff");
    expect(html).toContain("<em>valley</em>");
    expect(html).not.toContain("Place types");
  });
});
