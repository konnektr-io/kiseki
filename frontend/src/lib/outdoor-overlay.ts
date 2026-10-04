/**
 * Outdoor reference overlay — ski pistes, lifts and waymarked trails (#…).
 *
 * **What this is for:** exploration on the full-size trip map. The traveller
 * opens the day map over Zermatt and sees the actual runs and lifts around the
 * stop, or the marked trail up the valley — context the basemap does not carry.
 *
 * **What it is not:** trip content. The trip's own route, markers and track stay
 * the only *loud* things on screen (DESIGN.md §8.5, "quiet basemap, loud trip"),
 * so everything here is thin, low-opacity and below the route in the stack.
 *
 * ## Why a second tile source at all
 *
 * The basemap is OpenFreeMap `positron` on the OpenMapTiles schema. Its
 * `transportation` layer carries `class` / `subclass` / `network` and **no piste
 * or difficulty attributes whatsoever** — a piste is indistinguishable from a
 * footpath in it. So trails and runs cannot be recovered from the basemap
 * already in use; an overlay source is a requirement, not a preference.
 *
 * ## Why Maptoolkit
 *
 * OSM's own rendering sites cover the same ground but only as pictures, and the
 * two vector options each cost something:
 *
 * - **Waymarked Trails** serves real vector GeoJSON (`/api/v1/tiles/{z}/{x}/{y}.json`)
 *   carrying `difficulty` and `piste` — but **z12 is the only zoom level it
 *   serves** (verified z8–z16; every other zoom 404s). A slippy map cannot use it.
 * - **Maptoolkit** serves plain PBF at z0–z15 from one `mtk` tileset, with the
 *   outdoor data in the `road` layer as attributes: `subtype` carries the piste
 *   difficulty and the lift classes, `walking_network` carries the trail
 *   networks. One source covers both halves of this overlay.
 *
 * Everything outdoors lives in the single `road` source-layer, so this module
 * adds **one** source and a handful of filtered line layers over it.
 *
 * ## Print
 *
 * Screen-only by construction: this is wired into `RouteMap`, which carries no
 * `data-maplibre` handshake, so the booklet's `MapView` path never loads these
 * tiles. That is also what keeps the Maptoolkit community licence's
 * no-printed-media clause (§ 07(d)) satisfied.
 *
 * @see https://docs.maptoolkit.org/attribution/ — § 08 requires the Maptoolkit
 * logo *and* the `© Maptoolkit © Openstreetmap` line on any map using the
 * service. The copyright line arrives free from the TileJSON; the logo is a
 * separate element and is tracked as follow-up work (adding
 * `@maptoolkit/maplibre-logo-control` is a dependency change, so it is not
 * smuggled in here).
 */
import type { FilterSpecification, LayerSpecification, Map as MapLibreMap } from "maplibre-gl";

/**
 * The Maptoolkit TileJSON. Using `url:` rather than the versioned `tiles[]`
 * template on purpose: the template is pinned to a build id
 * (`/v28092026/mtk/…`) that rotates, and a source that names it directly goes
 * stale silently. MapLibre fetches the TileJSON and picks up the current
 * template *and* its `attribution` string, which is the § 08 copyright line.
 *
 * maxzoom 15 comes from the TileJSON.
 */
export const OUTDOOR_TILEJSON_URL = "https://tiles.maptoolkit.org/mtk.json";

export const OUTDOOR_SOURCE_ID = "kiseki-outdoor";

/**
 * Nothing below this zoom. At trip scale (a Canada heliski week frames around
 * z6) a national piste dataset is noise competing with the route for the ink
 * § 8.5 reserves for the trip — the same reasoning that puts contours at z10.
 * The overlay earns its place only once someone has zoomed into a valley.
 */
export const OUTDOOR_MINZOOM = 10;

/** Lift classes, all `subtype` values on the `road` layer. */
const LIFT_SUBTYPES = [
  "chair_lift",
  "drag_lift",
  "t-bar",
  "j-bar",
  "platter",
  "gondola",
  "cable_car",
  "funicular",
] as const;

/** Waymarked trail networks, `walking_network` values (local → international). */
const WALKING_NETWORKS = ["lwn", "rwn", "nwn", "iwn"] as const;

/**
 * Piste difficulty buckets, keyed by the `subtype` values Maptoolkit carries
 * (which mirror OSM's `piste:difficulty`). Grouping is deliberate:
 * `easy`/`novice` share a hue because they mean the same thing to a skier, and
 * `expert`/`extreme` share one for the same reason.
 */
export const PISTE_CLASSES = ["easy", "intermediate", "advanced", "expert", "freeride", "nordic"] as const;
export type PisteClass = (typeof PISTE_CLASSES)[number];

const SUBTYPE_TO_CLASS: Record<string, PisteClass> = {
  "downhill-easy": "easy",
  "downhill-novice": "easy",
  snow_park: "easy",
  "downhill-intermediate": "intermediate",
  "downhill-advanced": "advanced",
  "downhill-expert": "expert",
  "downhill-extreme": "expert",
  "downhill-freeride": "freeride",
};

/**
 * The piste class a `road` feature's `subtype` belongs to, or `null` when it is
 * not a piste. Exported for the unit tests and for the legend.
 *
 * `nordic-*` is matched by prefix (`nordic-novice`, `nordic-easy`, …) because
 * the cross-country subtypes are difficulty-suffixed, and none of them appear in
 * `SUBTYPE_TO_CLASS` — the suffix would otherwise be read as a downhill class.
 */
export function pisteClass(subtype: string | undefined | null): PisteClass | null {
  if (!subtype) return null;
  if (subtype.startsWith("nordic")) return "nordic";
  return SUBTYPE_TO_CLASS[subtype] ?? null;
}

/** Whether a `subtype` is an aerialway. */
export function isLift(subtype: string | undefined | null): boolean {
  return !!subtype && (LIFT_SUBTYPES as readonly string[]).includes(subtype);
}

/** Whether a `walking_network` value marks a waymarked trail. */
export function isWalkingNetwork(network: string | undefined | null): boolean {
  return !!network && (WALKING_NETWORKS as readonly string[]).includes(network);
}

/**
 * Muted, hue-distinct reference palette.
 *
 * These are deliberately NOT the saturated green/blue/red/black of a ski map.
 * § 8.5 reserves saturation for the trip: a piste drawn in full-chroma red
 * competes with the route it is supposed to sit behind, and at z11 a valley full
 * of them reads as the subject. Muted hues still separate by difficulty at a
 * glance (which is the information they carry) while leaving the trip's colour
 * the loudest thing on screen.
 *
 * The palette lives here as named constants rather than inline in the layer
 * specs — a canvas renderer takes colour strings, so these cannot be Tailwind
 * utilities, and scattering them through the component is how a hex literal ends
 * up in five places.
 */
export const OUTDOOR_COLORS = {
  // Rendered against the alpine/savanna presets over `igor` hillshade, and
  // judged on a screenshot: the first pass used warmer, more saturated hues and
  // the freeride/advanced lines visibly pulled focus off the basemap — a warm
  // line over cool grey relief reads as *foreground*. These are the same ramp
  // desaturated and cooled so difficulty still separates at a glance while the
  // overlay stays atmosphere. Do not re-saturate them without a screenshot.
  easy: "#5c9088",
  intermediate: "#5b7fa6",
  advanced: "#9c6b6b",
  expert: "#4a4a52",
  freeride: "#8c7a5c",
  nordic: "#5b93a0",
  lift: "#6b6b73",
  trail: "#7d6b8c",
} as const;

/**
 * One width curve for the whole overlay. Thin at the zoom it first appears and
 * still thin when the traveller is right on top of it — a reference layer that
 * thickens with zoom eventually competes with the route.
 *
 * Exported so the tests can assert every layer shares it: per-class widths are
 * exactly how a reference overlay quietly grows into a content layer.
 */
export const OUTDOOR_WIDTH: import("maplibre-gl").ExpressionSpecification = [
  "interpolate",
  ["exponential", 1.6],
  ["zoom"],
  OUTDOOR_MINZOOM,
  1.1,
  14,
  2.4,
];

function inFilter(property: string, values: readonly string[]): FilterSpecification {
  return ["in", ["get", property], ["literal", [...values]]];
}

/**
 * The overlay layers, in paint order (first is bottom).
 *
 * Lifts go down first: a lift is the least informative line here — it is
 * structure you ski *past* — so it should never sit over a run.
 *
 * Returned as data rather than added inline so the ordering and the filters are
 * assertable in a unit test, which is cheaper and more honest than reading the
 * component to check them.
 */
export function outdoorLayerSpecs(): LayerSpecification[] {
  const specs: LayerSpecification[] = [];

  specs.push({
    id: "outdoor-lifts",
    type: "line",
    source: OUTDOOR_SOURCE_ID,
    "source-layer": "road",
    minzoom: OUTDOOR_MINZOOM,
    filter: inFilter("subtype", LIFT_SUBTYPES),
    layout: { "line-cap": "butt" },
    paint: {
      "line-color": OUTDOOR_COLORS.lift,
      "line-width": OUTDOOR_WIDTH,
      "line-opacity": 0.45,
      // Dashed, matching how the recorded-track layer already draws lift rides
      // (#290) — same vocabulary for the same thing.
      "line-dasharray": [2, 2],
    },
  });

  for (const cls of PISTE_CLASSES) {
    specs.push({
      id: `outdoor-piste-${cls}`,
      type: "line",
      source: OUTDOOR_SOURCE_ID,
      "source-layer": "road",
      minzoom: OUTDOOR_MINZOOM,
      filter:
        cls === "nordic"
          ? // The nordic subtypes are difficulty-suffixed, so match the prefix.
            ["==", ["slice", ["get", "subtype"], 0, 6], "nordic"]
          : inFilter(
              "subtype",
              Object.entries(SUBTYPE_TO_CLASS)
                .filter(([, c]) => c === cls)
                .map(([s]) => s),
            ),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": OUTDOOR_COLORS[cls],
        "line-width": OUTDOOR_WIDTH,
        "line-opacity": 0.62,
      },
    });
  }

  specs.push({
    id: "outdoor-trails",
    type: "line",
    source: OUTDOOR_SOURCE_ID,
    "source-layer": "road",
    minzoom: OUTDOOR_MINZOOM,
    filter: inFilter("walking_network", WALKING_NETWORKS),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": OUTDOOR_COLORS.trail,
      "line-width": OUTDOOR_WIDTH,
      "line-opacity": 0.55,
      // Dashed so a trail never reads as a paved road, and so a trail and a
      // piste crossing stay two things.
      "line-dasharray": [3, 2],
    },
  });

  return specs;
}

/**
 * The basemap's first `symbol` layer — the overlay goes *below* the labels so
 * place names stay readable on top of it, and above the first `line` layer so
 * it is not buried under roads.
 *
 * Found by layer *type*, never by id, so it survives the style swap #40 will
 * make — same rule `lib/terrain.ts` follows for the same reason.
 */
function overlayBeforeLayerId(map: MapLibreMap): string | undefined {
  const layers = map.getStyle().layers ?? [];
  return layers.find((l) => l.type === "symbol")?.id;
}

/**
 * Put the overlay on a loaded map. Idempotent, and never throws.
 *
 * Reference context, not content: a tile server that is slow or down costs the
 * traveller their piste lines, never their route or their markers. Errors are
 * swallowed for the same reason `addTerrain` swallows its own.
 */
export function addOutdoorOverlay(map: MapLibreMap): void {
  try {
    if (map.getSource(OUTDOOR_SOURCE_ID)) return;
    map.addSource(OUTDOOR_SOURCE_ID, {
      type: "vector",
      url: OUTDOOR_TILEJSON_URL,
      minzoom: OUTDOOR_MINZOOM,
    });
    const before = overlayBeforeLayerId(map);
    for (const spec of outdoorLayerSpecs()) {
      if (map.getLayer(spec.id)) continue;
      map.addLayer(spec, before);
    }
  } catch {
    /* no outdoor reference this time — the trip is unaffected */
  }
}

/** Take it off again (a toggle, and a teardown path). Never throws. */
export function removeOutdoorOverlay(map: MapLibreMap): void {
  try {
    for (const spec of outdoorLayerSpecs()) {
      if (map.getLayer(spec.id)) map.removeLayer(spec.id);
    }
    if (map.getSource(OUTDOOR_SOURCE_ID)) map.removeSource(OUTDOOR_SOURCE_ID);
  } catch {
    /* already gone */
  }
}