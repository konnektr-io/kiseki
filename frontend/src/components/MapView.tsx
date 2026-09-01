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
  staticMapUrl,
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
 * Hidden in print — the booklet uses StaticMapImg instead (see TripMap).
 */
export function MapView({ places, loop = false, className = "", showLiveTime = true }: MapViewProps) {
  const trip = useTrip();
  const ref = useRef<HTMLDivElement>(null);
  // v6 dropped the WebGL1 fallback entirely, so this is a hard gate, not a
  // preference — without WebGL2 the constructor throws (DESIGN.md §8.2).
  const [webgl2] = useState(hasWebGL2);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [liveTime, setLiveTime] = useState<string | null>(null);
  // Every MapLibre map is a WebGL context and browsers cap those around 16, so
  // a map may not exist until it is actually on screen. A continuous itinerary
  // has one drive card per leg and the booklet renders EVERY day at once —
  // mounting eagerly would exhaust the cap on both. It also keeps the print
  // path clean: a `display:none` element never intersects, so the PDF creates
  // no contexts and pulls no tiles (DESIGN.md §8.2).
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined");
  // `places` is built inline by callers, so its identity changes every render —
  // key the effect on the contents instead of the array.
  const placesKey = places.join("|");

  useEffect(() => {
    if (onScreen || typeof IntersectionObserver === "undefined") return;
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
  }, [onScreen]);

  useEffect(() => {
    if (!webgl2 || !onScreen) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    const abort = new AbortController();

    const located = places
      .map((p) => findLocation(trip, p))
      .filter((l): l is NonNullable<typeof l> => !!l && l.lat != null && l.lng != null);
    if (located.length < 2) return;

    (async () => {
      try {
        const lib = await loadMapLibre();
        if (cancelled || !ref.current) return;

        // Route colours come from the token layer, resolved against the element
        // so they carry THIS trip's identity (DESIGN.md §8.4). A hex literal
        // here is how every trip ended up drawing Canada-blue routes.
        const colors = mapColors(ref.current);

        const bounds = new lib.LngLatBounds();
        located.forEach((l) => bounds.extend([l.lng!, l.lat!]));

        map = new lib.Map({
          container: ref.current,
          style: MAP_STYLE_URL,
          bounds,
          fitBoundsOptions: { padding: CHROME_PADDING, maxZoom: 12 },
          attributionControl: { compact: true },
        });
        // Real <button>s with aria-labels; 28px visible inside a 44px target
        // (index.css). Top-LEFT: top-right is the drive-time chip, and the
        // whole bottom strip is attribution — which wraps to two lines on a
        // phone-width map and would sit straight on top of the zoom-out
        // button. Attribution is a legal requirement, so the controls move.
        map.addControl(new lib.NavigationControl({ showCompass: false }), "top-left");

        // Tiles or style unreachable → fall back to the static image rather
        // than leaving an empty grey box (DESIGN.md §8.5). Only failures before
        // first paint count; a single dropped tile later is not a dead map.
        map.on("error", () => {
          if (!cancelled && !map?.loaded()) setFailed(true);
        });

        located.forEach((l) => {
          const n = markerNumber(trip, l);
          const el = document.createElement("div");
          // 44px hit target around a ~28px pin (DESIGN.md §8.3). Colours are
          // Tailwind utilities off --color-marker / --color-marker-fg, so the
          // pin is per-trip for free and no colour is written in JS at all.
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

        const loaded = new Promise<void>((resolve) => map!.once("load", () => resolve()));
        const [, legs] = await Promise.all([
          loaded,
          fetchRouteLegs(trip, places, loop, abort.signal),
        ]);
        if (cancelled || !map) return;
        setReady(true);

        // Elevation first, so the route and markers added below land ON TOP of
        // the hillshade rather than under it (#38). Deliberately not awaited
        // for the route's sake — a slow DEM must not hold up the line the map
        // exists to draw.
        void addTerrain(map, lib);

        if (!legs?.length) return;

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
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      map?.remove();
    };
  }, [trip, placesKey, loop, showLiveTime, webgl2, onScreen]);

  // No WebGL2, or the style/tiles never arrived: show the same view as a
  // server-rendered image. Never a crash, never an empty grey box.
  if (!webgl2 || failed) {
    // Same box as the live map, so the page does not reflow into a different
    // shape depending on whether WebGL and the tiles were available.
    return <StaticMapImg places={places} loop={loop} className={`h-48 object-cover md:h-56 ${className}`} />;
  }

  return (
    <div className={`relative ${className}`}>
      <div
        ref={ref}
        role="img"
        aria-label={`Map of the route: ${places.join(" to ")}`}
        className="h-48 w-full overflow-hidden rounded-lg border border-border md:h-56"
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

/** Static map image (server-proxied: real route + key-safe) — used in the booklet/print. */
export function StaticMapImg({ places, loop = false, query, className = "" }: { places: string[]; loop?: boolean; query?: string; className?: string }) {
  const trip = useTrip();
  const url = staticMapUrl(trip, places, loop, query);
  if (!url) return null;
  return <img src={url} alt="Route map" className={`w-full rounded-lg border border-border ${className}`} />;
}

/**
 * One map, both worlds: MapLibre on screen (live drive time), static image in
 * print (real route). This split is the contract — any map component provides
 * both halves or it isn't done. Retiring the static half is #37.
 */
export function TripMap({ places, loop = false }: { places: string[]; loop?: boolean }) {
  const trip = useTrip();
  const all = locatedPlaces(trip);
  if (all.length < 2) return null;
  return (
    <>
      <div className="hidden print:block">
        <StaticMapImg places={places} loop={loop} />
      </div>
      <div className="print:hidden">
        <MapView places={places} loop={loop} />
      </div>
    </>
  );
}
