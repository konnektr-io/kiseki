---
name: kiseki-map-ux
description: How Kiseki designs and builds map surfaces — map-as-canvas layouts, bottom sheets with detents, the numbered marker system, route rendering, terrain, the MapLibre GL JS v6 stack, and screen/print map parity. Use when touching MapView.tsx, lib/maps.ts, lib/terrain.ts, the map proxies, or any feature involving maps, routes, markers, locations, geo, discovery, or "make the map bigger/more prominent".
---

# Kiseki map UX

Rationale and the full picture: [`DESIGN.md`](../../../DESIGN.md) §2, §7, §8.

**The thesis:** place is the organizing fact of a trip, so the map should be a *surface*, not
a thumbnail. But Kiseki is also a printable booklet, and a booklet is document-shaped. Those
two facts don't merge — they coexist as separate surface classes.

**Cartographic principle:** *quiet basemap, loud trip.* The basemap is desaturated and
low-contrast; the trip's own color is the only saturated thing on screen.

## Current state (read before changing anything)

The Google Maps JS migration is **done** (#18/#27, v0.14.0). Nothing in the browser talks to
Google any more.

- `components/MapView.tsx` — the CARD map (document surfaces + the booklet). MapLibre GL JS v6
  over keyless OpenFreeMap `positron` tiles: numbered DOM markers, cased routes, a live drive-time
  chip on single-leg maps. Fixed height, one shot, and the PDF renders through it — leave it alone
  unless you mean to change the booklet.
- `components/RouteMap.tsx` — the SURFACE map (#39). Fills its container, driven from outside by
  selection and camera padding, legs styled per state, never printed. Both share
  `lib/maplibre.ts` (`loadMapLibre` — `setWorkerUrl` must run exactly once, before the first
  `Map`) and `lib/maps.ts` (`CHROME_PADDING`, `clampPadding`, `prefersReducedMotion`).
- `components/Sheet.tsx` + `components/SplitView.tsx` + `lib/sheet.ts` — the sheet primitive and
  the ratio ladder. `lib/route-surface.ts` derives the journey: `tripJourney`, `journeyOrder`,
  `legStage`, `daysAtLocation`, `returnsToStart`, `dayRangeLabel`, `greatCircle`.
- Two map components is still hand-rolled imperative code by choice. `react-maplibre` (visgl) is
  the option if a THIRD surface makes it hurt.
- `lib/terrain.ts` — the shared `raster-dem` source (Mapterhorn), hillshade, runtime contours,
  and the `TERRAIN_3D` seam (#38).
- `StaticMapImg` — server-proxied Google Static Maps, still the print path. Retiring it is #37.
- `TripMap` — switches between the two: MapLibre on screen (`print:hidden`), static in print
  (`hidden print:block`). **This dual-rendering contract is the deal.** Any new map component
  provides both halves or it isn't done.
- `lib/maps.ts` — `findLocation` (name/alias), `staticMapUrl`, `locatedPlaces`, `markerNumber`,
  `fetchRouteLegs`, `hasWebGL2`, and `MAP_STYLE_URL`.
- Data: `trip.locations[{name, marker?, alias[], lat, lng}]` is the **single source** for all
  maps and all marker numbers. No per-trip hardcoding — never break this.

**The map proxies are the API key.** `/api/maps/route/{trip_param}` and
`/api/maps/static/{trip_param}` take a `$dtId` **or** a share token, shape-branched like
`GET /api/trips/{trip_param}`. Send the id: it is one graph read where a token costs two
(`find_trip_dtid_by_token` → `fetch_graph`), and a private trip has `token: ""` so the token
form cannot address one at all. Neither form is authenticated — a static map is an `<img>` and
an `<img>` cannot carry a bearer token — so the rate limiter in `app/ratelimit.py` is the
bound. **Never reintroduce a client-side Google key.**

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
  ⚠️ **Still NOT implemented for markers.** `Location` carries no `stage` field, so the only
  available stage is trip-level, which would restyle every marker on a trip identically. It
  needs either a derivation from the blocks referencing a location or a model change —
  parked on #40, which owns the model. Do not implement it as trip-level and call it done.
  **Legs do have it** (#39): `legStage` in `lib/route-surface.ts` reads the leg's own transport
  block `status` and only falls back to the trip stage when no block speaks for the leg. That
  fallback is honest for a leg (an `idea` trip's undescribed leg really is provisional) and
  dishonest for a marker (it would say the same thing about every place at once).
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
- Route color comes from `--color-route` (per-trip), read off the DOM by `lib/tokens.ts` —
  a canvas renderer takes color strings, not classes. The `#1e3a8a` leak is dead; **no hex
  literal belongs in map code**, ever. Markers avoid the problem entirely by being DOM
  elements: their fill is a Tailwind utility off `--color-marker`, so no color is written in
  JS at all.
- Layer order, top to bottom: **labels → route body → route casing → roads → contours →
  hillshade → landcover/water**. Insert by layer *type*, not id (`find(l => l.type === "line")`
  for elevation, `find(l => l.type === "symbol")` for the route) — hardcoded ids do not
  survive the style swap #40 will make.

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

**Built** — `components/Sheet.tsx`, geometry in `lib/sheet.ts`. Use it; don't hand-roll a second.

- Three detents: **peek** ~15% (the "what am I looking at" line) · **half** ~50% (list) ·
  **full** ~90%.
- Visible drag handle — the affordance is not optional.
- Body scroll locks at `full`; a drag-down from `scrollTop === 0` returns to `half`.
- Snapping animates (200ms); dragging is 1:1 with the finger, unanimated.
- The map's `padding.bottom` updates with the detent.
- Escape / backdrop tap returns to `peek` — the sheet is the content, **not a modal**; it
  never fully dismisses.
- `prefers-reduced-motion` → instant detent change, no snap animation.
- A finished drag still fires `click` on whatever it started on. Without a capture-phase swallow,
  a pull on the handle steps the detent again over the top of the snap, and a pull on a list row
  selects the place the user was only using as something to grab.
- A press on a control inside the sheet must NOT start a drag: capturing the pointer retargets
  that control's `click` to the capture element and the button simply never fires.

## Working on the MapLibre map

**Use the official MapLibre agent skills for the mechanics** rather than re-deriving them.
They are pinned in `skills-lock.json` and the vendored copies are gitignored, so restore with:

```bash
npx skills add maplibre/maplibre-agent-skills
```

Relevant ones: `maplibre-v6-migration`, `maplibre-source-wiring`, `maplibre-cartography`,
`maplibre-terrain-rendering`, `maplibre-tile-sources`, `maplibre-pmtiles-patterns`,
`maplibre-fonts-glyphs`. (MIT, maintained by the MapLibre project.)

### Traps that cost real time here

Each of these was paid for once. None of them raises an error.

- **v6 is ESM-only, with no default export** — `import * as maplibregl from "maplibre-gl"`.
- **Bundled builds need `setWorkerUrl()`**, and in Vite it must be `?worker&url`, *not*
  `?url`. Plain `?url` emits the worker without its sibling `maplibre-gl-shared.mjs`, so it
  dies on first import in production and **no vector tile ever loads** — while dev is fine.
- **MapLibre's own CSS out-specifies the obvious override.**
  `.maplibregl-ctrl button .maplibregl-ctrl-icon { width: 100% }` is (0,3,0). Matching that
  specificity and relying on bundle order silently loses. Prefix with
  `.maplibregl-ctrl.maplibregl-ctrl-group` (the element carries both classes) to win outright.
- **Every map is a WebGL context and browsers cap those around 16.** A continuous itinerary
  has a drive card per leg and the booklet renders every day at once — mounting eagerly
  exhausts the cap. Gate map creation on `IntersectionObserver`. Bonus: a `display:none`
  element never intersects, so the print path creates no contexts and pulls no tiles for free.
- **Attribution is not optional and MapLibre renders it *expanded*** (`maplibregl-compact-show`)
  even with `compact: true`. At phone width it wraps to two lines and covers the bottom strip
  of the map — which is why the zoom controls live top-**left**: top-right is the drive-time
  chip, and the whole bottom belongs to attribution. Style attribution; never hide it.
- **Pass `fitBounds` padding that matches your own chrome**, not just sheet occlusion
  (`CHROME_PADDING` in `MapView.tsx`). Without it a numbered marker lands underneath a zoom
  button and the map looks broken.
- **The 44px floor is about the hit target, not the paint.** A 44px *visible* control eats a
  quarter of a 192px-tall map. Put a small chip inside a transparent 44px button — the same
  trick the markers use. Targets are pointer-aware: 44px on `pointer: coarse`, 32px on
  `pointer: fine` (no pinch gesture exists for a mouse, and the relevant bar there is
  WCAG 2.5.8's 24×24, not the 44px touch guidance). Do not delete the buttons because
  "everyone pinches" — pinch is exactly the gesture a motor impairment rules out.
- **MapLibre loads via dynamic import** — ~1 MB of renderer most pages never need.

### Tiles and terrain

- **Basemap: OpenFreeMap `positron`**, keyless. One constant, `MAP_STYLE_URL`, overridable
  via `VITE_MAP_STYLE_URL` — that constant is the seam for per-trip styling (#40).
- **Self-hosted PMTiles on Garage was considered and deferred**, and the reason generalises:
  Kiseki is global by definition, so self-hosting means either the whole-planet archive or
  per-region extracts maintained forever, plus self-hosted glyphs and sprites. It stays the
  escape hatch if OpenFreeMap availability becomes a problem.
- **DEM: Mapterhorn**, terrarium, keyless. `DEM_MAXZOOM = 12` is a floor *we* chose — global
  Copernicus GLO-30 coverage genuinely stops there (verified: Sahara, Australian outback and
  Peruvian Andes all 404 at z13; BC reaches z15, Hokkaido z13). Capping upscales instead of
  punching holes over exactly the remote places a trip goes. Do not "fix" it upward.
- **`hillshade-method: igor`, not `multidirectional`.** Multidirectional is far more dramatic
  and buries the pale roads and labels a quiet basemap draws on top of it. Igor is built to
  minimise its effect on the features beneath. Render both at z8 over a mountain range before
  changing this.
- **Keep contour intervals coarser than the DEM's nominal resolution.** GLO-30 quantises hard
  over snowfields and glaciers; fine contours draw the terracing rather than the terrain.
- Terrain is atmosphere: `addTerrain` swallows its own failures and is never awaited. A DEM
  that will not load costs the trip its hillshade, not its route.
- **3D terrain attaches on `pitchstart`, not on load.** Hillshade is 2D shading — it does not
  extrude anything, so a map with beautiful relief still goes flat when you tilt it unless
  `setTerrain` has been called. Shipping 3D fully off was the wrong call: rotate and pitch are
  enabled by default, so the map invites a gesture and then ignores it. Attaching lazily costs
  the flat view nothing (a mesh at `pitch: 0` is invisible) and keeps the "no 3D by default on
  mobile" guardrail honest.
- **If you enable rotation, ship the way back.** `NavigationControl` needs
  `visualizePitch: true` for its compass to call `resetNorthPitch` instead of only
  `resetNorth`. Ours is hidden by CSS until the map is off north or pitched, so it costs no
  space on the view almost everyone sees.

### Google is server-side only

MapLibre renders geometry; **it does not route**. Real driving routes and the live
`duration_in_traffic` still come from Google Directions, and geocoding from Google Geocoding —
both behind `/api/maps/*` with the key in the backend.

- There is **no traffic layer**. `TrafficLayer` is exclusive to the Maps *JavaScript* API, so
  keeping it means keeping that API — and the key — in the browser. Traffic tiles from
  TomTom/HERE through our proxy is the option if anyone misses it.
- Google's **Map Tiles API is not a way around this**: a session token does not replace the
  key (every tile request carries both), and 2D tiles bill per tile rather than per map load.
- Moving routing to Valhalla/OSRM stays a separate decision from rendering.

## Print parity — never skip

- A map surface's print form is a **static raster image** of the same view. Interactive maps
  never enter the PDF.
- `TripMap`'s `print:hidden` / `hidden print:block` split is the contract. Any new map
  component provides both halves or it isn't done.
- The static map must use the **same** marker numbering, route color, and basemap tone as
  the screen version, or the booklet stops looking like the app.
- The API key stays server-side (`/api/maps/static/...`). Never inline a key in the client
  for the print path.
- `app/pdf.py` calls `page.emulate_media(media="print")` **before** navigating, not just at
  `page.pdf()`. That is what makes the loaded DOM the printed one, so the dynamic maps never
  mount during a render — no WebGL contexts, and no vector-tile traffic holding `networkidle`
  open.
- Google Static Maps has known quirks with styled markers and encoded polylines — those are
  documented in `AGENTS.md` and the `kiseki-trip-content` skill. Check there before
  debugging a print map.

## Accessibility on maps

A WebGL canvas is not accessible. Therefore:

- **Every map surface has a keyboard-reachable list equivalent** — it is the accessible
  path, not a fallback. On phones this is the sheet at `half`; on desktop it's the rail.
- Map controls (zoom, locate, layers) are real `<button>`s with `aria-label`s, not
  canvas-drawn. Targets are ≥44px on touch and ≥32px with a mouse — see the trap list above
  for why that split is deliberate, and why the buttons exist at all on a pinch-capable
  device.
- Attribution is a legal requirement — style it, never hide it.
- Loading state: the static map image or a themed skeleton. Never an empty grey box.

## Map surfaces worth building (in order)

1. ~~**Trip route**~~ — **shipped** (#39): `/t/<id>/map`. The whole journey, numbered markers,
   legs by state. It sits ALONGSIDE the overview's route card — #39 added a surface, it did not
   convert a document page.
2. **Day on map** — the active day's blocks pinned, other days dimmed to 45%. Pairs with
   `DayPage`.
3. **Discovery** — public trips / trips from people you follow, as clustered pins. This is a
   §2.2 map surface end-to-end; don't build it until the sheet and marker primitives exist.
4. **Things to do nearby** — POI search around a location, results in the sheet.

## Related
- Tokens, components, a11y floor → **`kiseki-design-system`**
- Per-trip map style and route colors → **`kiseki-trip-identity`**
