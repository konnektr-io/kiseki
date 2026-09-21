import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTrip } from "./theme";
import {
  applyBasemapTint,
  fetchRouteLegs,
  findLocation,
  formatMapLabel,
  hasWebGL2,
  locatedPlaces,
  makeMapLabelElement,
  mapFitPadding,
  MAP_LABEL_PIN_OFFSET_PX,
  MAP_LABEL_ZOOM_FLOOR,
  markerNumber,
  markerPinClass,
  pinScaleAtZoom,
  resolveMapStyle,
  ROUTE_BODY_WIDTH,
  ROUTE_CASING_OPACITY,
  ROUTE_CASING_WIDTH,
  ROUTE_NONROAD,
  selectMapLabels,
} from "../lib/maps";
import { loadMapLibre } from "../lib/maplibre";
import { fetchTrack, trackDataUrl, trackSegments, type TrackSegment } from "../lib/tracks";
import { legBlock, legModes, resolveLegCoordinates } from "../lib/route-surface";
import {
  addLegGlyphLayer,
  classifiedGlyphMode,
  legGlyphMode,
  legGlyphPoints,
  registerLegGlyphs,
  validGlyphMode,
  type LegGlyphFeature,
} from "../lib/leg-glyphs";
import { addTerrain } from "../lib/terrain";
import { applyOverviewGlobe, shouldUseGlobe } from "../lib/globe";
import { mapColors } from "../lib/tokens";
import { Floating } from "./ui";

interface MapViewProps {
  places: string[];
  loop?: boolean;
  className?: string;
  showLiveTime?: boolean;
  /** Compact thumbnail (h-24) for block card media — single pin, minimal chrome. */
  compact?: boolean;
  /** Recorded GPX tracks (#193) — canonical /media URLs (or bare names that
   *  resolve through the same mapping). Drawn as cased lines in the trip
   *  route colour and included in the framed extent. */
  tracks?: string[];
  /** Overview globe (#361 slice 3): the whole-trip feature map renders with
   *  `setProjection({ type: "globe" })`. Screen-only by construction — the
   *  booklet PDF (`isPdfRender`) and compact card minimaps stay Mercator even
   *  when this is set. Only the overview feature map passes it. */
  globe?: boolean;
}

/**
 * Dynamic map (MapLibre GL JS v6, #18): numbered markers + the REAL driving
 * route, and — for two-place legs — a live drive-time chip.
 *
 * Nothing here talks to Google (#27). The basemap comes from keyless tiles and
 * the route geometry comes from our own backend, which calls Directions with
 * the key server-side. There is no traffic layer any more: `TrafficLayer` is
 * exclusive to the Google JS API, and keeping that API loaded is precisely what
 * kept the key visible in devtools.
 *
 * One renderer for screen and print (#37): TripMap is now a thin wrapper
 * around this component. The booklet PDF renders the SAME map live via
 * Playwright+SwiftShader, so screen and paper share basemap/markers/routes.
 */
export function MapView({ places, loop = false, className = "", showLiveTime = true, compact = false, tracks = [], globe = false }: MapViewProps) {
  const trip = useTrip();
  const ref = useRef<HTMLDivElement>(null);
  // v6 dropped the WebGL1 fallback entirely, so this is a hard gate, not a
  // preference — without WebGL2 the constructor throws (DESIGN.md §8.2).
  const [webgl2] = useState(hasWebGL2);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [liveTime, setLiveTime] = useState<string | null>(null);
  const [mapLoadFailed, setMapLoadFailed] = useState(false);
  // Every MapLibre map is a WebGL context and browsers cap those around 16, so
  // a map may not exist until it is actually on screen. A continuous itinerary
  // has one drive card per leg and the booklet renders EVERY day at once —
  // mounting eagerly would exhaust the cap on both.
  // For the booklet PDF the render must be eager (#37): every map on the page
  // has to mount even though most are below the fold, and `display:none` is no
  // longer used. `window.__KISEKI_PDF_RENDER__` is set before the app loads
  // (backend/app/pdf.py) so the observer is bypassed in that mode.
  const isPdfRender =
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__KISEKI_PDF_RENDER__ === true;
  const [onScreen, setOnScreen] = useState(
    isPdfRender || typeof IntersectionObserver === "undefined"
  );
  // `places`/`tracks` are built inline by callers, so their identity changes
  // every render — key the effect on the contents instead of the arrays.
  const placesKey = places.join("|");
  const tracksKey = tracks.join("|");

  useEffect(() => {
    if (onScreen || isPdfRender || typeof IntersectionObserver === "undefined") return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOnScreen(true);
          io.disconnect();
        }
      },
      // Start loading just before it scrolls in, so the map is ready on arrival.
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onScreen, isPdfRender]);

  useEffect(() => {
    if (!webgl2 || !onScreen) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    const abort = new AbortController();

    const located = places
      .map((p) => findLocation(trip, p))
      .filter((l): l is NonNullable<typeof l> => !!l && l.lat != null && l.lng != null);
    if (located.length < 1 && tracks.length < 1) {
      // No resolvable place and no track — mark as failed so the PDF does not wait forever
      if (ref.current) ref.current.dataset.mapFailed = "true";
      return;
    }

    (async () => {
      try {
        const lib = await loadMapLibre();
        if (cancelled || !ref.current) return;

        // Route colours come from the token layer, resolved against the element
        // so they carry THIS trip's identity (DESIGN.md §8.4). A hex literal
        // here is how every trip ended up drawing Canada-blue routes.
        const colors = mapColors(ref.current);

        // The preset's map voice (#40): basemap density + tint + terrain.
        // Un-themed trips resolve to exactly MAP_STYLE_URL + default terrain.
        const mapStyle = resolveMapStyle(trip);

        // Single-pin thumbnail (hotel/restaurant card) — centered, zoom 13 like
        // the old Static Maps single-place proxy; multi-pin uses fitBounds.
        // A track-only map (no pins at all) starts on the whole world and the
        // track fit below takes over once its geometry lands.
        const single = located.length === 1;
        const bounds = new lib.LngLatBounds();
        located.forEach((l) => bounds.extend([l.lng!, l.lat!]));

        // The construction fit and every later re-fit share ONE container-aware
        // padding (#368): the surface's chrome budget is larger than a card
        // minimap's box, which left `fitBounds` nothing to fit into and
        // silently abandoned the camera — the booklet's pin-only minimaps.
        const fitPadding = () => {
          const el = ref.current;
          return mapFitPadding(el?.clientWidth || 320, el?.clientHeight || 240);
        };
        const mapOpts: ConstructorParameters<typeof lib.Map>[0] = {
          container: ref.current,
          style: mapStyle.styleUrl,
          attributionControl: { compact: true },
        };
        if (single) {
          (mapOpts as Record<string, unknown>).center = [located[0].lng!, located[0].lat!];
          (mapOpts as Record<string, unknown>).zoom = 13;
        } else if (located.length > 1) {
          (mapOpts as Record<string, unknown>).bounds = bounds;
          (mapOpts as Record<string, unknown>).fitBoundsOptions = { padding: fitPadding(), maxZoom: 12 };
        } else {
          (mapOpts as Record<string, unknown>).center = [0, 0];
          (mapOpts as Record<string, unknown>).zoom = 1;
        }

        map = new lib.Map(mapOpts);
        // Zoom-scaled pins (#357 slice 2): the visible dot shrinks toward
        // ~22px at journey zoom through --pin-scale; the 44px hit target
        // never moves. Below the collision zoom the label layer drops
        // (pins stay, labels go).
        const syncZoom = () => {
          if (!map || !ref.current) return;
          const z = map.getZoom() ?? 0;
          ref.current.style.setProperty("--pin-scale", String(pinScaleAtZoom(z)));
          ref.current.classList.toggle("map-labels-off", z < MAP_LABEL_ZOOM_FLOOR);
        };
        map.on("zoom", syncZoom);
        syncZoom();
        // Compact thumbnails don't need the full nav chrome — keep it for
        // regular route maps.
        if (!compact) {
          map.addControl(
            new lib.NavigationControl({ showCompass: true, visualizePitch: true }),
            "top-left",
          );

          // ...but a third permanent chip on a 192px map is chrome nobody asked
          // for, so the compass only appears once the map is off north or tilted
          // (index.css keys off this class).
          const syncOriented = () => {
            if (!map || !ref.current) return;
            ref.current.classList.toggle("map-oriented", map.getBearing() !== 0 || map.getPitch() !== 0);
          };
          map.on("rotate", syncOriented);
          map.on("pitch", syncOriented);
        }

        // Tiles or style unreachable → show placeholder (DESIGN.md §8.5). For the
        // booklet PDF the placeholder still exposes data-map-failed so pdf.py
        // does not block forever waiting for idle.
        map.on("error", () => {
          if (!cancelled && !map?.loaded()) {
            if (ref.current) ref.current.dataset.mapFailed = "true";
            setMapLoadFailed(true);
            setFailed(true);
          }
        });

        located.forEach((l) => {
          const n = markerNumber(trip, l);
          const el = document.createElement("div");
          // 44px hit target around a ~28px pin (DESIGN.md §8.3). Colours are
          // Tailwind utilities off --color-marker / --color-marker-fg, so the
          // pin is per-trip for free and no colour is written in JS at all.
          // Compact thumbnails keep the same pin but the container is shorter —
          // the hit target still applies for touch.
          el.className = "route-pin grid h-11 w-11 place-items-center";
          el.setAttribute("aria-hidden", "true");
          el.title = l.name;
          const pin = document.createElement("span");
          // Stage-aware pin (DESIGN.md §8.3): one class map in lib/maps.ts, so
          // the card maps, the surface and the booklet (#37, same component)
          // cannot drift apart. No colour is written in JS. `route-pin-dot`
          // puts it under the zoom-scaled pin grammar (.map-pin-scaled on the
          // container) — MapView has no selection/dimming, so only the scale
          // applies here.
          pin.className = `route-pin-dot ${markerPinClass(trip, l)}`;
          pin.textContent = String(n);
          el.appendChild(pin);
          new lib.Marker({ element: el }).setLngLat([l.lng!, l.lat!]).addTo(map!);
        });

        // Wait for style to load before adding sources/layers
        await new Promise<void>((resolve) => {
          if (map!.loaded()) resolve();
          else map!.once("load", () => resolve());
        });
        if (cancelled || !map) return;

        // Preset tint of the base layers (#40 D2) — repaint, never re-author.
        applyBasemapTint(map, mapStyle.tint);

        // Overview globe (#361 slice 3): the whole-trip feature map renders
        // on a globe — screen-only by construction, gated off isPdfRender the
        // way the camera already is (SwiftShader + globe shaders is a new
        // failure mode the booklet must never see) and off compact card
        // minimaps. Day/leg maps never pass `globe` at all.
        if (shouldUseGlobe({ globe, isPdfRender, compact })) {
          applyOverviewGlobe(map, ref.current);
        }

        // Elevation first, so the route and markers added below land ON TOP of
        // the hillshade rather than under it (#38). Deliberately not awaited
        // for the route's sake — a slow DEM must not hold up the line the map
        // exists to draw.
        void addTerrain(map, lib, mapStyle.terrain);

        // On-map labels (#357 slice 2): numbered pills below their pins, in
        // our own vocabulary. Single-pin thumbnails skip them (the card names
        // the place). The drive-time chip below is DOM chrome above the
        // canvas, so a label can never cover it; labels are
        // pointer-events-none and never intercept.
        const labelMarkers: import("maplibre-gl").Marker[] = [];
        // #361 slice 2: the overview names its places without a tap — the
        // capped top-8 layer is rebuilt every time the camera settles, not
        // just once at init (the post-fetch refit settles at a different
        // zoom than the init build measured).
        const rebuildLabels = () => {
          if (cancelled || !map || single || compact) return;
          for (const m of labelMarkers) m.remove();
          labelMarkers.length = 0;
          const names = selectMapLabels(
            located.map((l) => l.name),
            null,
            map.getZoom() ?? 0,
          );
          for (const name of names) {
            const loc = located.find((l) => l.name === name);
            if (!loc) continue;
            const el = makeMapLabelElement(formatMapLabel(markerNumber(trip, loc), loc.name));
            labelMarkers.push(
              new lib.Marker({
                element: el,
                anchor: "top",
                offset: [0, MAP_LABEL_PIN_OFFSET_PX] as [number, number],
              })
                .setLngLat([loc.lng!, loc.lat!])
                .addTo(map),
            );
          }
        };
        // `moveend` is the settle signal: it fires after pans AND zooms
        // (including the refit below), so the zoom-only listener it replaces
        // loses nothing.
        map.on("moveend", rebuildLabels);
        rebuildLabels();

        // Fetch route geometry for multi-pin maps (skip for single-pin thumbnail)
        // and every recorded track in parallel — a failed track fetch degrades
        // to no line (the card's download link stays), never a broken map.
        let legs: Awaited<ReturnType<typeof fetchRouteLegs>> = null;
        let trackSegs: TrackSegment[] = [];
        {
          const trackUrls = tracks
            .map((t) => trackDataUrl(t))
            .filter((u): u is string => u != null);
          const [fetchedLegs, ...fetchedTracks] = await Promise.all([
            !single && located.length > 1
              ? fetchRouteLegs(trip, places, loop, abort.signal, legModes(trip, places, loop))
              : Promise.resolve(null),
            ...trackUrls.map((u) => fetchTrack(u, abort.signal).catch(() => null)),
          ]);
          legs = fetchedLegs;
          trackSegs = fetchedTracks
            .filter((f): f is NonNullable<typeof f> => f != null)
            .flatMap((f) => trackSegments(f));
        }
        if (cancelled || !map) return;

        // Re-fit the camera AFTER load on the map's real, settled container.
        // A fitBounds baked into the constructor options runs against whatever
        // size the container had at construction — in the booklet PDF all maps
        // mount eagerly and MapLibre may have measured a fallback 640×300
        // before layout/fonts settled, leaving edge markers parked half under
        // the chrome padding once the real width lands (#37).
        //
        // Every fit uses the container-aware padding (#368): `CHROME_PADDING`
        // is the map SURFACE's chrome budget, and a card minimap (670×94) is
        // smaller than that budget — which left `fitBounds` a negative box,
        // `cameraForBounds` null, and the camera stuck wherever it was built.
        // On a recorded-track card the GPX line was drawn all along, just
        // ~0.3px wide inside the pin: the booklet's "pin + basemap, no line".
        const refit = (includeRoute: boolean) => {
          const full = new lib.LngLatBounds();
          located.forEach((l) => full.extend([l.lng!, l.lat!]));
          if (includeRoute && legs) {
            legs.forEach((leg) => resolveLegCoordinates(leg).forEach((c) => full.extend(c)));
          }
          // The day's extent INCLUDES the track (#193, #290) — a traverse
          // swings well outside its pins, exactly like a road route does, and
          // the lift legs are part of the day's shape too.
          trackSegs.forEach((segment) => segment.coordinates.forEach((c) => full.extend(c)));
          // Every geometry source missed (failed fetches, unresolvable pins):
          // nothing to frame — leave the construction camera alone rather
          // than fitting an empty bounds (which throws).
          if (full.isEmpty()) return;
          const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          // PDF (#37): never animate the camera — the renderer snapshots on
          // `idle` shortly after, and a mid-flight fitBounds parks edge markers
          // half-clipped at the container borders (seen on booklet pages 10/14:
          // marker ③/⑤ cut by the right edge, route running off-frame).
          // `animate: false` also makes the camera update SYNCHRONOUS, so the
          // frame the PDF captures is already the fitted one (#368).
          map!.fitBounds(full, {
            padding: fitPadding(),
            maxZoom: 12,
            animate: !reduceMotion && !isPdfRender,
            duration: 500,
          });
        };

        if (legs?.length) {
          // Non-road legs draw the §8.4 great-circle arc, never the straight
          // screen-space line the backend ships (#357 slice 3A).
          const features = legs.map((leg) => ({
            type: "Feature" as const,
            properties: { road: leg.road },
            geometry: {
              type: "LineString" as const,
              coordinates: resolveLegCoordinates(leg),
            },
          }));
          map.addSource("route", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features,
            },
          });

          // Draw the route UNDER the basemap's labels, so place names stay
          // readable across it (DESIGN.md §8.5).
          const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
          const road: import("maplibre-gl").FilterSpecification = ["==", ["get", "road"], true];

          // Every line twice: a wide casing under a narrower body, or the route
          // vanishes over roads of a similar colour (DESIGN.md §8.4). This is the
          // single highest-value cartographic trick available.
          map.addLayer(
            {
              id: "route-casing",
              type: "line",
              source: "route",
              filter: road,
              layout: { "line-cap": "round", "line-join": "round" },
              paint: { "line-color": colors.routeCasing, "line-width": ROUTE_CASING_WIDTH, "line-opacity": ROUTE_CASING_OPACITY },
            },
            firstSymbol,
          );
          map.addLayer(
            {
              id: "route-body",
              type: "line",
              source: "route",
              filter: road,
              layout: { "line-cap": "round", "line-join": "round" },
              paint: { "line-color": colors.route, "line-width": ROUTE_BODY_WIDTH },
            },
            firstSymbol,
          );
          // A leg with no road route (a flight/ferry) keeps the route colour but
          // goes dashed and dimmer — the trip's vocabulary for "not a road leg".
          map.addLayer(
            {
              id: "route-nonroad",
              type: "line",
              source: "route",
              filter: ["!", road],
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": colors.route,
                "line-width": ROUTE_NONROAD.width,
                "line-opacity": ROUTE_NONROAD.opacity,
                "line-dasharray": [...ROUTE_NONROAD.dasharray],
              },
            },
            firstSymbol,
          );

          // Re-frame on the real geometry: a road route swings well outside the
          // straight line between two pins.
          refit(true);

          if (legs.length === 1 && showLiveTime && legs[0].duration) setLiveTime(legs[0].duration);

          // Transport glyphs (#357 slice 3B): plane/train/ferry/car at ¼+¾
          // of each declared leg, from the SAME sprites both surfaces share.
          // Mode is data-only (the leg's transport block classified, else the
          // echoed mode); a road leg never wears a flight glyph. Registered
          // BEFORE the idle handshake below so the booklet (#37) waits for
          // the glyph layer like every other layer.
          const glyphFeatures: LegGlyphFeature[] = legs.flatMap((leg) => {
            const fromLoc = findLocation(trip, leg.from);
            const toLoc = findLocation(trip, leg.to);
            const block = fromLoc && toLoc ? legBlock(trip, fromLoc, toLoc) : undefined;
            const glyph = legGlyphMode({
              road: leg.road,
              mode: block ? classifiedGlyphMode(block) : validGlyphMode(leg.mode),
            });
            if (!glyph) return [];
            return legGlyphPoints(resolveLegCoordinates(leg)).map((coordinates) => ({
              mode: glyph,
              coordinates,
            }));
          });
          if (glyphFeatures.length) {
            try {
              await registerLegGlyphs(map, colors);
              addLegGlyphLayer(map, "route-glyphs", "route-glyphs", glyphFeatures, firstSymbol);
            } catch {
              // A glyph-less route, never a broken map.
            }
          }
        } else if (!single) {
          // Multi-pin with no route geometry (route fetch failed or map source
          // unconfigured): still re-fit on the settled container so markers
          // stay clear of the chrome padding.
          refit(false);
        }

        if (trackSegs.length) {
          map.addSource("tracks", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: trackSegs.map((segment) => ({
                type: "Feature" as const,
                properties: { lift: segment.type === "lift" },
                geometry: { type: "LineString" as const, coordinates: segment.coordinates },
              })),
            },
          });
          // A recorded track is the shape of the day, not a proposal: solid,
          // full-strength, cased exactly like the route (§8.4) — under the
          // basemap's labels with everything else the trip draws. #290: the
          // lift legs draw dashed and lighter, so a day reads as runs + lifts
          // rather than as one long run. Casing before body, always.
          const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
          const ride: import("maplibre-gl").FilterSpecification = ["!", ["get", "lift"]];
          const lift: import("maplibre-gl").FilterSpecification = ["get", "lift"];
          const trackLayers: Array<{
            id: string;
            filter: import("maplibre-gl").FilterSpecification;
            body: boolean;
            dashed: boolean;
          }> = [
            { id: "track-casing", filter: ride, body: false, dashed: false },
            { id: "track-lift-casing", filter: lift, body: false, dashed: true },
            { id: "track-body", filter: ride, body: true, dashed: false },
            { id: "track-lift-body", filter: lift, body: true, dashed: true },
          ];
          for (const layer of trackLayers) {
            map.addLayer(
              {
                id: layer.id,
                type: "line",
                source: "tracks",
                filter: layer.filter,
                layout: {
                  "line-cap": layer.dashed ? "butt" : "round",
                  "line-join": "round",
                },
                paint: layer.body
                  ? {
                      "line-color": colors.route,
                      "line-width": ROUTE_BODY_WIDTH,
                      "line-opacity": layer.dashed ? 0.75 : 1,
                      ...(layer.dashed ? { "line-dasharray": [2, 2.2] } : {}),
                    }
                  : {
                      "line-color": colors.routeCasing,
                      "line-width": ROUTE_CASING_WIDTH,
                      "line-opacity": layer.dashed ? 0.6 : 0.9,
                      ...(layer.dashed ? { "line-dasharray": [2, 2.2] } : {}),
                    },
              },
              firstSymbol,
            );
          }
          // Frame the track even when no other geometry reframed above
          // (single-pin card, or a track-only map with no pins at all).
          refit(true);
        }

        // Signal ready/idle for the PDF renderer (#37): the booklet waits for
        // every [data-maplibre] element to be ready or failed before printing.
        // `load` is not enough — tiles are still in flight — so wait for `idle`.
        const markReady = () => {
          if (ref.current) ref.current.dataset.mapReady = "true";
          setReady(true);
        };
        if (map.loaded() && map.areTilesLoaded() && map.isStyleLoaded()) {
          // Already idle (e.g. single-pin with no route fetch)
          // give raster tiles a frame to paint
          map.once("idle", markReady);
          // Fallback: if already idle, MapLibre may not fire idle again. In PDF
          // mode this must be generous — a route fitBounds above may still be
          // settling and a 300ms shortcut snapshots a mid-flight camera
          // (clipped edge markers, #37). Give the fit its full settle budget.
          setTimeout(() => {
            if (ref.current?.dataset.mapReady !== "true") markReady();
          }, isPdfRender ? 1500 : 300);
        } else {
          map.once("idle", markReady);
          // Safety: never block the PDF forever on a stalled tile/DEM source
          setTimeout(() => {
            if (ref.current?.dataset.mapReady !== "true" && ref.current?.dataset.mapFailed !== "true") {
              markReady();
            }
          }, isPdfRender ? 9000 : 6000);
        }
      } catch {
        if (!cancelled) {
          if (ref.current) ref.current.dataset.mapFailed = "true";
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      map?.remove();
    };
  }, [trip, placesKey, tracksKey, loop, showLiveTime, webgl2, onScreen, isPdfRender, compact, globe]);

  // No WebGL2 or tile/style load failure: placeholder so the page never has an
  // empty grey box and the PDF waiter can resolve via data-map-failed.
  if (!webgl2 || failed) {
    return (
      <div
        data-maplibre
        data-map-failed="true"
        role="img"
        aria-label={mapLoadFailed ? "Map failed to load" : "Map requires WebGL2"}
        className={`grid h-48 w-full place-items-center rounded-lg border border-border bg-muted text-xs text-muted-foreground md:h-56 ${className}`}
      >
        {mapLoadFailed ? "Map unavailable" : "Map requires WebGL2"}
      </div>
    );
  }

  // Single-pin thumbnails are shorter (h-24) and live inside a card's overflow-hidden wrapper
  const heightClass = compact ? "h-24 w-full" : "h-48 w-full md:h-56";
  return (
    <div className={`relative ${className}`}>
      <div
        ref={ref}
        data-maplibre
        role="img"
        aria-label={`Map of the route: ${places.join(" to ")}`}
        className={`map-pin-scaled ${heightClass} overflow-hidden rounded-lg border border-border`}
      />
      {!ready && (
        // Themed skeleton while the style loads (DESIGN.md §8.5).
        <div className="pointer-events-none absolute inset-0 animate-pulse rounded-lg bg-muted" />
      )}
      {liveTime && (
        // Sits over the map, so it takes the floating recipe (DESIGN.md §2.4)
        // rather than the shadow-only chip it used to be.
        <Floating
          className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums text-foreground"
          aria-live="polite"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />≈ {liveTime} · live
        </Floating>
      )}
    </div>
  );
}

/**
 * One map for every context — screen and booklet (#37).
 *
 * Before #37 this switched between MapLibre on screen and a Google Static
 * Maps proxy in print (`print:hidden` / `hidden print:block`). That split is
 * gone: the booklet now renders the SAME MapLibre map live via
 * Playwright+SwiftShader, so basemap / markers / route colours are identical.
 * This component is intentionally thin — it just validates there is something
 * to show and forwards to MapView.
 */
export function TripMap({ places, loop = false, tracks, globe = false }: { places: string[]; loop?: boolean; tracks?: string[]; globe?: boolean }) {
  const trip = useTrip();
  const all = locatedPlaces(trip);
  if (all.length < 1) return null;
  // Route maps need at least one resolvable place in `places`; TripMap callers
  // already pass the relevant subset (e.g. [from,to] for a leg, all for overview).
  // We don't second-guess that here — MapView itself handles 1 vs 2+ places.
  return <MapView places={places} loop={loop} tracks={tracks} globe={globe} />;
}
