import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** Mutable so a test can pin a single-review payload (the plural edge). Read
 *  lazily inside the mocked hook — the factory runs before this is assigned. */
const liveState: { current: typeof live | null } = { current: live };

vi.mock("../lib/place-live", () => ({
  placePhotoUrl: (ref: string) => `/api/places/photo?ref=${encodeURIComponent(ref)}`,
  usePlaceLive: () => liveState.current,
}));

import { PlaceFacts, placeHasFacts } from "./PlaceFacts";
import type { TripLocation } from "../lib/types";

function renderFacts(place: TripLocation, extra: Record<string, unknown> = {}): string {
  return renderToString(createElement(PlaceFacts, { place, ...extra } as never));
}

const base: TripLocation = { name: "Rusutsu", lat: 42.75, lng: 140.86, placeId: "ChIJLIVE" };

beforeEach(() => {
  liveState.current = live;
});

afterEach(() => {
  liveState.current = live;
});

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

  it("renders the first snippet clamped inline, the rest behind 'Show more'", () => {
    const html = renderFacts(base);
    // First review: visible, but clamped to two lines (long reviews can't
    // take over the card).
    expect(html).toContain("Best powder in Hokkaido.");
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("Snow Fan");
    expect(html).toContain("a month ago");
    expect(html).toContain('href="https://maps.google.com/?cid=42&amp;review=1"');
    // Reviews 2–3 are collapsed inside the details expander (native
    // <details> — no JS, closed by default). SSR interleaves text-node
    // comments — assert parts.
    expect(html).toContain("more review");
    expect(html).toContain("<details");
    expect(html).toContain("Second.");
    expect(html).toContain("Third.");
    expect(html).not.toContain("Fourth"); // capped at 3 (belt-and-suspenders with the proxy cap)
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

/* #286/#289: on a DONE block the live Google overlay is a *choosing* aid, not a
 * record — the caller (`blocks.tsx`, `reviewsQuiet={b.status === "done"}`)
 * collapses the snippets into one line (#286) and drops the star icons and the
 * Google photo entirely (#289), keeping the rating as quiet text with its route
 * out to Google. The last case is the negative control for the first two: a
 * planning render MUST still show stars, the inline snippet and the live photo,
 * or the quiet assertions would prove nothing. */
describe("PlaceFacts — live overlay on a DONE block (#286/#289)", () => {
  it("collapses every snippet behind one line, keeping the route out", () => {
    const html = renderFacts(base, { reviewsQuiet: true });
    const disclosure = html.indexOf("<details");
    expect(disclosure).toBeGreaterThan(-1);
    // Nothing above the disclosure: the inline clamped snippet is gone, so the
    // card loses its tallest planning-time row.
    expect(html.slice(0, disclosure)).not.toContain("Best powder in Hokkaido");
    expect(html).not.toContain("line-clamp-2");
    expect(html).toContain("Show 3 reviews from Google");
    // Still reachable behind the disclosure (capped at 3, same as before)…
    expect(html.slice(disclosure)).toContain("Second.");
    expect(html).toContain("Third.");
    expect(html).not.toContain("Fourth");
    // …and the rating row keeps the "N reviews on Google" link.
    expect(html).toContain("reviews on Google");
    expect(html).toContain("1,092");
  });

  it("renders no star icons and no Google photo — the rating is quiet text", () => {
    const html = renderFacts(base, { reviewsQuiet: true });
    // No star row: the accessible rating label is the stars' fingerprint.
    expect(html).not.toContain("Rated 4.4 out of 5");
    // No Google photo served through the keyless proxy…
    expect(html).not.toContain("/api/places/photo?ref=");
    // …while the rating value and its route out survive as one text line.
    expect(html).toContain(">4.4<");
    expect(html).toContain('href="https://maps.google.com/?cid=42"');
    expect(html).toContain("reviews on Google");
  });

  it("labels a single-review set in the singular", () => {
    liveState.current = { ...live, reviews: [live.reviews[0]] };
    const html = renderFacts(base, { reviewsQuiet: true });
    expect(html).toContain("Show 1 review from Google");
    expect(html).not.toContain("Show 1 reviews");
  });

  it("leaves a planning block unchanged (stars, inline snippet, photo)", () => {
    const html = renderFacts(base);
    expect(html.slice(0, html.indexOf("<details"))).toContain("Best powder in Hokkaido");
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("more review");
    expect(html).not.toContain("Show 3 reviews from Google");
    expect(html).toContain("Rated 4.4 out of 5");
    expect(html).toContain("/api/places/photo?ref=");
  });
});
