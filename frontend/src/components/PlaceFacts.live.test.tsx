import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/* Live Google overlay branch of PlaceFacts (#95) — rating stars, review-count
 * link, review snippets, live photo. The hook is mocked (SSR never runs
 * effects, so the real fetch-on-mount hook can't light up in renderToString);
 * the mock feeds the exact payload shape app/places.py serves. The static-
 * facts branches are pinned in PlaceFacts.test.tsx. */

const live = {
  available: true,
  placeId: "ChIJLIVE",
  rating: 4.4,
  userRatingCount: 1092,
  googleMapsUri: "https://maps.google.com/?cid=42",
  reviews: [
    {
      text: "Best powder in Hokkaido.",
      authorName: "Snow Fan",
      authorUri: "https://www.google.com/maps/contrib/1",
      googleMapsUri: "https://maps.google.com/?cid=42&review=1",
      relativePublishTimeDescription: "a month ago",
    },
    { text: "Second.", authorName: "B", authorUri: "https://x/2" },
    { text: "Third.", authorName: "C", authorUri: "https://x/3" },
    { text: "Fourth — never rendered.", authorName: "D", authorUri: "https://x/4" },
  ],
  photos: [
    {
      name: "places/ChIJLIVE/photos/abc",
      widthPx: 2000,
      heightPx: 1500,
      authorAttributions: [{ displayName: "Snow Fan" }],
    },
  ],
};

vi.mock("../lib/place-live", () => ({
  placePhotoUrl: (ref: string) => `/api/places/photo?ref=${encodeURIComponent(ref)}`,
  usePlaceLive: () => live,
}));

import { PlaceFacts, placeHasFacts } from "./PlaceFacts";
import type { TripLocation } from "../lib/types";

function renderFacts(place: TripLocation): string {
  return renderToString(createElement(PlaceFacts, { place }));
}

const base: TripLocation = { name: "Rusutsu", lat: 42.75, lng: 140.86, placeId: "ChIJLIVE" };

describe("PlaceFacts live Google overlay (#95)", () => {
  it("renders stars, rating value, and the review-count attribution link", () => {
    const html = renderFacts(base);
    expect(html).toContain("Rated 4.4 out of 5");
    expect(html).toContain(">4.4<");
    // SSR interleaves <!-- --> comments around text nodes — assert parts.
    expect(html).toContain("reviews on Google");
    expect(html).toContain("1,092");
    expect(html).toContain('href="https://maps.google.com/?cid=42"');
  });

  it("renders up to 3 review snippets with author attribution links", () => {
    const html = renderFacts(base);
    expect(html).toContain("Best powder in Hokkaido.");
    expect(html).toContain("Snow Fan");
    expect(html).toContain("a month ago");
    expect(html).toContain('href="https://maps.google.com/?cid=42&amp;review=1"');
    expect(html).toContain("Third.");
    expect(html).not.toContain("Fourth"); // capped at 3 (the proxy also caps)
  });

  it("serves the live photo through the keyless proxy with Google attribution", () => {
    const html = renderFacts(base);
    expect(html).toContain("/api/places/photo?ref=");
    expect(html).toContain("Photo: Snow Fan");
    expect(html).toContain("via");
    expect(html).toContain("Google Maps");
  });

  it("lights up a place with NO static facts (placeId only)", () => {
    expect(placeHasFacts({ name: "X", placeId: "ChIJLIVE" })).toBe(true);
    const html = renderFacts({ name: "X", placeId: "ChIJLIVE" });
    expect(html).toContain("reviews on Google");
    expect(html).toContain("1,092");
  });

  it("suppresses the live photo when a stored rights-clean photo exists", () => {
    const html = renderFacts({ ...base, photo: "/media/t1/rusutsu.jpg" });
    expect(html).toContain('src="/media/t1/rusutsu.jpg"');
    expect(html).not.toContain("/api/places/photo");
  });

  it("keeps the whole overlay web-only (no-print region)", () => {
    const html = renderFacts(base);
    expect(html).toContain("no-print");
  });
});
