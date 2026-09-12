// @vitest-environment jsdom
/* The #218 regression, pinned against a REAL selector engine.
 *
 * The repo's other scroll helpers are tested with hand-rolled fake elements
 * under node-env vitest (`TripMapSurface.test.tsx`), and that style CANNOT catch
 * this class of defect: the fakes stub `querySelector`, so whatever selector the
 * code passes "works". The bug was pure CSS-selector semantics —
 * `querySelector("s-2")` is a TAG selector and matches nothing, while
 * `querySelector("#s-2")` is the id selector. jsdom gives us the real engine, so
 * dropping the `#` again fails here instead of in the browser. */
import { describe, expect, it } from "vitest";
import { sectionAnchorElement } from "./sections";

/** A stand-in for ItineraryList's root: `<div>` wrapping `<section id="s-N">`. */
function list(chapterCount: number): HTMLElement {
  const root = document.createElement("div");
  for (let i = 0; i < chapterCount; i++) {
    const section = document.createElement("section");
    section.id = `s-${i}`;
    section.textContent = `Chapter ${i}`;
    root.appendChild(section);
  }
  return root;
}

describe("sectionAnchorElement", () => {
  it("resolves a '#s-<n>' chapter anchor to its section", () => {
    const root = list(5);
    expect(sectionAnchorElement(root, "#s-2")?.id).toBe("s-2");
    expect(sectionAnchorElement(root, "#s-0")?.id).toBe("s-0");
    expect(sectionAnchorElement(root, "#s-4")?.id).toBe("s-4");
  });

  it("treats the hash as an ID selector, not a tag selector (#218)", () => {
    // The defect in one line — the bare id matches nothing in a real engine.
    const root = list(5);
    expect(root.querySelector("s-2")).toBeNull();
    expect(sectionAnchorElement(root, "#s-2")).not.toBeNull();
  });

  it("returns null for a chapter that is not rendered (stale link)", () => {
    // "Hash present but no such chapter" must fall through to the next
    // arrival rule, not scroll nowhere and not throw.
    expect(sectionAnchorElement(list(3), "#s-9")).toBeNull();
  });

  it("returns null for anything that is not a chapter hash", () => {
    const root = list(5);
    for (const hash of ["", "#", "#top", "#s-", "#s", "#s-x", "#s-2x", "s-2", "#s-2#s-3"]) {
      expect(sectionAnchorElement(root, hash), `hash ${JSON.stringify(hash)}`).toBeNull();
    }
  });

  it("stays scoped to the list it was handed", () => {
    const elsewhere = document.createElement("section");
    elsewhere.id = "s-2";
    document.body.appendChild(elsewhere);
    try {
      // The document HAS an #s-2 — but not inside the list under test, so the
      // list resolves nothing (and the caller falls through to saved/today).
      expect(sectionAnchorElement(list(2), "#s-2")).toBeNull();
      expect(sectionAnchorElement(document.body, "#s-2")).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it("returns null when the list is not mounted", () => {
    expect(sectionAnchorElement(null, "#s-2")).toBeNull();
  });
});
