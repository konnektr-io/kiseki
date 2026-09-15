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
    expect(html).toContain("Every trip, from first idea to printed book.");
    expect(html).toContain("A trip moves through three stages.");
    expect(html).toContain("Something you can hold.");
    expect(html).toContain("Private until you say otherwise.");
    expect(html).toContain("Start with the trip you are already planning.");
  });

  it("contains no trip data — the repo is public and the prerender has no graph", () => {
    const html = renderLandingHtml();
    expect(html).not.toContain('href="/t/');
    expect(html).not.toContain("/media/");
    expect(html).not.toContain("api/showcase");
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
