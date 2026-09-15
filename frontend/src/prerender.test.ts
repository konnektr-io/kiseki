/**
 * The prerendered landing (E4, #249).
 *
 * `scripts/prerender.mjs` fails the build when this output is wrong, and these
 * tests pin the same contract earlier and more readably: the crawler's copy is
 * there, and nothing private or unrunnable is.
 */
import { describe, expect, it } from "vitest";

const { renderLandingHtml } = await import("./prerender");

describe("the prerendered landing", () => {
  it("carries the copy a crawler needs, with no graph and no browser", () => {
    const html = renderLandingHtml();
    expect(html).toContain("Plan it together. Live it for real.");
    expect(html).toContain("A trip moves through three stages.");
    expect(html).toContain("Something you can hold.");
    expect(html).toContain("Private until you say otherwise.");
    expect(html).toContain("Start with the trip you are already planning.");
  });

  it("contains no trip data — the repo is public and the page shows an invented example", () => {
    const html = renderLandingHtml();
    expect(html).not.toContain('href="/t/');
    expect(html).not.toContain("/media/");
    expect(html).not.toContain("api/showcase");
    // The codes that were actually readable on a live public trip before v0.41.1,
    // plus the trip ids whose media the example does NOT reference: if real content
    // ever comes back to this page, one of these will trip.
    for (const leaked of ["9GMOL3", "STHS", "b16680e7", "bf29a027"]) {
      expect(html).not.toContain(leaked);
    }
  });

  it("carries the example, since the whole body is now static", () => {
    // The page fetches nothing, so the prerender is the complete page rather than a
    // degraded no-data version of it.
    const html = renderLandingHtml();
    expect(html).toContain("One day of an example trip.");
    expect(html).toContain("/marketing/hero.jpg");
  });

  it("renders no auth control, which could not work without JavaScript", () => {
    // `AuthButton` needs the Auth0 provider; the prerender runs in Node.
    const html = renderLandingHtml();
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain("Account menu");
  });

  it("is markup only — no script, no stylesheet, no inline handlers", () => {
    const html = renderLandingHtml();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    // No inline event handlers (they could not run before hydration anyway).
    expect(html).not.toMatch(/\son[a-z]+=/);
    // React 19 hoists a `<link rel="preload">` for the header logo, so the body
    // starts with a tag rather than specifically a `<div>`.
    expect(html.startsWith("<")).toBe(true);
    expect(html).toContain("Trip documents for crews");
  });
});
