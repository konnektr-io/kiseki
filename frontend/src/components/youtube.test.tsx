import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/* Issue #283 — a YouTube URL in ANY block's `links` plays inline as a
 * click-to-play facade (no iframe, no third-party request before play),
 * while non-YouTube links keep their pills. SSR render: the facade's first
 * paint is what the booklet prints, so the thumbnail + the watch link are
 * asserted here; the nocookie iframe only mounts after a click (client).
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
  locations: [{ name: "Banff", lat: 51.18, lng: -115.57 }],
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

const YT = "https://youtu.be/3DRV-9kUbxE";
const THUMB = "https://i.ytimg.com/vi/3DRV-9kUbxE/hqdefault.jpg";

describe("YouTube links play inline on any block (#283)", () => {
  it("activity: facade thumbnail, no iframe before play, other pills kept", () => {
    const html = render([
      {
        id: "b1",
        kind: "activity",
        title: "Powder day",
        order: 0,
        links: [
          { label: "Rusutsu powder edit", url: YT },
          { label: "Hut booking", url: "https://example.com/hut" },
        ],
      } as unknown as Block,
    ]);
    // Facade: thumbnail + watch link, labelled by the link.
    expect(html).toContain(THUMB);
    expect(html).toContain('aria-label="Play video: Rusutsu powder edit"');
    // Nothing third-party mounts before play.
    expect(html).not.toContain("youtube-nocookie");
    // The non-YouTube link keeps its pill.
    expect(html).toContain("Hut booking");
    expect(html).toContain("https://example.com/hut");
  });

  it("note + todo blocks earn the player too (they render no link pills)", () => {
    const html = render([
      { id: "b2", kind: "note", title: "Evening", order: 0, links: [{ label: "Edit", url: YT }] } as unknown as Block,
      {
        id: "b3",
        kind: "todo",
        title: "Before we go",
        order: 1,
        items: [{ label: "Wax", done: false }],
        links: [{ label: "Waxing how-to", url: YT }],
      } as unknown as Block,
    ]);
    const thumbRe = new RegExp(THUMB.replace(/[./]/g, (c) => `\\${c}`), "g");
    expect(html.match(thumbRe)).toHaveLength(2);
    expect(html).not.toContain("youtube-nocookie");
  });

  it("link block with only a video renders the player and no empty list", () => {
    const html = render([
      { id: "b4", kind: "link", order: 0, links: [{ label: "Edit", url: YT }] } as unknown as Block,
    ]);
    expect(html).toContain(THUMB);
    expect(html).not.toContain("<ul");
  });

  it("a block without YouTube renders exactly as before", () => {
    const html = render([
      {
        id: "b5",
        kind: "activity",
        title: "Rest day",
        order: 0,
        links: [{ label: "Hut booking", url: "https://example.com/hut" }],
      } as unknown as Block,
    ]);
    expect(html).not.toContain("youtube-embed");
    expect(html).not.toContain("i.ytimg.com");
    expect(html).toContain("Hut booking");
  });
});
