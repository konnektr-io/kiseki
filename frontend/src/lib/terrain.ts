/**
 * Elevation on the map — hillshade, contours and (optional) 3D terrain (#38).
 *
 * Terrain is the reason a heliski week in the Selkirks looks like *that* trip
 * and not a generic pin map. It is also atmosphere, not the subject: DESIGN.md
 * §8.5 is "quiet basemap, loud trip", so everything here stays low-contrast and
 * stays *below* the route and the markers in the layer stack.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Mapterhorn — free, keyless, terrarium-encoded, BSD-3 (verified 2026-09-01
 * against `https://tiles.mapterhorn.com/tilejson.json`). Same "no vendor key"
 * property as the basemap, so elevation adds no new credential to protect.
 *
 * The values below are copied from that TileJSON rather than fetched via
 * `url:` for one reason: **it declares no `maxzoom`**, so MapLibre would fall
 * back to its default of 22 and request tiles that do not exist.
 *
 * ⚠️ `maxzoom: 12` is a deliberate floor, not the server's limit. Mapterhorn
 * serves through z15 where the underlying data is good (verified over BC:
 * z15 → 200, z16 → 404) but global coverage is Copernicus GLO-30, which at
 * 30 m is already finer than a z12 512px tile. Capping at 12 makes MapLibre
 * upscale beyond it — relief goes soft when you zoom right in, which is far
 * better than 404 gaps in a region that only has the global layer. Raise it if
 * a zoomed-in activity view ever needs crisper relief, and check coverage in
 * that region first.
 */
export const DEM_TILES = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
export const DEM_ENCODING = "terrarium" as const;
export const DEM_TILE_SIZE = 512;
export const DEM_MAXZOOM = 12;
export const DEM_ATTRIBUTION = "<a href='https://www.mapterhorn.com/attribution' target='_blank' rel='noreferrer'>© Mapterhorn</a>";

const DEM_SOURCE_ID = "kiseki-dem";
const CONTOUR_SOURCE_ID = "kiseki-contours";

/**
 * 3D terrain: **attached the first time the camera actually tilts.**
 *
 * It was off entirely at first, on the reasoning that pitch costs legibility on
 * a 192px map, drains battery and makes labels swim for a view almost nobody
 * rotates. That reasoning was half right and produced a worse state than either
 * extreme: pitch gestures are enabled, so the map *invites* a tilt and then
 * stays stubbornly flat. Nothing signals that the elevation is only shading.
 *
 * Lazy attachment gets both. At `pitch: 0` a terrain mesh is invisible by
 * definition, so waiting for `pitchstart` costs the flat view — the one
 * practically everyone sees — literally nothing: no mesh built, no layers
 * draped, no extra draw. Tilt and it is there. It also satisfies #38's
 * guardrail ("do not enable pitch/3D by default on mobile") precisely, rather
 * than by giving up the feature.
 *
 * The per-trip switch ("terrain on, exaggeration 1.3" vs "flat, minimal")
 * belongs to the theme preset in #40; these constants are the seam.
 */
export const TERRAIN_3D = true;
/**
 * Slightly above life-size. At trip scale a real 1.0 vertical is nearly
 * invisible — even the Selkirks are a few km of relief across a few hundred km
 * of map — and anything past ~1.5 turns the Rockies into a cardboard cutout.
 */
export const TERRAIN_EXAGGERATION = 1.3;

/**
 * The layer these should sit under.
 *
 * Elevation belongs above the basemap's landcover and water fills but below
 * its roads, boundaries and labels — otherwise shading washes out exactly the
 * information the map is for. Found by layer *type* rather than by id so this
 * survives a style swap (#40): the first `line` layer in a basemap is
 * reliably the start of the road/waterway stack.
 */
function firstLineLayerId(map: MapLibreMap): string | undefined {
  const layers = map.getStyle().layers ?? [];
  return (layers.find((l) => l.type === "line") ?? layers.find((l) => l.type === "symbol"))?.id;
}

/** Shared DEM source — hillshade, contours and 3D terrain all read this one. */
function addDemSource(map: MapLibreMap): void {
  if (map.getSource(DEM_SOURCE_ID)) return;
  map.addSource(DEM_SOURCE_ID, {
    type: "raster-dem",
    tiles: [DEM_TILES],
    encoding: DEM_ENCODING,
    tileSize: DEM_TILE_SIZE,
    maxzoom: DEM_MAXZOOM,
    attribution: DEM_ATTRIBUTION,
  });
}

/**
 * Shaded relief.
 *
 * `igor` rather than `multidirectional`, and that is the whole ballgame here.
 * Multidirectional renders dramatic relief — and buries the pale roads and
 * place labels positron draws on top of it, which is the opposite of what a
 * road-trip map is for. Igor is the method built to minimise its effect on the
 * features beneath it, so the ranges read and the roads survive. Compared
 * side by side at z8 over the Selkirks before choosing.
 *
 * One layer, one pass: stacking several hillshades at different illumination
 * angles was the pre-5.5 workaround for soft shading and costs N extra draw
 * passes over the same DEM. Illumination is anchored to the `map`, not the
 * viewport, so the light does not swing around when the map rotates.
 *
 * Shadows cool and translucent, highlights warm and translucent: pure
 * black/white is the other half of why hillshade usually looks harsh, and the
 * alpha is what keeps the basemap's greys readable underneath.
 */
function addHillshade(map: MapLibreMap, before?: string): void {
  if (map.getLayer("hillshade")) return;
  map.addLayer(
    {
      id: "hillshade",
      type: "hillshade",
      source: DEM_SOURCE_ID,
      paint: {
        "hillshade-method": "igor",
        "hillshade-exaggeration": 0.7,
        "hillshade-illumination-anchor": "map",
        "hillshade-shadow-color": "rgba(38,54,86,0.5)",
        "hillshade-highlight-color": "rgba(255,247,237,0.3)",
      },
    },
    before,
  );
}

/**
 * Contour lines, derived in a worker from the same DEM — no contour tileset to
 * build or host (`maplibre-contour`).
 *
 * `minzoom: 10` is doing real work: at trip scale (z6–z9, where most of these
 * maps sit) contours are noise that competes with the route for exactly the
 * ink DESIGN.md §8.5 reserves for the trip. They appear when someone zooms in
 * to look at a pass or a valley, which is when they mean something.
 */
async function addContours(map: MapLibreMap, lib: typeof import("maplibre-gl")): Promise<void> {
  if (map.getSource(CONTOUR_SOURCE_ID)) return;
  const mlcontour = (await import("maplibre-contour")).default;
  const demSource = new mlcontour.DemSource({
    url: DEM_TILES,
    encoding: DEM_ENCODING,
    maxzoom: DEM_MAXZOOM,
    worker: true,
  });
  // registers the `contour://` protocol on the SAME maplibre instance the map
  // was built from — a second copy of the module would register on the wrong one
  demSource.setupMaplibre(lib as never);

  map.addSource(CONTOUR_SOURCE_ID, {
    type: "vector",
    tiles: [
      demSource.contourProtocolUrl({
        // Intervals are deliberately coarser than the DEM's nominal 30 m
        // resolution would allow. Copernicus GLO-30 quantises hard over smooth
        // surfaces — snowfields and glaciers especially — and 100 m lines on
        // quantised elevation draw the terracing rather than the terrain.
        thresholds: {
          10: [500, 2000],
          11: [250, 1000],
          12: [200, 1000],
          14: [100, 500],
        },
        elevationKey: "ele",
        levelKey: "level",
        contourLayer: "contours",
      }),
    ],
    maxzoom: 15,
  });
}

function addContourLayers(map: MapLibreMap, before?: string): void {
  if (map.getLayer("contour-lines")) return;
  map.addLayer(
    {
      id: "contour-lines",
      type: "line",
      source: CONTOUR_SOURCE_ID,
      "source-layer": "contours",
      minzoom: 10,
      paint: {
        "line-color": "rgba(90,86,80,0.35)",
        // `level` is 1 on a major contour — the only thing separating the
        // index lines from the rest
        "line-width": ["match", ["get", "level"], 1, 1, 0.5],
      },
    },
    before,
  );
}

/**
 * Build the terrain mesh the moment the camera starts to tilt, once.
 *
 * `pitchstart` fires before the pitch actually moves, so the mesh is in place
 * by the time there is anything to see. The map is created at `pitch: 0`, so on
 * a map nobody tilts this never runs at all.
 */
function attachTerrainOnPitch(map: MapLibreMap): void {
  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    map.setTerrain({ source: DEM_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });
    // Without a sky, tilting shows the page background above the horizon. There
    // is no `sky` LAYER in MapLibre — it is a root-level object.
    map.setSky({
      "sky-color": "#c8d4e3",
      "horizon-color": "#f6f3ee",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.6,
    });
    map.off("pitchstart", attach);
  };
  if (map.getPitch() > 0) attach();
  else map.on("pitchstart", attach);
}

/**
 * Put elevation on a loaded map. Never throws: terrain is atmosphere, so a DEM
 * that will not load must cost the trip its hillshade, not its route.
 */
export async function addTerrain(map: MapLibreMap, lib: typeof import("maplibre-gl")): Promise<void> {
  try {
    const before = firstLineLayerId(map);
    addDemSource(map);
    addHillshade(map, before);

    if (TERRAIN_3D) attachTerrainOnPitch(map);

    await addContours(map, lib);
    addContourLayers(map, before);
  } catch {
    /* no elevation this time — the map, the route and the markers are unaffected */
  }
}
