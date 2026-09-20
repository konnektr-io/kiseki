import type { Trip, TripLocation } from "./types";
import { presetById, type PresetBasemap, type PresetMapStyle } from "./theme-presets";

/**
 * The basemap style (#18 decision 2).
 *
 * OpenFreeMap `positron`: keyless, so nothing has to be proxied and there is no
 * credential in the bundle to leak (#27), and desaturated, which is exactly the
 * "quiet basemap, loud trip" floor in DESIGN.md §8.5 — the trip's own colour
 * stays the only saturated thing on screen.
 *
 * It is community-funded infrastructure with no SLA. Swapping it is deliberately
 * a one-line change: point VITE_MAP_STYLE_URL at a self-hosted PMTiles style on
 * Garage (or a hosted vendor) and nothing else in the app moves. Per-trip map
 * styling is #40 and lives in resolveMapStyle() below.
 */
export const MAP_STYLE_URL =
  import.meta.env.VITE_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/positron";

/**
 * Prebuilt OpenFreeMap styles a preset may name (#40 D2).
 *
 * Verified live 2026-09-11 against https://tiles.openfreemap.org/styles/:
 * positron, bright, liberty, dark and fiord all return 200 with the same
 * OpenMapTiles schema (source-layers include water/landcover/park/boundary,
 * which is what the runtime tint below keys on). The issue text warned that
 * swapping MAP_STYLE_URL at a different URL cannot work — right, because only
 * this fixed set exists; `basemap` density (positron minimal ↔ liberty dense)
 * is the per-trip knob, and anything beyond it is a full custom style JSON
 * via `styleUrl`.
 */
export const OPENFREEMAP_STYLES: Record<PresetBasemap, string> = {
  positron: "https://tiles.openfreemap.org/styles/positron",
  bright: "https://tiles.openfreemap.org/styles/bright",
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

function isBasemapKey(value: unknown): value is PresetBasemap {
  return typeof value === "string" && value in OPENFREEMAP_STYLES;
}

export interface ResolvedMapStyle {
  /** The style JSON URL to construct the map with. */
  styleUrl: string;
  /** Runtime tint of the base layers, applied after style load. */
  tint: PresetMapStyle["tint"];
  /** Terrain voice for lib/terrain.ts. */
  terrain: PresetMapStyle["terrain"];
}

/**
 * Which map a trip gets (#40, preset-only follow-up). Precedence, highest first:
 *
 * 1. `VITE_MAP_STYLE_URL` (deploy-level escape hatch — today's behaviour),
 * 2. the preset's own `styleUrl`,
 * 3. the preset's `basemap` → `OPENFREEMAP_STYLES`.
 *
 * Tint and terrain always come from the preset: an un-themed trip resolves to
 * exactly MAP_STYLE_URL with the default terrain, i.e. today's map. A legacy
 * `theme.mapStyle` lingering in a trip document has no effect.
 */
export function resolveMapStyle(trip: Trip): ResolvedMapStyle {
  const preset = presetById(trip.theme?.preset);
  const envUrl =
    typeof import.meta.env.VITE_MAP_STYLE_URL === "string" && import.meta.env.VITE_MAP_STYLE_URL !== ""
      ? import.meta.env.VITE_MAP_STYLE_URL
      : undefined;
  const basemap = isBasemapKey(preset.mapStyle.basemap) ? preset.mapStyle.basemap : "positron";
  return {
    styleUrl: envUrl ?? preset.mapStyle.styleUrl ?? OPENFREEMAP_STYLES[basemap],
    tint: preset.mapStyle.tint,
    terrain: preset.mapStyle.terrain,
  };
}

/** The style layers applyBasemapTint() may repaint — structural, so tests use fakes. */
export interface TintableStyleLayer {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
}

export interface TintableMap {
  getStyle(): { layers?: TintableStyleLayer[] };
  setPaintProperty(layerId: string, name: string, value: unknown): void;
}

/**
 * Runtime tint of the loaded basemap from the preset (#40 D2).
 *
 * This is what makes `nordic` near-monochrome and `archive` sepia WITHOUT
 * authoring our own style JSON and without hosting glyphs/sprites: the
 * prebuilt style's own colour layers are repainted from preset tokens.
 *
 * Guardrails: only colour layers (background fills, water/landcover/park
 * fills, boundary lines) — label/glyph (`symbol`) layers are never touched,
 * an absent layer is a no-op, and a layer that rejects the paint property is
 * skipped, never thrown. Route/marker colours are NOT set here; they arrive
 * via the --trip-route/--trip-marker tokens (tokens.ts).
 */
export function applyBasemapTint(map: TintableMap, tint: PresetMapStyle["tint"]): void {
  if (!tint) return;
  let layers: TintableStyleLayer[];
  try {
    layers = map.getStyle().layers ?? [];
  } catch {
    return;
  }
  const paint = (layerId: string, name: string, value: string) => {
    try {
      map.setPaintProperty(layerId, name, value);
    } catch {
      // A layer that rejects the property (type mismatch on a style we did
      // not author) keeps its own colour — tint is atmosphere, not content.
    }
  };
  for (const layer of layers) {
    if (layer.type === "symbol") continue; // labels and glyphs are untouchable
    try {
      if (layer.type === "background" && tint.background) {
        paint(layer.id, "background-color", tint.background);
      } else if (layer.type === "fill") {
        const sourceLayer = layer["source-layer"] ?? "";
        if (sourceLayer === "water" && tint.water) paint(layer.id, "fill-color", tint.water);
        else if (sourceLayer === "landcover" && tint.landcover)
          paint(layer.id, "fill-color", tint.landcover);
        else if (sourceLayer === "park" && tint.park) paint(layer.id, "fill-color", tint.park);
      } else if (
        layer.type === "line" &&
        (layer["source-layer"] ?? "") === "boundary" &&
        tint.boundary
      ) {
        paint(layer.id, "line-color", tint.boundary);
      }
    } catch {
      continue;
    }
  }
}

/**
 * The route line grammar, in ONE place (#357 slice 1).
 *
 * Every route line on every surface — `MapView` (screen AND the booklet, #37),
 * `RouteMap` (scan + day levels), `LandingMap` (the marketing example) and the
 * recorded-track layers that inherit the route weight (#193/#290) — reads its
 * widths from these stops. A hand-written `line-width` literal anywhere else
 * is drift; grep for `line-width` should show only these definitions and
 * references to them (plus the contour width in `lib/terrain.ts`, which is a
 * different grammar — relief shading, not the trip's line).
 *
 * Body: 2 → 2.5 → 3 → 4 px across zoom 0 → 4 → 8 → 12. At journey zoom the
 * route is lighter than the basemap's own road network; at day zoom it is a
 * deliberate line, not a hairline. Casing stays (it is what keeps the route
 * legible over same-coloured roads, §8.4) at ~1.6× the body, softening from
 * 0.9 to 0.55 opacity as the camera pulls out. Non-road legs (flights,
 * ferries — `road: false`) are 2 px at 0.35 opacity, dash [2, 3].
 */
export const ROUTE_WIDTH_STOPS: Array<[zoom: number, width: number]> = [
  [0, 2],
  [4, 2.5],
  [8, 3],
  [12, 4],
];

/** Casing width stops — ~1.6× the body at every zoom. */
export const ROUTE_CASING_WIDTH_STOPS: Array<[zoom: number, width: number]> = ROUTE_WIDTH_STOPS.map(
  ([zoom, width]) => [zoom, Math.round(width * 1.6 * 10) / 10] as [number, number],
);

/** Casing opacity fades 0.9 → 0.55 from zoom 0 to zoom 12. */
export const ROUTE_CASING_OPACITY_STOPS: Array<[zoom: number, opacity: number]> = [
  [0, 0.9],
  [12, 0.55],
];

/** Non-road (`road: false`) legs: thin, dim, dashed — never a road. */
export const ROUTE_NONROAD = {
  width: 2,
  opacity: 0.35,
  dasharray: [2, 3],
} as const;

/** Linear interpolation of a stop table at a zoom — the JS mirror of the
 *  MapLibre `interpolate` expressions below, so tests can pin the table
 *  without evaluating an expression. Clamped at both ends. */
export function interpolateStops(stops: Array<readonly [number, number]>, zoom: number): number {
  if (zoom <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (zoom <= stops[i][0]) {
      const [z0, v0] = stops[i - 1];
      const [z1, v1] = stops[i];
      return v0 + ((v1 - v0) * (zoom - z0)) / (z1 - z0);
    }
  }
  return stops[stops.length - 1][1];
}

/** The route body width at a zoom (JS mirror, pinned by test). */
export function routeWidthAtZoom(zoom: number): number {
  return interpolateStops(ROUTE_WIDTH_STOPS, zoom);
}

/** The route casing width at a zoom (JS mirror, pinned by test). */
export function routeCasingWidthAtZoom(zoom: number): number {
  return interpolateStops(ROUTE_CASING_WIDTH_STOPS, zoom);
}

/** The route casing opacity at a zoom (JS mirror, pinned by test). */
export function routeCasingOpacityAtZoom(zoom: number): number {
  return interpolateStops(ROUTE_CASING_OPACITY_STOPS, zoom);
}

function stopsToExpression(
  stops: Array<readonly [number, number]>,
): import("maplibre-gl").DataDrivenPropertyValueSpecification<number> {
  const args: (number | string)[] = [];
  for (const [zoom, value] of stops) args.push(zoom, value);
  return ["interpolate", ["linear"], ["zoom"], ...args] as import("maplibre-gl").DataDrivenPropertyValueSpecification<number>;
}

/** MapLibre `line-width` value for the route body — zoom interpolation. */
export const ROUTE_BODY_WIDTH = stopsToExpression(ROUTE_WIDTH_STOPS);

/** MapLibre `line-width` value for the route casing — ~1.6× the body. */
export const ROUTE_CASING_WIDTH = stopsToExpression(ROUTE_CASING_WIDTH_STOPS);

/** MapLibre `line-opacity` value for the route casing — 0.9 → 0.55. */
export const ROUTE_CASING_OPACITY = stopsToExpression(ROUTE_CASING_OPACITY_STOPS);

/** One leg of a route as the backend hands it over (see `app/maps.py:route_legs`). */
export interface RouteLeg {
  from: string;
  to: string;
  /** false = no road route (a flight/ferry leg) — drawn dashed, not solid. */
  road: boolean;
  /** Live `duration_in_traffic` text, e.g. "1 hour 35 mins". */
  duration: string | null;
  distance: string | null;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

/** Resolve a place name/alias to a location entry (case-insensitive). */
export function findLocation(trip: Trip, name: string): TripLocation | undefined {
  const n = name.trim().toLowerCase();
  return (trip.locations ?? []).find(
    (l) => l.name.toLowerCase() === n || (l.alias ?? []).some((a) => a.toLowerCase() === n),
  );
}

/** All trip locations with coords, in marker order. */
export function locatedPlaces(trip: Trip): TripLocation[] {
  return (trip.locations ?? []).filter((l) => l.lat != null && l.lng != null);
}

/**
 * The trip's own marker number for a location — position in `trip.locations`
 * unless `marker` overrides it.
 *
 * This is the through-line between map, drive cards, directions pills and the
 * booklet (DESIGN.md §8.3), so it is derived from the data in exactly one way.
 * `useLocationMarkers` in `blocks.tsx` renders the same number as a glyph.
 */
export function markerNumber(trip: Trip, loc: TripLocation): number {
  return loc.marker ?? (trip.locations ?? []).indexOf(loc) + 1;
}

/**
 * A location's stage, derived from the blocks that reference it — never
 * modelled (no `stage` on Location, no fourth place a stage can be set, #40
 * D6). Day blocks and section-level (unscheduled pool) blocks both speak;
 * a block references a location through `location`/`from`/`to`, matched by
 * name/alias exactly like the map does.
 *
 * Rule (mirrors `legStage` in route-surface.ts): a `booked`/`done` block
 * commits the place; an explicit `planned` softens it; a block with no
 * status says nothing (an idea trip's undescribed blocks are not a plan).
 * With no speaking block the trip stage answers — an idea trip's places
 * really are provisional, and a booked trip's are booked.
 */
export function locationStage(trip: Trip, loc: TripLocation): Trip["stage"] {
  const names = new Set([loc.name.toLowerCase(), ...(loc.alias ?? []).map((a) => a.toLowerCase())]);
  const refers = (value: string | undefined): boolean => {
    if (!value) return false;
    const target = findLocation(trip, value);
    return !!target && names.has(target.name.toLowerCase());
  };
  let planned = false;
  const blocks = [
    ...(trip.days ?? []).flatMap((d) => d.blocks ?? []),
    ...(trip.sections ?? []).flatMap((s) => s.blocks ?? []),
  ];
  for (const b of blocks) {
    if (!refers(b.location) && !refers(b.from) && !refers(b.to)) continue;
    if (b.status === "booked" || b.status === "done") return "booked";
    if (b.status === "planned") planned = true;
  }
  if (planned) return "planned";
  return trip.stage;
}

/**
 * The numbered pin's visual spec as a class map (DESIGN.md §8.3) —
 * outline/dashed while provisional, solid muted when planned, filled accent
 * once booked, primary while live, desaturated in the archive. Provisional
 * plans must LOOK provisional.
 *
 * One `<span>` of Tailwind classes, shared by MapView and RouteMap; the
 * booklet prints through MapView (#37), so print follows for free. Colours
 * stay utilities off tokens — no colour is written in JS. Booked/live keep
 * the long-standing filled pin byte-identical, so staged trips do not shift.
 *
 * Split out of `markerPinClass` so a caller with no trip can use the same
 * vocabulary: the signed-out landing page (#249) draws an example route and has
 * no document to derive a stage from, and a second copy of these classes is how
 * the landing's pin would quietly stop matching the app's.
 */
export function pinClassForStage(stage: Trip["stage"]): string {
  const base =
    "grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold leading-none shadow-card";
  switch (stage) {
    case "idea":
    case "options":
    case "shortlist":
      return `${base} border-2 border-dashed border-marker bg-surface text-marker`;
    case "planned":
      return `${base} border border-marker-fg/60 bg-marker/70 text-marker-fg`;
    case "booked":
    case "live":
      return `${base} border border-marker-fg bg-marker text-marker-fg`;
    case "archive":
      return `${base} border border-border bg-muted text-muted-foreground`;
  }
}

/** The pin a location gets: its stage (derived from the blocks that name it) fed
 *  through the one class map above. */
export function markerPinClass(trip: Trip, loc: TripLocation): string {
  return pinClassForStage(locationStage(trip, loc));
}

/**
 * Real driving route for a set of places, from the backend (#27).
 *
 * HERE Routing v8 still produces the geometry — MapLibre renders, it does not
 * route — but the call happens server-side (app/here.py, #15), so no credential
 * reaches the browser. Returns null when maps are unconfigured or the request
 * fails; callers degrade rather than blow up.
 */
export async function fetchRouteLegs(
  trip: Trip,
  places: string[],
  loop = false,
  signal?: AbortSignal,
  modes?: (string | null | undefined)[],
): Promise<RouteLeg[] | null> {
  if (!trip.id) return null;
  const resolvable = places.filter((p) => findLocation(trip, p));
  if (resolvable.length < 2) return null;
  // Per-leg transport declaration (parallel to `places`) — the backend skips
  // the HERE car query for flight/ferry legs instead of returning a road
  // route for a plane. Nulls/undefined ride along as empty slots so the
  // positions stay aligned.
  const modeParam = modes?.length
    ? `&modes=${encodeURIComponent(modes.map((m) => m ?? "").join(","))}`
    : "";
  const url = `/api/maps/route/${trip.id}?places=${encodeURIComponent(resolvable.join(","))}${modeParam}${loop ? "&loop=1" : ""}`;
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { legs?: RouteLeg[] };
    return data.legs ?? null;
  } catch {
    return null;
  }
}

/**
 * MapLibre GL JS v6 requires WebGL2 — there is no WebGL1 fallback, and creating
 * a Map without it throws. Detect up front and render a placeholder instead
 * (DESIGN.md §8.2). In the PDF render the map runs under SwiftShader — see
 * backend/app/pdf.py.
 */
export function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

/** The map camera's keep-out box, in CSS px. */
export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Keep-out for the map's own chrome (kiseki-map-ux: "the map's usable viewport
 * is the part not covered by content — always pass padding matching the
 * occlusion"). Extra on the left for the zoom chips, and on the bottom for the
 * attribution, which wraps to two lines at phone width — so a marker never
 * lands underneath either.
 *
 * Right/bottom also clear the marker's own extent: pins are 28px in a 44px hit
 * target anchored at the coordinate, so a marker center needs >= ~24px from
 * the container edge to render whole (44/2 + rounding) — 32px right was enough
 * in theory and clipped in practice under rounded corners, so the padding is
 * padded.
 */
export const CHROME_PADDING: MapPadding = { top: 36, right: 44, bottom: 52, left: 64 };

/**
 * Shrink padding until it leaves a usable viewport.
 *
 * Content occlusion is real padding — a sheet at `full` covers 90% of the
 * surface — but padding wider than the container leaves `fitBounds` no box to
 * fit into and it silently gives up (or frames nothing). Squeeze the two
 * opposing sides proportionally instead, so the camera still leans away from
 * the content and always has `min` px to work with.
 */
export function clampPadding(
  padding: MapPadding,
  width: number,
  height: number,
  min = 96,
): MapPadding {
  const squeeze = (a: number, b: number, extent: number): [number, number] => {
    const room = extent - min;
    if (room <= 0) return [0, 0];
    const total = a + b;
    if (total <= room) return [a, b];
    const k = room / total;
    return [Math.floor(a * k), Math.floor(b * k)];
  };
  const [left, right] = squeeze(padding.left, padding.right, width);
  const [top, bottom] = squeeze(padding.top, padding.bottom, height);
  return { top, right, bottom, left };
}

/** `prefers-reduced-motion` — a JS-driven camera has to check it itself (§10). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
