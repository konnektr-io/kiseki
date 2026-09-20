// @vitest-environment jsdom
/**
 * Glyph shape parity (#357 slice 3B): the map sprites must BE BlockGlyph's
 * shapes (lucide Plane/Train/Ship/Car), not lookalikes. Renders the four
 * components and pins their icon nodes equal to LEG_GLYPH_NODES, so a
 * lucide upgrade that redraws an icon fails here instead of silently
 * forking the map glyphs from the card glyphs.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Car, Plane, Ship, Train } from "lucide-react";
import { LEG_GLYPH_NODES, type GlyphNode } from "./leg-glyphs";
import type { TransportMode } from "./transport";

function renderedNodes(el: React.ReactElement): GlyphNode[] {
  const html = renderToStaticMarkup(el);
  const doc = new DOMParser().parseFromString(html, "image/svg+xml");
  const out: GlyphNode[] = [];
  for (const child of Array.from(doc.documentElement.childNodes)) {
    if (child.nodeType !== 1) continue;
    const e = child as Element;
    if (e.tagName !== "path" && e.tagName !== "circle" && e.tagName !== "rect") continue;
    const attrs: Record<string, string> = {};
    for (const name of e.getAttributeNames()) {
      if (name === "key") continue;
      attrs[name] = e.getAttribute(name) ?? "";
    }
    out.push({ tag: e.tagName as GlyphNode["tag"], attrs });
  }
  return out;
}

describe("glyph shape parity with BlockGlyph", () => {
  const cases: Array<[TransportMode, React.ReactElement]> = [
    ["drive", createElement(Car)],
    ["train", createElement(Train)],
    ["flight", createElement(Plane)],
    ["ferry", createElement(Ship)],
  ];
  for (const [mode, el] of cases) {
    it(`${mode} matches the lucide component BlockGlyph renders`, () => {
      expect(renderedNodes(el)).toEqual(LEG_GLYPH_NODES[mode]);
    });
  }
});
