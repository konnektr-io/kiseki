import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/* Issue #358 — an Instagram reel/post URL in ANY block's `links` plays inline
 * as a click-to-play facade (no iframe, no third-party request before play),
 * while non-Instagram links keep their pills. SSR render: the facade's first
 * paint is what the booklet prints, so the play affordance + the watch link
 * are asserted here; the /embed iframe only mounts after a click (client).
 */
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

// ActivityBlock pulls the MapLibre chain via CardMedia — irrelevant here.
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

const liveState: { current: unknown } = { current: null };
vi.mock("../lib/place-live", () => ({
  placePhotoUrl: (ref: string) => `/api/places/photo?ref=${encodeURIComponent(ref)}`,
  usePlaceLive: () => liveState.current,
}));

import { DayBlocks } from "./blocks";
import { TripProvider } from "./theme";
import type { Block, Trip } from "../lib/types";

const trip = {
  id: "t1",
  slug: "test",
  title: "Test trip",
  stage: "booked",
  myRole: "owner",
  locations: [{ name: "Palcoyo", lat: -13.6, lng: -71.65 }],
  days: [],
} as unknown as Trip;

function render(blocks: Block[]): string {
  return renderToString(
    createElement(TripProvider, {
      trip,
      apply: () => {},
      children: createElement(DayBlocks, { blocks } as never),
    }),
  );
}

const REEL = "https://www.instagram.com/reel/DMp9kQxT2zA/";
const WATCH = "https://www.instagram.com/reel/DMp9kQxT2zA/";

describe("Instagram links play inline on any block (#358)", () => {
  it("activity: facade affordance, no iframe before play, other pills kept", () => {
    const html = render([
      {
        id: "b1",
        kind: "activity",
        title: "Rainbow Mountain",
        order: 0,
        links: [
          { label: "Palcoyo reel", url: REEL },
          { label: "Hut booking", url: "https://example.com/hut" },
        ],
      } as unknown as Block,
    ]);
    // Facade: play affordance + watch link, labelled by the link.
    expect(html).toContain("instagram-embed");
    expect(html).toContain('aria-label="Play Instagram reel: Palcoyo reel"');
    expect(html).toContain(WATCH);
    // Nothing third-party mounts before play.
    expect(html).not.toContain("/embed");
    // The non-Instagram link keeps its pill.
    expect(html).toContain("Hut booking");
    expect(html).toContain("https://example.com/hut");
  });

  it("note + todo blocks earn the player too (they render no link pills)", () => {
    const html = render([
      { id: "b2", kind: "note", title: "Evening", order: 0, links: [{ label: "Reel", url: REEL }] } as unknown as Block,
      {
        id: "b3",
        kind: "todo",
        title: "Before we go",
        order: 1,
        items: [{ label: "Permits", done: false }],
        links: [{ label: "Permit how-to", url: REEL }],
      } as unknown as Block,
    ]);
    const facadeRe = /instagram-embed/g;
    expect(html.match(facadeRe)).toHaveLength(2);
    expect(html).not.toContain("/embed");
  });

  it("link block with only a reel renders the player and no empty list", () => {
    const html = render([
      { id: "b4", kind: "link", order: 0, links: [{ label: "Reel", url: REEL }] } as unknown as Block,
    ]);
    expect(html).toContain("instagram-embed");
    expect(html).not.toContain("<ul");
  });

  it("a block without Instagram renders exactly as before", () => {
    const html = render([
      {
        id: "b5",
        kind: "activity",
        title: "Rest day",
        order: 0,
        links: [{ label: "Hut booking", url: "https://example.com/hut" }],
      } as unknown as Block,
    ]);
    expect(html).not.toContain("instagram-embed");
    expect(html).toContain("Hut booking");
  });

  it("an Instagram profile URL is not a player — it keeps its pill", () => {
    const html = render([
      {
        id: "b6",
        kind: "activity",
        title: "Guide",
        order: 0,
        links: [{ label: "Our guide", url: "https://www.instagram.com/some.guide/" }],
      } as unknown as Block,
    ]);
    expect(html).not.toContain("instagram-embed");
    expect(html).toContain("Our guide");
  });
});
