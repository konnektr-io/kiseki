import { describe, expect, it } from "vitest";
import {
  OUTDOOR_LABEL_LAYER_IDS,
  OUTDOOR_LABEL_MINZOOM,
  OUTDOOR_LABEL_SOURCE_LAYER,
  addOutdoorLabels,
  outdoorLabelLayerSpecs,
  removeOutdoorLabels,
  type OutdoorLabelMap,
} from "./outdoor-labels";
import { OUTDOOR_MINZOOM, OUTDOOR_SOURCE_ID } from "./outdoor-overlay";
import { LIFT_GLYPH_KINDS, liftGlyphImageId } from "./lift-glyphs";

type LineSpec = Extract<ReturnType<typeof outdoorLabelLayerSpecs>[number], { type: "symbol" }>;

function specOf(id: string): LineSpec {
  const s = outdoorLabelLayerSpecs().find((l) => l.id === id) as LineSpec | undefined;
  if (!s) throw new Error(`no such layer: ${id}`);
  return s;
}

function layoutOf(id: string): Record<string, unknown> {
  return (specOf(id).layout ?? {}) as Record<string, unknown>;
}

function paintOf(id: string): Record<string, unknown> {
  return (specOf(id).paint ?? {}) as Record<string, unknown>;
}

/**
 * The OUTPUT stops of an `["interpolate", ["linear"], ["zoom"], z0, v0, …]`
 * expression. The zoom INPUTS sit at odd indices after the `["zoom"]` key, so
 * taking every number reads a zoom level as if it were a paint value.
 */
function stops(expr: unknown): number[] {
  if (!Array.isArray(expr)) return [];
  const out: number[] = [];
  for (let i = 4; i < expr.length; i += 2) {
    if (typeof expr[i] === "number") out.push(expr[i] as number);
  }
  return out;
}

describe("outdoorLabelLayerSpecs", () => {
  it("reads names from road_label — the layer that actually has them", () => {
    // Measured: `road` carries no name and no ref at all. Reading labels off
    // `road` would silently render nothing.
    for (const raw of outdoorLabelLayerSpecs()) {
      const spec = raw as LineSpec;
      expect(spec.source).toBe(OUTDOOR_SOURCE_ID);
      expect(spec["source-layer"]).toBe(OUTDOOR_LABEL_SOURCE_LAYER);
    }
  });

  it("waits until well past the zoom the lines appear", () => {
    // The whole point: a label that appears with its line is noise. Lines start
    // at OUTDOOR_MINZOOM (10); labels must come later.
    expect(OUTDOOR_LABEL_MINZOOM).toBeGreaterThan(OUTDOOR_MINZOOM);
    for (const raw of outdoorLabelLayerSpecs()) {
      expect((raw as LineSpec).minzoom).toBe(OUTDOOR_LABEL_MINZOOM);
    }
  });

  it("has the four layers: glyphs, piste names, trail names, lift names", () => {
    expect(OUTDOOR_LABEL_LAYER_IDS).toEqual([
      "outdoor-lift-glyphs",
      "outdoor-piste-labels",
      "outdoor-trail-labels",
      "outdoor-lift-labels",
    ]);
  });

  it("puts the glyph layer below the text layers so a name never sits on a pictogram", () => {
    const ids = OUTDOOR_LABEL_LAYER_IDS;
    expect(ids.indexOf("outdoor-lift-glyphs")).toBeLessThan(ids.indexOf("outdoor-piste-labels"));
  });

  it("keeps labels subordinate — small text, and never allowed to overlap", () => {
    for (const id of ["outdoor-piste-labels", "outdoor-trail-labels", "outdoor-lift-labels"]) {
      const layout = layoutOf(id);
      const size = layout["text-size"];
      // An interpolate expression, not a constant — and its top stop is small.
      expect(Array.isArray(size)).toBe(true);
      expect(Math.max(...stops(size))).toBeLessThanOrEqual(11);
      // Overlap is how annotation starts shouting over the trip.
      expect(layout["text-allow-overlap"]).toBe(false);
    }
  });

  it("aligns names ALONG the line, trail-map style", () => {
    for (const id of ["outdoor-piste-labels", "outdoor-trail-labels", "outdoor-lift-labels"]) {
      const layout = layoutOf(id);
      expect(layout["symbol-placement"]).toBe("line");
      // `auto` is what makes the name take its segment's bearing. It is also the
      // only legal value here that does: MapLibre v6's legal set is
      // map | viewport | viewport-glyph | auto — there is no "line" — and v6 has
      // no `text-rotation` property at all, so that key was doing nothing.
      expect(layout["text-rotation-alignment"]).toBe("auto");
      expect(layout).not.toHaveProperty("text-rotation");
      // viewport pitch keeps a steep run's name from turning vertical
      expect(layout["text-pitch-alignment"]).toBe("viewport");
      expect(typeof layout["symbol-spacing"]).toBe("number");
    }
  });

  it("uses the basemap's own font stack so glyphs resolve", () => {
    // OpenFreeMap positron serves `Noto Sans Regular`; anything else 404s the
    // glyph range and every label renders blank.
    for (const id of ["outdoor-piste-labels", "outdoor-trail-labels", "outdoor-lift-labels"]) {
      expect(layoutOf(id)["text-font"]).toEqual(["Noto Sans Regular"]);
    }
  });

  it("pairs a piste's name with its number, so a bare numeral never reads as a road", () => {
    // A lone haloed "31" uses the SAME grammar the basemap uses for `N 10`, so it
    // reads as a road shield. "Riedweg 31" is the piste-map convention and carries
    // the name that identifies it; a bare number survives only with no name.
    const field = layoutOf("outdoor-piste-labels")["text-field"] as unknown[];
    expect(field[0]).toBe("case");
    const flat = JSON.stringify(field);
    expect(flat).toContain("concat");
    expect(flat).toContain("name");
    expect(flat).toContain("ref");
  });

  it("never rotates a lift glyph — a gondola on its side is not a gondola", () => {
    // `map` alignment ties the icon to the LINE's bearing, so on a steep lift the
    // pictogram turns with the slope. A 7x crop of a Zermatt cable car showed the
    // cable running vertically down the disc with the cabin beside it.
    expect(layoutOf("outdoor-lift-glyphs")["icon-rotation-alignment"]).toBe("viewport");
  });

  it("puts the lift name on its line, like the piste and trail names", () => {
    // Offsetting it read as separate annotation rather than as this lift's name.
    for (const id of ["outdoor-lift-labels", "outdoor-piste-labels", "outdoor-trail-labels"]) {
      expect(layoutOf(id)["text-offset"]).toBeUndefined();
    }
  });

  it("only labels features that have something to say", () => {
    for (const id of ["outdoor-piste-labels", "outdoor-trail-labels", "outdoor-lift-labels"]) {
      const filter = JSON.stringify(specOf(id).filter);
      expect(filter).toContain("has");
      expect(filter).toContain("name");
      expect(filter).toContain("ref");
    }
  });

  it("separates trails by walking_network, and pistes by subtype", () => {
    expect(JSON.stringify(specOf("outdoor-trail-labels").filter)).toContain("iwn");
    expect(JSON.stringify(specOf("outdoor-trail-labels").filter)).toContain("lwn");
    const pisteFilter = specOf("outdoor-piste-labels").filter as unknown[];
    const piste = JSON.stringify(pisteFilter);
    expect(piste).toContain("downhill-advanced");
    // nordic-* matched by prefix, so nordic-easy never reads as a downhill class —
    // and GUARDED by ["has","subtype"], because an unguarded `slice` errors on
    // every feature with no subtype, MapLibre falls back to false, and the layer
    // renders empty while reporting nothing.
    expect(piste).toContain("slice");
    expect(piste).toContain("has");
    // Walk the whole nested filter — the branch sits three levels down
    // (all > any > all), so a fixed `flat(n)` depth keeps missing it.
    const walk = (node: unknown, out: unknown[][]): unknown[][] => {
      if (Array.isArray(node)) {
        out.push(node);
        node.forEach((n) => walk(n, out));
      }
      return out;
    };
    const nordicBranch = walk(pisteFilter, [])
      .reverse()
      .find((f) => f[0] === "all" && JSON.stringify(f).includes("slice") && JSON.stringify(f).includes("nordic"));
    expect(nordicBranch, "no guarded nordic prefix branch found in the piste filter").toBeDefined();
    expect(nordicBranch).toContainEqual(["has", "subtype"]);
  });

  it("gives each label a halo, so a name survives a snowfield and a dark piste", () => {
    for (const id of ["outdoor-piste-labels", "outdoor-trail-labels", "outdoor-lift-labels"]) {
      const paint = paintOf(id);
      expect(typeof paint["text-halo-color"]).toBe("string");
      expect((paint["text-halo-width"] as unknown[]).length).toBeGreaterThan(1);
    }
  });

  it("picks the lift glyph from subtype, aliasing to the four drawn kinds", () => {
    const icon = layoutOf("outdoor-lift-glyphs")["icon-image"] as unknown[];
    expect(icon[0]).toBe("match");
    const flat = JSON.stringify(icon);
    // every alias maps onto one of the four registered sprites
    for (const kind of LIFT_GLYPH_KINDS) {
      expect(flat).toContain(liftGlyphImageId(kind));
    }
    expect(flat).toContain("cable_car");
    expect(flat).toContain("platter");
  });

  it("places the glyph along the lift line, small", () => {
    const layout = layoutOf("outdoor-lift-glyphs");
    // `line`, not `point`: the lift labels are LINESTRINGS and `point` placement
    // on a line feature yields nothing at all. `line` anchors the glyph to a
    // point along the run.
    expect(layout["symbol-placement"]).toBe("line");
    expect(layout["icon-allow-overlap"]).toBe(false);
    const size = layout["icon-size"];
    expect(Math.max(...stops(size))).toBeLessThanOrEqual(0.75);
  });

  it("keeps every symbol-spacing small enough for a real label fragment to host", () => {
    // The failure this pins is silent: the layer exists, the lines draw, and the
    // map simply has no names on it.
    //
    // Two bounds, and the TIGHTER one is what matters. A 256px tile is 4096 MVT
    // units (16 units/px). Measured on the real Zermatt z14 tile, piste label
    // fragments run 33–822 units. MapLibre places a line symbol only when the
    // fragment is at least `symbol-spacing` long — but the binding constraint is
    // the LABEL's own width: at `text-size` 11.5px a 12-character name is ~76px,
    // and a spacing above that leaves no room to draw it. The first version
    // shipped 260px (≈5 km of line) and rendered nothing at all while every
    // assertion about the layer's EXISTENCE stayed green.
    const MAX_SPACING_PX = 76;
    for (const id of ["outdoor-piste-labels", "outdoor-trail-labels", "outdoor-lift-labels", "outdoor-lift-glyphs"]) {
      const spacing = layoutOf(id)["symbol-spacing"] as number;
      expect(spacing, `${id} spacing ${spacing}px exceeds what a real fragment can host`)
        .toBeLessThanOrEqual(MAX_SPACING_PX);
    }
  });
});

describe("addOutdoorLabels / removeOutdoorLabels", () => {
  function stub(withSource = true): OutdoorLabelMap & { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    return {
      added,
      removed,
      getSource: (id) => (withSource && id === OUTDOOR_SOURCE_ID ? {} : undefined),
      // No layer present by default; each test says which state it wants.
      getLayer: () => undefined,
      addLayer: (layer) => added.push(layer.id),
      removeLayer: (id) => removed.push(id),
    };
  }

  it("adds all four layers", () => {
    const map = stub();
    addOutdoorLabels(map);
    expect(map.added).toEqual(OUTDOOR_LABEL_LAYER_IDS);
  });

  it("does nothing when the outdoor source is absent", () => {
    // The lines are not there, so there is nothing to annotate — and adding
    // layers against a missing source would throw inside MapLibre.
    const map = stub(false);
    expect(() => addOutdoorLabels(map)).not.toThrow();
    expect(map.added).toEqual([]);
  });

  it("is idempotent", () => {
    const map = stub();
    map.getLayer = () => ({}) as unknown; // every layer already present
    addOutdoorLabels(map);
    expect(map.added).toEqual([]);
  });

  it("never throws when the map rejects a layer", () => {
    const map = stub();
    map.addLayer = () => {
      throw new Error("boom");
    };
    expect(() => addOutdoorLabels(map)).not.toThrow();
  });

  it("removes exactly the layers it added, when they are present", () => {
    const map = stub();
    map.getLayer = () => ({}) as unknown; // present
    removeOutdoorLabels(map);
    expect(map.removed).toEqual(OUTDOOR_LABEL_LAYER_IDS);
  });

  it("removes nothing when the layers are already gone", () => {
    // The guard is the point: removeLayer on a missing id throws inside MapLibre.
    const map = stub();
    map.getLayer = () => undefined;
    expect(() => removeOutdoorLabels(map)).not.toThrow();
    expect(map.removed).toEqual([]);
  });
});