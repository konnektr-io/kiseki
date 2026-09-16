import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { hasWebGL2, MAP_STYLE_URL, pinClassForStage } from "../lib/maps";
import { loadMapLibre } from "../lib/maplibre";
import { mapColors } from "../lib/tokens";

/** One numbered stop on the landing page's example route. */
export interface LandingMapStop {
  name: string;
  lng: number;
  lat: number;
}

/**
 * The example trip's map on the signed-out landing page (#249) — the REAL map.
 *
 * An earlier revision drew a schematic route instead, on the reasoning that a
 * screenshot of a real trip's map would be neither ours to license nor fictional.
 * That was the wrong call twice over: the app's maps are MapLibre over keyless
 * OpenFreeMap tiles, which is exactly the kind of thing a product page is supposed
 * to show, attribution and all, and a drawn line under a heading that says "one map"
 * asks the visitor to imagine the feature.
 *
 * Three properties are kept from the drawn version, because they were right:
 *
 * - **The drawing survives as the placeholder.** It is what the prerender carries,
 *   what a no-JS visitor sees, what a WebGL-less browser keeps, and what holds the
 *   box's height so the real map cannot shove the page down when it arrives.
 * - **Nothing is fetched until it is needed.** MapLibre is ~800 kB of WebGL renderer
 *   behind the same `IntersectionObserver` gate `MapView` uses, so a visitor who
 *   never scrolls this far never downloads it.
 * - **No trip document.** The route is five fixed stops; the road geometry between
 *   them comes from `GET /api/landing-route`, which serves it live from HERE with
 *   a 5-minute cache. Hardcoding the polyline is not an option — HERE's terms allow
 *   routing results outside the platform for 30 days at most (Japan: 24 h), so a
 *   committed copy would be a licence violation, not an optimisation. Until that
 *   fetch lands (or when it fails) the map draws the stops straight, exactly as
 *   before — the line upgrades to real roads when they arrive.
 *
 * The road geometry carries a credit requirement of its own (© HERE), so the map
 * shows a small "Road route © HERE" caption — but only when it is actually drawing
 * HERE roads rather than the straight fallback.
 *
 * Attribution is maplibre's own (`attributionControl`), off the OpenFreeMap style —
 * the tiles are community-funded, so the credit is required and is shown.
 *
 * SSR note: nothing here may touch `document` during render. The prerender runs this
 * component in Node, so the WebGL2 check and the `IntersectionObserver` both live in
 * effects, and the placeholder is the only thing the server ever renders.
 */
export function LandingMap({
  stops,
  className = "",
}: {
  stops: LandingMapStop[];
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [webgl2, setWebgl2] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  /** True once the map is drawing live HERE roads (credit requirement, © HERE). */
  const [road, setRoad] = useState(false);
  // `stops` comes from a module constant, but keying on its contents keeps the
  // effect honest if a caller ever builds the array inline.
  const stopsKey = stops.map((s) => `${s.name}:${s.lng},${s.lat}`).join("|");
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  // Gate one: don't even ask for the library until the map is nearly in view.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOnScreen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!onScreen) return;
    // Gate two: WebGL2. maplibre v6 dropped the WebGL1 fallback, so this is a hard
    // gate — and it has to be asked in an effect, because this component is also
    // rendered in Node by the prerender, where `document` does not exist.
    if (!hasWebGL2()) {
      setWebgl2(false);
      return;
    }
    setWebgl2(true);

    let cancelled = false;
    let map: MapLibreMap | null = null;

    void (async () => {
      try {
        // The library and the roads load together: a warm backend cache makes the
        // fetch cost nothing, and the map does not wait for either — pins and
        // tiles render first, the line upgrades to real roads when they arrive.
        const [lib, roadCoords] = await Promise.all([loadMapLibre(), fetchRoadGeometry()]);
        if (cancelled || !ref.current) return;
        const stops = stopsRef.current;
        const colors = mapColors(ref.current);
        const bounds = new lib.LngLatBounds();
        stops.forEach((s) => bounds.extend([s.lng, s.lat]));

        map = new lib.Map({
          container: ref.current,
          // The same keyless positron style an un-themed trip gets (lib/maps.ts).
          style: MAP_STYLE_URL,
          bounds,
          fitBoundsOptions: { padding: PIN_PADDING, maxZoom: 12 },
          // OpenFreeMap tiles are community-funded: the credit is not optional, and
          // it is the reason this map is allowed on a public page at all.
          attributionControl: { compact: true },
          // A marketing map is a picture that happens to respond. It may not hijack
          // the page's scroll, and it has no business rotating or tilting.
          scrollZoom: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
        });
        map.getCanvas().setAttribute("aria-label", "Map of the trip's route through Tokyo");

        // Unreachable tiles or style → keep the drawing (DESIGN.md §8.5).
        map.on("error", () => {
          if (!cancelled && map && !map.loaded()) {
            ref.current?.setAttribute("data-map-failed", "true");
            setFailed(true);
          }
        });

        stops.forEach((stop, index) => {
          const el = document.createElement("div");
          // 44px hit target around the pin, same as MapView.
          el.className = "grid h-11 w-11 place-items-center";
          el.setAttribute("aria-hidden", "true");
          el.title = stop.name;
          const pin = document.createElement("span");
          // The app's own pin vocabulary, off the one class map in lib/maps.ts. The
          // example trip is a planned one, and there is no document here to derive a
          // per-place stage from.
          pin.className = pinClassForStage(EXAMPLE_TRIP_STAGE);
          pin.textContent = String(index + 1);
          el.appendChild(pin);
          new lib.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map!);
        });

        await new Promise<void>((resolve) => {
          if (map!.loaded()) resolve();
          else map!.once("load", () => resolve());
        });
        if (cancelled || !map) return;

        map.addSource("landing-route", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              // Real roads when HERE answered, the straight stop-to-stop line
              // until then or when it did not.
              coordinates: roadCoords ?? stops.map((s) => [s.lng, s.lat]),
            },
          },
        });
        map.addLayer({
          id: "landing-route-casing",
          type: "line",
          source: "landing-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": colors.routeCasing, "line-width": 6, "line-opacity": 0.35 },
        });
        map.addLayer({
          id: "landing-route-line",
          type: "line",
          source: "landing-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": colors.route, "line-width": 3 },
        });

        if (!cancelled) {
          if (roadCoords) setRoad(true);
          setReady(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [onScreen, stopsKey]);

  return (
    <>
      <div
        className={`relative mt-4 aspect-[9/5] overflow-hidden rounded-lg border border-border bg-muted ${className}`}
      >
      {/* The drawn stand-in. Holds the height, so the real map cannot shift the page. */}
      <div
        aria-hidden={ready ? "true" : undefined}
        className={`absolute inset-0 transition-opacity duration-300 ${
          ready ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <RouteSketch />
      </div>
      <div
        ref={ref}
        data-landing-map={failed ? "failed" : webgl2 === false ? "no-webgl2" : ready ? "ready" : onScreen ? "loading" : "idle"}
        /* `h-full w-full`, NOT `absolute inset-0`: MapLibre adds its
           `maplibregl-map` class to this element, and that class's unlayered
           `position: relative` defeats Tailwind's `.absolute` — a relative box
           with no in-flow children collapses to 0 and the map measures 0. See
           `HomeMap`'s doc comment for the measured timeline. */
        className={`h-full w-full transition-opacity duration-300 ${
          ready ? "opacity-100" : "opacity-0"
        }`}
      />
      </div>
      {/* HERE's credit, and only when its roads are what is drawn. */}
      {road ? <p className="mt-2 text-[11px] text-muted-foreground">Road route © HERE</p> : null}
    </>
  );
}

/**
 * The example's roads, live from the backend (`GET /api/landing-route`).
 *
 * Null when anything is off — no backend, no HERE key, a HERE error, a bad
 * shape — and the map keeps the straight stop-to-stop line. The shape is
 * validated rather than trusted: a fetch that returns something unexpected
 * must degrade, never crash the map's source.
 */
async function fetchRoadGeometry(): Promise<[number, number][] | null> {
  try {
    const res = await fetch("/api/landing-route");
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return null;
    const { road, coordinates } = data as { road?: unknown; coordinates?: unknown };
    if (road !== true || !Array.isArray(coordinates) || coordinates.length < 2) return null;
    const pts: [number, number][] = [];
    for (const pt of coordinates) {
      if (
        !Array.isArray(pt) ||
        pt.length !== 2 ||
        typeof pt[0] !== "number" ||
        typeof pt[1] !== "number" ||
        !Number.isFinite(pt[0]) ||
        !Number.isFinite(pt[1])
      ) {
        return null;
      }
      pts.push([pt[0], pt[1]]);
    }
    return pts;
  } catch {
    return null;
  }
}

/** The example trip is a plan, not a booking — so its pins are the planned ones. */
const EXAMPLE_TRIP_STAGE = "planned" as const;

/**
 * Keep-out for the pins, in px.
 *
 * The app's own `CHROME_PADDING` reserves room for its sheet and rail; the landing
 * card has no chrome to avoid, so this is symmetric — but it is not small: at 44 (the
 * pin's own hit target) stop 4 grazed the bottom edge of the box, which is exactly
 * what a fit with too little padding looks like.
 */
const PIN_PADDING = 64;

/**
 * The route as a drawing: the placeholder above, and the whole map for anyone
 * without JavaScript. Schematic on purpose — it is a stand-in, not a claim about
 * where the streets are.
 */
function RouteSketch() {
  return (
    <svg
      viewBox="0 0 360 200"
      role="img"
      aria-label="A route drawn as a dashed line through five numbered stops"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid slice"
    >
      <path d="M0 150 L70 120 L140 138 L210 104 L280 126 L360 96 L360 200 L0 200 Z" className="fill-border" />
      <path d="M0 60 L60 40 L130 66 L190 34 L250 58 L320 30 L360 44 L360 0 L0 0 Z" className="fill-border/60" />
      <path
        d="M48 150 C96 118, 120 92, 168 96 S244 130, 292 74"
        fill="none"
        strokeWidth="2.5"
        strokeDasharray="7 5"
        className="stroke-primary"
      />
      {[
        { x: 48, y: 150, n: 1 },
        { x: 112, y: 104, n: 2 },
        { x: 186, y: 96, n: 3 },
        { x: 248, y: 118, n: 4 },
        { x: 292, y: 74, n: 5 },
      ].map((pin) => (
        <g key={pin.n}>
          <circle cx={pin.x} cy={pin.y} r="9" className="fill-card stroke-primary" strokeWidth="2" />
          <text
            x={pin.x}
            y={pin.y + 3.5}
            textAnchor="middle"
            className="fill-primary text-[9px] font-semibold tabular-nums"
          >
            {pin.n}
          </text>
        </g>
      ))}
    </svg>
  );
}
