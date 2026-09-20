import { classifyTransportMode, type TransportMode } from "./transport";
import type { Block } from "./types";

/**
 * Transport glyphs on route legs (#357 slice 3B).
 *
 * The shapes and the classifier are BlockGlyph's (`components/blocks.tsx`,
 * `lib/transport.ts`): plane/train/ferry/car for the classified mode. The
 * OpenFreeMap styles ship no sprite sheet and we do not start hosting one,
 * so sprites are data-URI SVGs registered with `map.addImage`.
 *
 * Two rules are load-bearing:
 * - mode comes only from DATA (`Block.mode` + `classifyTransportMode`),
 *   never inferred from geometry;
 * - `road: true` stays authoritative: a road route is never dressed as a
 *   flight glyph, even if a block claims otherwise.
 */

/** A lucide icon node (tag + presentation attrs, no React `key`). */
export interface GlyphNode {
  tag: "path" | "circle" | "rect";
  attrs: Record<string, string>;
}

/**
 * The vector shapes behind BlockGlyph's Plane/Train/Ship/Car
 * (lucide-react v0.546.0 — `Train` is the `tram-front` alias). A jsdom suite
 * beside this file renders the four components and pins these nodes equal,
 * so the map glyphs cannot silently drift from the card glyphs.
 */
export const LEG_GLYPH_NODES: Record<TransportMode, GlyphNode[]> = {
  drive: [
    {
      tag: "path",
      attrs: {
        d: "M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2",
      },
    },
    { tag: "circle", attrs: { cx: "7", cy: "17", r: "2" } },
    { tag: "path", attrs: { d: "M9 17h6" } },
    { tag: "circle", attrs: { cx: "17", cy: "17", r: "2" } },
  ],
  train: [
    { tag: "rect", attrs: { width: "16", height: "16", x: "4", y: "3", rx: "2" } },
    { tag: "path", attrs: { d: "M4 11h16" } },
    { tag: "path", attrs: { d: "M12 3v8" } },
    { tag: "path", attrs: { d: "m8 19-2 3" } },
    { tag: "path", attrs: { d: "m18 22-2-3" } },
    { tag: "path", attrs: { d: "M8 15h.01" } },
    { tag: "path", attrs: { d: "M16 15h.01" } },
  ],
  flight: [
    {
      tag: "path",
      attrs: {
        d: "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
      },
    },
  ],
  ferry: [
    { tag: "path", attrs: { d: "M12 10.189V14" } },
    { tag: "path", attrs: { d: "M12 2v3" } },
    { tag: "path", attrs: { d: "M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6" } },
    {
      tag: "path",
      attrs: {
        d: "M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
      },
    },
  ],
};

/** Narrow an unknown mode value to the four glyph modes (data only). */
export function validGlyphMode(value: unknown): TransportMode | undefined {
  return value === "drive" || value === "train" || value === "flight" || value === "ferry"
    ? value
    : undefined;
}

/**
 * The glyph a leg draws, if any. Pure — pinned by test:
 * - no declared mode → no glyph;
 * - `road: true` + flight/ferry → no glyph (a road is never dressed
 *   as a flight; geometry never decides either way).
 */
export function legGlyphMode(opts: {
  road: boolean;
  mode: TransportMode | undefined | null;
}): TransportMode | null {
  const mode = opts.mode ?? null;
  if (mode == null) return null;
  if (opts.road && (mode === "flight" || mode === "ferry")) return null;
  return mode;
}

/**
 * The classified glyph mode for a transport block (`Block.mode` first,
 * then the shared drive/flight evidence classifier). Undefined keeps the
 * leg glyph-less — the pre-#88 default, never a guess from geometry.
 */
export function classifiedGlyphMode(block: Block | undefined): TransportMode | undefined {
  if (!block) return undefined;
  return classifyTransportMode(block);
}

/** Legs shorter than this draw no glyphs (arc-length, haversine km). */
export const GLYPH_MIN_LEG_KM = 15;

function haversineKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

/**
 * Where a leg's glyphs sit: ¼ and ¾ along the DRAWN coordinates by
 * arc length (so a great-circle arc carries them on the curve, not on the
 * chord). Short legs draw none. Pure — pinned by test.
 */
export function legGlyphPoints(
  coordinates: [number, number][],
  minLegKm = GLYPH_MIN_LEG_KM,
): [number, number][] {
  if (coordinates.length < 2) return [];
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const len = haversineKm(coordinates[i - 1], coordinates[i]);
    segs.push(len);
    total += len;
  }
  if (total < minLegKm) return [];
  const at = (fraction: number): [number, number] => {
    let target = total * fraction;
    for (let i = 1; i < coordinates.length; i++) {
      if (target <= segs[i - 1] || i === coordinates.length - 1) {
        const segLen = segs[i - 1] || 1;
        const f = Math.min(1, Math.max(0, target / segLen));
        const [ax, ay] = coordinates[i - 1];
        const [bx, by] = coordinates[i];
        return [ax + (bx - ax) * f, ay + (by - ay) * f];
      }
      target -= segs[i - 1];
    }
    return coordinates[coordinates.length - 1];
  };
  return [at(0.25), at(0.75)];
}

/** Registered sprite id for a mode. */
export function legGlyphImageId(mode: TransportMode): string {
  return `leg-glyph-${mode}`;
}

/** Sprite canvas, px — the icon draws the lucide 24-grid at 18px on it. */
export const LEG_GLYPH_SPRITE_PX = 28;

function glyphNodeSvg(node: GlyphNode): string {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<${node.tag} ${attrs}/>`;
}

/**
 * The sprite SVG: casing-colour chip + route-colour icon. Colours arrive as
 * strings from the token layer (`mapColors`) — no literal lives here.
 */
export function legGlyphSvg(mode: TransportMode, fg: string, bg: string): string {
  const inner = LEG_GLYPH_NODES[mode].map(glyphNodeSvg).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LEG_GLYPH_SPRITE_PX}" ` +
    `height="${LEG_GLYPH_SPRITE_PX}" viewBox="0 0 ${LEG_GLYPH_SPRITE_PX} ${LEG_GLYPH_SPRITE_PX}">` +
    `<circle cx="14" cy="14" r="12.5" fill="${bg}"/>` +
    `<g transform="translate(5,5) scale(0.75)" fill="none" stroke="${fg}" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`
  );
}

/** The structural surface `registerLegGlyphs` needs (MapLibre Map satisfies). */
export interface GlyphImageMap {
  hasImage(id: string): boolean | undefined;
  addImage(id: string, image: HTMLImageElement): void;
}

/**
 * Register the four transport sprites (browser-only — call inside effects).
 * Idempotent (`hasImage` guard); a mode whose image will not load is
 * skipped, never thrown — the route draws glyph-less rather than broken.
 * Returns the modes actually registered.
 */
export async function registerLegGlyphs(
  map: GlyphImageMap,
  colors: { route: string; routeCasing: string },
): Promise<TransportMode[]> {
  if (typeof Image === "undefined") return [];
  const modes: TransportMode[] = ["drive", "train", "flight", "ferry"];
  const done: TransportMode[] = [];
  for (const mode of modes) {
    const id = legGlyphImageId(mode);
    try {
      if (map.hasImage(id)) {
        done.push(mode);
        continue;
      }
      const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        legGlyphSvg(mode, colors.route, colors.routeCasing),
      )}`;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`glyph image failed: ${id}`));
        img.src = uri;
      });
      map.addImage(id, img);
      done.push(mode);
    } catch {
      continue;
    }
  }
  return done;
}

/** One drawable glyph: its mode + where it sits. */
export interface LegGlyphFeature {
  mode: TransportMode;
  coordinates: [number, number];
}

/** Symbol size for the glyph layer (sprite is 28px — this reads small). */
export const LEG_GLYPH_ICON_SIZE = 0.65;

/**
 * Add the glyph point source + symbol layer (above the route, below the
 * basemap's labels). No-op for an empty feature list — callers skip the
 * layer rather than drawing nothing.
 */
export function addLegGlyphLayer(
  map: {
    addSource(id: string, source: unknown): void;
    addLayer(layer: unknown, beforeId?: string): void;
  },
  sourceId: string,
  layerId: string,
  features: LegGlyphFeature[],
  beforeId?: string,
): void {
  if (!features.length) return;
  map.addSource(sourceId, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: features.map((f) => ({
        type: "Feature" as const,
        properties: { glyph: legGlyphImageId(f.mode) },
        geometry: { type: "Point" as const, coordinates: f.coordinates },
      })),
    },
  });
  map.addLayer(
    {
      id: layerId,
      type: "symbol",
      source: sourceId,
      layout: {
        "icon-image": ["get", "glyph"],
        "icon-size": LEG_GLYPH_ICON_SIZE,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    } as unknown as Parameters<import("maplibre-gl").Map["addLayer"]>[0],
    beforeId,
  );
}
