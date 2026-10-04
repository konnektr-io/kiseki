import { describe, expect, it } from "vitest";
import {
  OUTDOOR_COLORS,
  OUTDOOR_MINZOOM,
  OUTDOOR_SOURCE_ID,
  OUTDOOR_WIDTH,
  PISTE_CLASSES,
  isLift,
  isWalkingNetwork,
  outdoorLayerSpecs,
  pisteClass,
} from "./outdoor-overlay";

/**
 * The overlay's contracts, pinned.
 *
 * The layer specs are the whole point of this module, and a wrong filter is
 * silent — it renders an empty layer or, worse, the wrong feature class — so
 * they are asserted directly rather than left to a rendered-browser read.
 */

function filterOf(id: string): unknown {
  const spec = outdoorLayerSpecs().find((l) => l.id === id);
  if (!spec || !("filter" in spec)) throw new Error(`no filter on ${id}`);
  return spec.filter;
}

type LineSpec = Extract<ReturnType<typeof outdoorLayerSpecs>[number], { type: "line" }>;

function paintOf(id: string): Record<string, unknown> {
  const spec = outdoorLayerSpecs().find((l) => l.id === id) as LineSpec | undefined;
  if (!spec?.paint) throw new Error(`no paint on ${id}`);
  return spec.paint as Record<string, unknown>;
}

describe("pisteClass", () => {
  it("maps the downhill difficulty subtypes to a class", () => {
    expect(pisteClass("downhill-easy")).toBe("easy");
    expect(pisteClass("downhill-novice")).toBe("easy");
    expect(pisteClass("snow_park")).toBe("easy");
    expect(pisteClass("downhill-intermediate")).toBe("intermediate");
    expect(pisteClass("downhill-advanced")).toBe("advanced");
    expect(pisteClass("downhill-expert")).toBe("expert");
    // expert and extreme are the same idea to a skier
    expect(pisteClass("downhill-extreme")).toBe("expert");
    expect(pisteClass("downhill-freeride")).toBe("freeride");
  });

  it("reads every nordic-* subtype as nordic, never as a downhill class", () => {
    // The trap: `nordic-easy`/`nordic-novice` end in a difficulty word that is
    // also a downhill class name. A suffix match would paint cross-country
    // trails as a downhill run of that colour.
    for (const s of ["nordic", "nordic-easy", "nordic-novice", "nordic-intermediate"]) {
      expect(pisteClass(s)).toBe("nordic");
    }
  });

  it("returns null for anything that is not a piste", () => {
    for (const s of [undefined, null, "", "path", "footway", "chair_lift", "residential"]) {
      expect(pisteClass(s)).toBeNull();
    }
  });
});

describe("isLift / isWalkingNetwork", () => {
  it("accepts every aerialway subtype Maptoolkit carries", () => {
    for (const s of ["chair_lift", "drag_lift", "t-bar", "j-bar", "platter", "gondola", "cable_car", "funicular"]) {
      expect(isLift(s)).toBe(true);
    }
  });

  it("rejects non-lifts", () => {
    for (const s of [undefined, null, "", "path", "downhill-easy", "goods"]) {
      expect(isLift(s)).toBe(false);
    }
  });

  it("accepts the four walking networks and nothing else", () => {
    for (const s of ["lwn", "rwn", "nwn", "iwn"]) expect(isWalkingNetwork(s)).toBe(true);
    for (const s of [undefined, null, "", "nwn_", "lwn ", "cycle_network"]) {
      expect(isWalkingNetwork(s)).toBe(false);
    }
  });
});

describe("outdoorLayerSpecs", () => {
  it("draws every layer from the single outdoor source's road layer", () => {
    for (const spec of outdoorLayerSpecs()) {
      // Every spec here is a line layer, but LayerSpecification is a union that
      // includes the background/fill/raster shapes, so narrow before reading.
      const line = spec as Extract<typeof spec, { type: "line" }>;
      expect(line.source).toBe(OUTDOOR_SOURCE_ID);
      expect(line["source-layer"]).toBe("road");
    }
  });

  it("puts lifts below the pistes", () => {
    const ids = outdoorLayerSpecs().map((l) => l.id);
    expect(ids.indexOf("outdoor-lifts")).toBeLessThan(ids.indexOf("outdoor-piste-easy"));
  });

  it("has one layer per piste class plus lifts and trails", () => {
    const ids = outdoorLayerSpecs().map((l) => l.id);
    expect(ids).toHaveLength(PISTE_CLASSES.length + 2);
    expect(ids).toContain("outdoor-trails");
  });

  it("keeps every layer at or above OUTDOOR_MINZOOM", () => {
    // At trip scale a national piste dataset is noise; the overlay only earns
    // its ink once someone has zoomed into a valley.
    for (const spec of outdoorLayerSpecs()) {
      expect(spec.minzoom).toBe(OUTDOOR_MINZOOM);
    }
  });

  it("matches nordic by prefix, GUARDED, so the layer cannot go silent", () => {
    // The `["has","subtype"]` conjunct is load-bearing, not defensive. MapLibre
    // evaluates a filter against every feature in the tile, and the many features
    // with NO subtype make `["slice", ["get","subtype"], …]` error; MapLibre then
    // logs "Falling back to false" and the layer renders empty. Measured: this
    // unguarded filter silenced the nordic lines AND every label layer.
    const f = filterOf("outdoor-piste-nordic") as unknown[];
    expect(f[0]).toBe("all");
    expect(f[1]).toEqual(["has", "subtype"]);
    expect(JSON.stringify(f)).toContain("nordic");
    expect(JSON.stringify(f)).toContain("slice");
  });

  it("gives each piste class exactly its own subtypes", () => {
    const own: Record<string, string[]> = {
      easy: ["downhill-easy", "downhill-novice", "snow_park"],
      intermediate: ["downhill-intermediate"],
      advanced: ["downhill-advanced"],
      expert: ["downhill-expert", "downhill-extreme"],
      freeride: ["downhill-freeride"],
    };
    for (const [cls, subtypes] of Object.entries(own)) {
      expect(filterOf(`outdoor-piste-${cls}`)).toEqual([
        "in",
        ["get", "subtype"],
        ["literal", subtypes],
      ]);
    }
  });

  it("stays thin and translucent — reference, not content", () => {
    // DESIGN.md §8.5: the trip's colour is the loudest thing on screen. A piste
    // drawn at full weight competes with the route it sits behind.
    for (const spec of outdoorLayerSpecs()) {
      const paint = paintOf(spec.id);
      expect(typeof paint["line-opacity"]).toBe("number");
      expect(paint["line-opacity"] as number).toBeLessThanOrEqual(0.7);
      // Every layer shares ONE width curve, so the widths stay thin and stay
      // consistent with each other rather than being retuned per class.
      expect(paint["line-width"]).toBe(OUTDOOR_WIDTH);
    }
  });

  it("dashes lifts and trails, keeps runs solid", () => {
    // Same dashed-lift vocabulary the recorded-track layer already uses (#290).
    expect(paintOf("outdoor-lifts")["line-dasharray"]).toBeDefined();
    expect(paintOf("outdoor-trails")["line-dasharray"]).toBeDefined();
    expect(paintOf("outdoor-piste-easy")["line-dasharray"]).toBeUndefined();
    expect(paintOf("outdoor-piste-advanced")["line-dasharray"]).toBeUndefined();
  });

  it("colours every layer from the palette, and no layer is a bare hex in paint", () => {
    const palette = new Set<string>(Object.values(OUTDOOR_COLORS));
    for (const spec of outdoorLayerSpecs()) {
      expect(palette.has(paintOf(spec.id)["line-color"] as string)).toBe(true);
    }
    // every palette entry is used, so a dead entry is visible
    const used = new Set(outdoorLayerSpecs().map((l) => paintOf(l.id)["line-color"]));
    expect([...palette].every((c) => used.has(c))).toBe(true);
  });

  it("keeps every difficulty class visually distinct from every other", () => {
    // Difficulty is the information these lines carry, so two classes rendering
    // at the same colour is a silent data loss — and the desaturation done on
    // purpose (to keep the overlay behind the basemap) is exactly how it creeps
    // in. Assert real separation, not merely "different strings".
    const rgb = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const dist = (a: string, b: string): number => {
      const [r1, g1, b1] = rgb(a);
      const [r2, g2, b2] = rgb(b);
      return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
    };

    const MIN_SEPARATION = 20;
    const keys = [...PISTE_CLASSES, "lift", "trail"] as const;
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = keys[i];
        const b = keys[j];
        expect(
          dist(OUTDOOR_COLORS[a], OUTDOOR_COLORS[b]),
          `${a} vs ${b} are too similar to tell apart`,
        ).toBeGreaterThan(MIN_SEPARATION);
      }
    }
  });

  it("never reuses the trip's route colour for reference lines", () => {
    // The route colour is per-trip and read off the DOM; a collision here would
    // make a piste indistinguishable from the trip's own line.
    const routeish = new Set([OUTDOOR_COLORS.lift, OUTDOOR_COLORS.trail]);
    expect(routeish.size).toBe(2);
    for (const spec of outdoorLayerSpecs()) {
      expect(Object.values(OUTDOOR_COLORS)).toContain(paintOf(spec.id)["line-color"]);
    }
  });
});