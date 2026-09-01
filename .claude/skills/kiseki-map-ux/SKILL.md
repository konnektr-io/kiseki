---
name: kiseki-map-ux
description: How Kiseki designs and builds map surfaces — map-as-canvas layouts, bottom sheets with detents, the numbered marker system, route rendering, MapLibre GL JS v6 migration off Google Maps, and screen/print map parity. Use when touching MapView.tsx, lib/maps.ts, the static-map proxy, or any feature involving maps, routes, markers, locations, geo, discovery, or "make the map bigger/more prominent".
---

# Kiseki map UX

Rationale and the full picture: [`DESIGN.md`](../../../DESIGN.md) §2, §7, §8.

**The thesis:** place is the organizing fact of a trip, so the map should be a *surface*, not
a thumbnail. But Kiseki is also a printable booklet, and a booklet is document-shaped. Those
two facts don't merge — they coexist as separate surface classes.

**Cartographic principle:** *quiet basemap, loud trip.* The basemap is desaturated and
low-contrast; the trip's own color is the only saturated thing on screen.

## Current state (read before changing anything)

- `components/MapView.tsx` — Google Maps JS API. Terrain basemap, default markers labelled
  with the trip's ordinal, one `DirectionsService` call **per leg**, live traffic layer, a
  live drive-time chip for single-leg maps.
- `StaticMapImg` — server-proxied Google Static Maps (`/api/maps/static/<token>`), used in
  print so the API key never reaches the client.
- `TripMap` — switches between the two: JS on screen (`print:hidden`), static in print
  (`hidden print:block`). **Keep this dual-rendering contract through any migration.**
- `lib/maps.ts` — `findLocation` (name/alias resolution), `staticMapUrl`, `locatedPlaces`,
  `loadGoogleMaps`.
- Data: `trip.locations[{name, marker?, alias[], lat, lng}]` is the **single source** for all
  maps and all marker numbers. No per-trip hardcoding — never break this.

## The marker system is the trip's index

`trip.locations` numbers places ① ② ③, and those numbers appear on the map, in drive cards,
in directions pills, and in the booklet. **This is the app's strongest existing design
idea** — it's the through-line tying screen and paper together. Treat it as load-bearing.

Spec for the marker component (one component, every surface, plus print):

- Ordinal inside the pin. `--color-marker` fill, `--color-marker-fg` glyph, hairline outline
  so it reads on both snow and forest.
- **Stage-aware** (DESIGN.md §5.3): outline/dashed for `idea`/`options`/`shortlist`, solid
  muted for `planned`, filled `accent` for `booked`, `primary` for `live`, desaturated for
  `archive`. Provisional plans must *look* provisional.
- Visual ~28px, **hit target 44px** via transparent padding.
- Selected: scale 1.15 + accent ring. Off-focus day: 45% opacity — dimmed, never hidden.
- Cluster below the zoom where pins collide; clusters show a count, not a range.

## Route rendering

- **Draw every line twice.** A wide casing (~7px, contrast color) beneath a narrower body
  (~4px, `--color-route`). Without casing a route vanishes over similarly-colored roads.
  Highest-value cartographic trick available; do it from day one.
- Per mode: drive solid · train solid + dot pattern · ferry/flight dashed and drawn as a
  **great-circle arc**, not a straight screen-space line.
- Unbooked legs are dashed and lower-opacity regardless of mode.
- Route color comes from `--color-route` (per-trip). **`MapView.tsx` currently hardcodes
  `#1e3a8a`** — that's Canada 2027's primary, so every other trip draws Canada-blue routes.
  Fix when you're in that file.

## Layout: the map/content ratio ladder

Think in ratio, not breakpoints (DESIGN.md §7.2):

| Viewport | Map | Content |
|---|---|---|
| Phone portrait | full-bleed behind | **bottom sheet**, 3 detents |
| Phone landscape / small tablet | 100% | side sheet, left, ~340px |
| Tablet 768–1279 | ~60% right | ~40% left, scrolls |
| Desktop ≥1280 | fills remaining | fixed left rail 380–420px, rail scrolls, map doesn't |

Non-negotiables:

- **Exactly one scroll container** at a time. The map never scrolls the page.
- **The map's usable viewport is the part not covered by content.** Always pass `padding`
  to `fitBounds`/`easeTo` matching the sheet or rail occlusion. Forgetting this is the #1
  bug in map+sheet layouts — half the route ends up hidden under the sheet and it looks
  like the map is broken.
- `env(safe-area-inset-*)` on every fixed element; `100dvh` not `100vh`.

## The bottom sheet

Build it once as a real primitive **before** building any map surface on it.

- Three detents: **peek** ~15% (the "what am I looking at" line) · **half** ~50% (list) ·
  **full** ~90%.
- Visible drag handle — the affordance is not optional.
- Body scroll locks at `full`; a drag-down from `scrollTop === 0` returns to `half`.
- Snapping animates (200ms); dragging is 1:1 with the finger, unanimated.
- The map's `padding.bottom` updates with the detent.
- Escape / backdrop tap returns to `peek` — the sheet is the content, **not a modal**; it
  never fully dismisses.
- `prefers-reduced-motion` → instant detent change, no snap animation.

## Migrating to MapLibre GL JS v6

This is a design migration as much as a technical one: Google's basemap can't carry the
trip's identity, and per-load billing keeps the map rationed instead of prominent.

**Use the official MapLibre agent skills for the mechanics** rather than re-deriving them:

```bash
npx skills add maplibre/maplibre-agent-skills
```

Relevant ones: `maplibre-v6-migration`, `maplibre-tile-sources`, `maplibre-cartography`,
`maplibre-pmtiles-patterns`, `maplibre-terrain-rendering`, `maplibre-fonts-glyphs`.
(MIT, maintained by the MapLibre project.)

Kiseki-specific constraints for that migration:

- **v6 is ESM-only** — `import * as maplibregl from "maplibre-gl"`. No UMD.
- **WebGL2 is mandatory in v6** — detect and degrade to `StaticMapImg` rather than crashing.
- **Tiles are a separate decision from the renderer.** Hosted (MapTiler / Stadia) vs.
  self-hosted **PMTiles** — a single static file on Garage/the home cluster, no tile server,
  which fits this stack unusually well. Decide *before* styling.
- Wrapper: `react-maplibre` (visgl) for a reactive component model, or a thin hand-rolled
  hook given there's exactly one map component today. Decide once, in the migration PR.
- **Keep the routing data source question separate from the renderer.** Today's real driving
  routes come from Google Directions. MapLibre renders geometry; it does not route. Either
  keep Directions behind the existing backend proxy or move to Valhalla/OSRM — but don't
  bundle that decision into the render migration.
- **Sequence it as parity first**: same surfaces, same numbered markers, new renderer,
  colors from tokens. *Then* change the layout. Two changes at once and you won't know which
  one broke the booklet.

## Print parity — never skip

- A map surface's print form is a **static raster image** of the same view. Interactive maps
  never enter the PDF.
- `TripMap`'s `print:hidden` / `hidden print:block` split is the contract. Any new map
  component provides both halves or it isn't done.
- The static map must use the **same** marker numbering, route color, and basemap tone as
  the screen version, or the booklet stops looking like the app.
- The API key stays server-side (`/api/maps/static/...`). Never inline a key in the client
  for the print path.
- Google Static Maps has known quirks with styled markers and encoded polylines — those are
  documented in `AGENTS.md` and the `kiseki-trip-content` skill. Check there before
  debugging a print map.

## Accessibility on maps

A WebGL canvas is not accessible. Therefore:

- **Every map surface has a keyboard-reachable list equivalent** — it is the accessible
  path, not a fallback. On phones this is the sheet at `half`; on desktop it's the rail.
- Map controls (zoom, locate, layers) are real `<button>`s with `aria-label`s and ≥44px
  targets, not canvas-drawn.
- Attribution is a legal requirement — style it, never hide it.
- Loading state: the static map image or a themed skeleton. Never an empty grey box.

## Map surfaces worth building (in order)

1. **Trip route** — the whole journey, numbered markers, legs colored by stage. The
   flagship; replaces the current overview map feature.
2. **Day on map** — the active day's blocks pinned, other days dimmed to 45%. Pairs with
   `DayPage`.
3. **Discovery** — public trips / trips from people you follow, as clustered pins. This is a
   §2.2 map surface end-to-end; don't build it until the sheet and marker primitives exist.
4. **Things to do nearby** — POI search around a location, results in the sheet.

## Related
- Tokens, components, a11y floor → **`kiseki-design-system`**
- Per-trip map style and route colors → **`kiseki-trip-identity`**
