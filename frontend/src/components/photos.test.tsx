import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TripMedia, TripPhoto, TripVideo } from "./photos";

/* The photo atom's geometry contract (#284).
 *
 * `className` lands on the wrapper (`figure`) and the image fills that cell, so
 * a caller that sizes the cell — a definite height (`h-40`), or its own ratio
 * (`aspect-[16/9]`) — must pass `fill`. Without it the image keeps its own
 * `aspect-[4/3]` body INSIDE the other box: a blank band when the cell is taller
 * than that body (the mobile feature pair in the report — 46.5px of white under
 * every photo) or a silently clipped photo when the cell is shorter (the desktop
 * pair, the card thumbnails, the 16:9 day thumbnail from the same #250 change).
 *
 * tsc/vitest cannot see CSS geometry, so what is pinned here is the class
 * contract that decides it; the band itself was measured in a real browser.
 */
describe("TripPhoto / TripMedia cell contract (#284)", () => {
  const photo = (props: Record<string, unknown>) =>
    renderToString(createElement(TripPhoto, { src: "/media/t1/a.jpg", alt: "a", ...props }));
  const media = (src: string, props: Record<string, unknown> = {}) =>
    renderToString(createElement(TripMedia, { src, alt: "a", ...props }));

  it("sizes the image itself when the caller gives the cell no size", () => {
    const html = photo({});
    expect(html).toMatch(/<img[^>]*class="aspect-\[4\/3\] w-full object-cover"/);
  });

  it("fills a caller-sized cell instead of self-sizing inside it", () => {
    const html = photo({ className: "h-40 w-full", fill: true });
    expect(html).toContain("h-40");
    expect(html).toMatch(/<img[^>]*class="h-full w-full object-cover"/);
    expect(html).not.toMatch(/<img[^>]*aspect-\[4\/3\]/);
  });

  it("fills a caller-sized cell for a video too", () => {
    const html = media("/media/t1/clip.mp4", { className: "aspect-[16/9] w-full", fill: true });
    expect(html).toMatch(/<video[^>]*class="[^"]*h-full[^"]*"/);
    expect(html).not.toMatch(/<video[^>]*aspect-\[4\/3\]/);
  });

  it("keeps the 4:3 box for a video when the caller sizes nothing", () => {
    const html = renderToString(
      createElement(TripVideo, { src: "/media/t1/clip.mp4", alt: "a" }),
    );
    expect(html).toMatch(/<video[^>]*class="[^"]*aspect-\[4\/3\]/);
  });

  it("routes a video to the player and a photo to the image, fill and all", () => {
    expect(media("/media/t1/clip.mp4", { fill: true })).toContain("<video");
    expect(media("/media/t1/a.jpg", { fill: true })).toContain("<img");
  });
});
