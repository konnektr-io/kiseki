import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTrip } from "./theme";
import {
  MAP_STYLE_URL,
  fetchRouteLegs,
  findLocation,
  hasWebGL2,
  locatedPlaces,
  markerNumber,
} from "../lib/maps";
import { addTerrain } from "../lib/terrain";
import { mapColors } from "../lib/tokens";
import { Floating } from "./ui";

/**
 * MapLibre is loaded on demand, once per session.
 *
 * It is ~800 kB of WebGL renderer and most pages have no map on them, so it
 * stays out of the entry bundle — the same reason the Google JS API used to be
 * injected lazily. Vite code-splits the dynamic import automatically.
 *
 * `setWorkerUrl` is mandatory for bundled builds in v6 (the worker can no
 * longer find itself via `import.meta.url` inside a bundler's module graph),
 * and Vite needs `?worker&url` rather than plain `?url` — plain `?url` emits
 * the worker without its sibling `maplibre-gl-shared.mjs` and no tile ever
 * loads in production.
 */
let libPromise: Promise<typeof import("maplibre-gl")> | null = null;
function loadMapLibre() {
  if (!libPromise) {
    libPromise = import("maplibre-gl").then((lib) => {
      lib.setWorkerUrl(workerUrl);
      return lib;
    });
  }
  return libPromise;
}

/**
 * Keep-out for the map's own chrome (kiseki-map-ux: "the map's usable viewport
 * is the part not covered by content — always pass padding matching the
 * occlusion"). Extra on the left for the zoom chips, and on the bottom for the
 * attribution, which wraps to two lines at phone width — so a marker never
 * lands underneath either.
 */
const CHROME_PADDING = { top: 34, right: 32, bottom: 48, left: 64 };

interface MapViewProps {
  places: string[];
  loop?: boolean;
  className?: string;
  showLiveTime?: boolean;
  /** Compact thumbnail (h-24) for block card media — single pin, minimal chrome. */
  compact?: boolean;
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
export function MapView({ places, loop = false, className = "", showLiveTime = true, compact = false }: MapViewProps) {
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
  // `places` is built inline by callers, so its identity changes every render —
  // key the effect on the contents instead of the array.
  const placesKey = places.join("|");

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
    if (located.length < 1) {
      // No resolvable place — mark as failed so the PDF does not wait forever
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

        // Single-pin thumbnail (hotel/restaurant card) — centered, zoom 13 like
        // the old Static Maps single-place proxy; multi-pin uses fitBounds.
        const single = located.length === 1;
        const bounds = new lib.LngLatBounds();
        located.forEach((l) => bounds.extend([l.lng!, l.lat!]));

        const mapOpts: ConstructorParameters<typeof lib.Map>[0] = {
          container: ref.current,
          style: MAP_STYLE_URL,
          attributionControl: { compact: true },
        };
        if (single) {
          (mapOpts as Record<string, unknown>).center = [located[0].lng!, located[0].lat!];
          (mapOpts as Record<string, unknown>).zoom = 13;
        } else {
          (mapOpts as Record<string, unknown>).bounds = bounds;
          (mapOpts as Record<string, unknown>).fitBoundsOptions = { padding: CHROME_PADDING, maxZoom: 12 };
        }

        map = new lib.Map(mapOpts);
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
          el.className = "grid h-11 w-11 place-items-center";
          el.setAttribute("aria-hidden", "true");
          el.title = l.name;
          const pin = document.createElement("span");
          pin.className =
            "grid h-7 w-7 place-items-center rounded-full border border-marker-fg bg-marker text-[12px] font-bold leading-none text-marker-fg shadow-card";
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

        // Elevation first, so the route and markers added below land ON TOP of
        // the hillshade rather than under it (#38). Deliberately not awaited
        // for the route's sake — a slow DEM must not hold up the line the map
        // exists to draw.
        void addTerrain(map, lib);

        // Fetch route geometry for multi-pin maps (skip for single-pin thumbnail)
        let legs: Awaited<ReturnType<typeof fetchRouteLegs>> = null;
        if (!single) {
          legs = await fetchRouteLegs(trip, places, loop, abort.signal);
        }
        if (cancelled || !map) return;

        if (legs?.length) {
          map.addSource("route", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: legs.map((leg) => ({
                type: "Feature" as const,
                properties: { road: leg.road },
                geometry: leg.geometry,
              })),
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
              paint: { "line-color": colors.routeCasing, "line-width": 7, "line-opacity": 0.9 },
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
              paint: { "line-color": colors.route, "line-width": 4 },
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
                "line-width": 2.5,
                "line-opacity": 0.5,
                "line-dasharray": [2, 2.5],
              },
            },
            firstSymbol,
          );

          // Re-frame on the real geometry: a road route swings well outside the
          // straight line between two pins.
          const full = new lib.LngLatBounds();
          located.forEach((l) => full.extend([l.lng!, l.lat!]));
          legs.forEach((leg) => leg.geometry.coordinates.forEach((c) => full.extend(c)));
          const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          map.fitBounds(full, { padding: CHROME_PADDING, maxZoom: 12, animate: !reduceMotion, duration: 500 });

          if (legs.length === 1 && showLiveTime && legs[0].duration) setLiveTime(legs[0].duration);
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
          // Fallback: if already idle, MapLibre may not fire idle again
          setTimeout(() => {
            if (ref.current?.dataset.mapReady !== "true") markReady();
          }, 300);
        } else {
          map.once("idle", markReady);
          // Safety: never block the PDF forever on a stalled tile/DEM source
          setTimeout(() => {
            if (ref.current?.dataset.mapReady !== "true" && ref.current?.dataset.mapFailed !== "true") {
              markReady();
            }
          }, 6000);
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
  }, [trip, placesKey, loop, showLiveTime, webgl2, onScreen, isPdfRender, compact]);

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
        className={`${heightClass} overflow-hidden rounded-lg border border-border`}
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
export function TripMap({ places, loop = false }: { places: string[]; loop?: boolean }) {
  const trip = useTrip();
  const all = locatedPlaces(trip);
  if (all.length < 1) return null;
  // Route maps need at least one resolvable place in `places`; TripMap callers
  // already pass the relevant subset (e.g. [from,to] for a leg, all for overview).
  // We don't second-guess that here — MapView itself handles 1 vs 2+ places.
  return <MapView places={places} loop={loop} />;
}
