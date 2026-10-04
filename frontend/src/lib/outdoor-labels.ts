/**
 * Outdoor overlay LABELS — names along pistes, trails and lifts.
 *
 * Shipped in #403 (lines) and extended here with the labels. The rule that
 * governs all of it is DESIGN.md §8.5: **quiet basemap, loud trip.** The trip's
 * route, markers and day cards must stay the loudest things on screen, so
 *
 * - labels appear only from `OUTDOOR_LABEL_MINZOOM`, well past the zoom where
 *   the lines themselves appear (10),
 * - and they are drawn *under* the trip's own labels and markers in the stack.
 *
 * A label that appears at the same zoom as the line it names is noise; a label
 * that competes with the trip is worse than noise. Hence the two gates.
 *
 * ## Why the labels come from `road_label`, not `road`
 *
 * Measured on real tiles: the `road` layer carries **no** `name` and no `ref` at
 * all (Zermatt z14: 467 features, zero with either). The names live only in
 * `road_label`, which also carries `subtype` and `network` — so one extra
 * source-layer over the SAME source is enough, and no second tile request.
 *
 * ## What a label says
 *
 * `name` when present, else `ref` — a piste's number ("31") is often the only
 * identifier it has, and it is exactly what a skier looks for. Lifts get their
 * name plus a glyph for the class.
 *
 * ## Alignment — and the spacing that actually matters
 *
 * `road_label` features are **lines** (Zermatt z14: 269 LineString / 59
 * MultiLineString), so `symbol-placement: line` gives real trail-map behaviour —
 * the name follows the trail and rotates with it — rather than a dot on the
 * centroid. `text-rotation-alignment: auto` lets each glyph take its segment's
 * bearing.
 *
 * **The spacing is the whole ballgame, and it is not a taste knob.** With
 * `symbol-placement: line`, MapLibre can only place a label on a fragment at
 * least `symbol-spacing` long. Measured on the real Zermatt z14 tile, the piste
 * label fragments are:
 *
 * | label | units | metres |
 * |---|---|---|
 * | Riedweg | 822 | ~980 m |
 * | Zen Steckenstrasse | 715 | ~850 m |
 * | Blatten | 277 | ~330 m |
 * | Moosstrasse | **33** | **~39 m** |
 *
 * A 256 px tile is 4096 units, so **16 units ≈ 1 px**. At the spacing this module
 * originally shipped (260 px ≈ **4 160 units ≈ 5 km**) **not one of those
 * fragments could host a label** and every layer rendered empty — while the line
 * layers beside them drew fine, so the map looked healthy and simply had no
 * names on it. The spacing below is what makes placement possible at all.
 */
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from "maplibre-gl";
import { LIFT_GLYPH_CLASSES, liftGlyphImageId } from "./lift-glyphs";
import { OUTDOOR_SOURCE_ID } from "./outdoor-overlay";

/** The source-layer the names live in. */
export const OUTDOOR_LABEL_SOURCE_LAYER = "road_label";

/**
 * Labels wait until here. The lines start at z10; a name needs the geometry
 * under it to have resolved into something legible, and at z11–z12 a ski area
 * still has dozens of pistes whose names would pile onto each other. z13 is
 * where someone is actually *reading* a map to choose a run.
 */
export const OUTDOOR_LABEL_MINZOOM = 13;

/**
 * Line heights, small. A piste name is annotation, not a headline — the trip's
 * place pins are the only labels allowed to be large on this map.
 */
const LABEL_SIZE: import("maplibre-gl").ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  OUTDOOR_LABEL_MINZOOM,
  9,
  16,
  11.5,
];

const HALO_SIZE: import("maplibre-gl").ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  OUTDOOR_LABEL_MINZOOM,
  1.1,
  16,
  1.6,
];

/**
 * Text colour per class, matched to the line palette in `outdoor-overlay.ts` so
 * a label reads as belonging to its line. `case` rather than `match` because the
 * lift classes collapse to four glyph kinds.
 */
function labelColor(cls: string): string {
  switch (cls) {
    case "easy":
      return "#5c9088";
    case "intermediate":
      return "#5b7fa6";
    case "advanced":
      return "#9c6b6b";
    case "expert":
      return "#4a4a52";
    case "freeride":
      return "#8c7a5c";
    case "nordic":
      return "#5b93a0";
    case "lift":
      return "#6b6b73";
    default:
      return "#7d6b8c"; // trail
  }
}

/** `subtype` → the label's colour class, mirroring `pisteClass` + lift + trail. */
function colorExpr(): import("maplibre-gl").ExpressionSpecification {
  const cases: unknown[] = [];
  const add = (value: unknown, out: string) => cases.push(["==", ["get", "subtype"], value], out);

  add("downhill-easy", labelColor("easy"));
  add("downhill-novice", labelColor("easy"));
  add("snow_park", labelColor("easy"));
  add("downhill-intermediate", labelColor("intermediate"));
  add("downhill-advanced", labelColor("advanced"));
  add("downhill-expert", labelColor("expert"));
  add("downhill-extreme", labelColor("expert"));
  add("downhill-freeride", labelColor("freeride"));

  // Guarded for the same reason as NORDIC_PREFIX: a feature with no `subtype`
  // makes `slice` error, MapLibre falls back to false, and in a `case` chain that
  // silently paints every such feature the trail colour.
  cases.push(
    ["all", ["has", "subtype"], ["==", ["slice", ["get", "subtype"], 0, 6], "nordic"]],
    labelColor("nordic"),
  );
  for (const s of LIFT_GLYPH_CLASSES) add(s, labelColor("lift"));
  return ["case", ...cases, labelColor("trail")] as import("maplibre-gl").ExpressionSpecification;
}

/**
 * `subtype` → the registered sprite id.
 *
 * Must agree with `liftGlyphClass` in `lift-glyphs.ts`; the four branches are
 * the same four `LIFT_GLYPH_KINDS`. Kept as a data expression (not a
 * `match`) because the aliasing has to happen here too, and a `case` makes the
 * two sides easy to compare by eye.
 */
function glyphExpr(): import("maplibre-gl").ExpressionSpecification {
  return [
    "match",
    ["get", "subtype"],
    ["gondola", "cable_car"],
    liftGlyphImageId("gondola"),
    ["chair_lift"],
    liftGlyphImageId("chair_lift"),
    ["drag_lift", "t-bar", "j-bar", "platter"],
    liftGlyphImageId("t-bar"),
    ["funicular"],
    liftGlyphImageId("funicular"),
    liftGlyphImageId("gondola"), // unreachable default; keeps the expression total
  ] as import("maplibre-gl").ExpressionSpecification;
}

/** `name` when it exists, else `ref` — a piste number is a real label. */
const TEXT_FIELD: import("maplibre-gl").ExpressionSpecification = [
  "coalesce",
  ["get", "name"],
  ["get", "ref"],
];

/**
 * Only features that have something to say.
 *
 * Typed as an EXPRESSION, not a `FilterSpecification`: it is only ever used
 * *inside* an `all`/`any`, and annotating it as a top-level filter makes every
 * wrapper lose its tuple type and fail `tsc`.
 */
const HAS_TEXT = ["any", ["has", "name"], ["has", "ref"]] as unknown as ExpressionSpecification;

/**
 * The nordic prefix test, guarded.
 *
 * `["slice", ["get", "subtype"], 0, 6] == "nordic"` is how you match a
 * difficulty-suffixed family (`nordic-easy`, `nordic-novice`, …) without listing
 * them. But MapLibre evaluates a filter against EVERY feature in the tile, and
 * for the many features with **no** `subtype` the `get` returns null — `slice`
 * then errors, MapLibre logs "Expected first argument to be of type array or
 * string, but found null … Falling back to false", and the whole expression is
 * false. Measured cost: it silenced `outdoor-piste-labels` entirely and
 * `outdoor-piste-nordic` with it, which is why every label layer rendered empty
 * while reporting no error of its own.
 *
 * The `["has", "subtype"]` conjunct is what makes the expression total: it is
 * false for a feature with no subtype BEFORE `slice` can be reached, and
 * `all` short-circuits. Never drop it.
 */
const NORDIC_PREFIX = (): FilterSpecification => [
  "all",
  ["has", "subtype"],
  ["==", ["slice", ["get", "subtype"], 0, 6], "nordic"],
] as FilterSpecification;

const TRAIL_NETWORKS = [
  "in",
  ["get", "network"],
  ["literal", ["iwn", "nwn", "rwn", "lwn"]],
] as unknown as ExpressionSpecification;

/**
 * The label layers, in paint order.
 *
 * Lift glyphs go **first** (bottom) so a name never sits on top of another
 * line's pictogram, and the glyph layer's own labels ride the line at its
 * midpoint while the text layer carries piste and trail names.
 *
 * Returned as data so the ordering, the filters and the zoom gate are
 * assertable in a unit test rather than only readable in the component.
 */
export function outdoorLabelLayerSpecs(): LayerSpecification[] {
  const specs: LayerSpecification[] = [];

  // One glyph per lift, at the line's midpoint, no text.
  specs.push({
    id: "outdoor-lift-glyphs",
    type: "symbol",
    source: OUTDOOR_SOURCE_ID,
    "source-layer": OUTDOOR_LABEL_SOURCE_LAYER,
    minzoom: OUTDOOR_LABEL_MINZOOM,
    filter: ["in", ["get", "subtype"], ["literal", [...LIFT_GLYPH_CLASSES]]],
    layout: {
      // `line`, not `point`: the lift labels are LINESTRINGS, and `point`
      // placement on a line feature is not a supported anchor — the layer comes
      // back empty. `line` puts the glyph at a point along the run, which is
      // what a lift pictogram wants anyway (on the lift, not at the valley).
      "symbol-placement": "line",
      "symbol-spacing": 60,
      "icon-image": glyphExpr(),
      "icon-size": ["interpolate", ["linear"], ["zoom"], OUTDOOR_LABEL_MINZOOM, 0.5, 16, 0.72],
      "icon-allow-overlap": false,
      "icon-rotation-alignment": "map",
      "icon-padding": 2,
    },
  });

  // Piste names + piste numbers.
  specs.push({
    id: "outdoor-piste-labels",
    type: "symbol",
    source: OUTDOOR_SOURCE_ID,
    "source-layer": OUTDOOR_LABEL_SOURCE_LAYER,
    minzoom: OUTDOOR_LABEL_MINZOOM,
    filter: [
      "all",
      HAS_TEXT,
      [
        "any",
        [
          "match",
          ["get", "subtype"],
          [
            "downhill-easy",
            "downhill-novice",
            "downhill-intermediate",
            "downhill-advanced",
            "downhill-expert",
            "downhill-extreme",
            "downhill-freeride",
            "snow_park",
          ],
          true,
          false,
        ],
        // nordic-* by prefix (same trap as the line layer) — guarded, see NORDIC_PREFIX
        NORDIC_PREFIX(),
      ],
    ] as FilterSpecification,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 40,
      "text-field": TEXT_FIELD,
      "text-size": LABEL_SIZE,
      "text-font": ["Noto Sans Regular"],
      // `auto` IS the trail-map behaviour: on a line-placed symbol the text
      // follows the line's bearing. Two corrections are baked in here, both
      // found by the typecheck rather than by looking at the render —
      // `text-rotation-alignment: "line"` is not a legal value (legal:
      // map | viewport | viewport-glyph | auto), and MapLibre v6 has **no**
      // `text-rotation` property at all, so the extra key was silently doing
      // nothing even where it typechecked.
      "text-rotation-alignment": "auto",
      "text-pitch-alignment": "viewport",
      "text-letter-spacing": 0.04,
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": colorExpr(),
      "text-halo-color": "rgba(255,255,255,0.85)",
      "text-halo-width": HALO_SIZE,
      "text-halo-blur": 0.4,
    },
  });

  // Trail names.
  specs.push({
    id: "outdoor-trail-labels",
    type: "symbol",
    source: OUTDOOR_SOURCE_ID,
    "source-layer": OUTDOOR_LABEL_SOURCE_LAYER,
    minzoom: OUTDOOR_LABEL_MINZOOM,
    filter: ["all", HAS_TEXT, TRAIL_NETWORKS] as FilterSpecification,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 40,
      "text-field": TEXT_FIELD,
      "text-size": LABEL_SIZE,
      "text-font": ["Noto Sans Regular"],
      // `auto` IS the trail-map behaviour: on a line-placed symbol the text
      // follows the line's bearing. Two corrections are baked in here, both
      // found by the typecheck rather than by looking at the render —
      // `text-rotation-alignment: "line"` is not a legal value (legal:
      // map | viewport | viewport-glyph | auto), and MapLibre v6 has **no**
      // `text-rotation` property at all, so the extra key was silently doing
      // nothing even where it typechecked.
      "text-rotation-alignment": "auto",
      "text-pitch-alignment": "viewport",
      "text-letter-spacing": 0.04,
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": labelColor("trail"),
      "text-halo-color": "rgba(255,255,255,0.85)",
      "text-halo-width": HALO_SIZE,
      "text-halo-blur": 0.4,
    },
  });

  // Lift names, next to their glyph.
  specs.push({
    id: "outdoor-lift-labels",
    type: "symbol",
    source: OUTDOOR_SOURCE_ID,
    "source-layer": OUTDOOR_LABEL_SOURCE_LAYER,
    minzoom: OUTDOOR_LABEL_MINZOOM,
    filter: [
      "all",
      HAS_TEXT,
      ["in", ["get", "subtype"], ["literal", [...LIFT_GLYPH_CLASSES]]],
    ] as FilterSpecification,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 60,
      "text-field": TEXT_FIELD,
      "text-size": LABEL_SIZE,
      "text-font": ["Noto Sans Regular"],
      // `auto` IS the trail-map behaviour: on a line-placed symbol the text
      // follows the line's bearing. Two corrections are baked in here, both
      // found by the typecheck rather than by looking at the render —
      // `text-rotation-alignment: "line"` is not a legal value (legal:
      // map | viewport | viewport-glyph | auto), and MapLibre v6 has **no**
      // `text-rotation` property at all, so the extra key was silently doing
      // nothing even where it typechecked.
      "text-rotation-alignment": "auto",
      "text-pitch-alignment": "viewport",
      "text-allow-overlap": false,
      // Offset the name off the line so it does not sit on the dash pattern.
      "text-offset": [0, -0.9],
    },
    paint: {
      "text-color": labelColor("lift"),
      "text-halo-color": "rgba(255,255,255,0.85)",
      "text-halo-width": HALO_SIZE,
      "text-halo-blur": 0.4,
    },
  });

  return specs;
}

/** Every outdoor label layer id, for removal. */
export const OUTDOOR_LABEL_LAYER_IDS = outdoorLabelLayerSpecs().map((l) => l.id);

/**
 * The structural surface the label installer needs — declared as the subset it
 * uses, so the module stays unit-testable with a stub and no MapLibre import.
 * A real `MapLibreMap` satisfies it.
 */
export interface OutdoorLabelMap {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, before?: string): void;
  removeLayer(id: string): void;
}

/**
 * Add the label layers on a map that already carries the outdoor source.
 * Idempotent, and never throws: annotation that will not load must not cost the
 * traveller their trip lines.
 *
 * `before` is the layer the labels must sit *below* — the trip's own labels and
 * markers. Callers pass the basemap's first `symbol` layer for that reason.
 */
export function addOutdoorLabels(map: OutdoorLabelMap, before?: string): void {
  try {
    if (!map.getSource(OUTDOOR_SOURCE_ID)) return; // the line layer is not present; nothing to annotate
    for (const spec of outdoorLabelLayerSpecs()) {
      if (map.getLayer(spec.id)) continue;
      map.addLayer(spec, before);
    }
  } catch {
    /* no labels this time — the lines and the trip are unaffected */
  }
}

/** Remove the label layers. Never throws. */
export function removeOutdoorLabels(map: OutdoorLabelMap): void {
  try {
    for (const id of OUTDOOR_LABEL_LAYER_IDS) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
  } catch {
    /* already gone */
  }
}