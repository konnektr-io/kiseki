import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Maximize2 } from "lucide-react";
import { useTrip } from "./theme";
import {
  MAP_STYLE_URL,
  fetchRouteLegs,
  hasWebGL2,
  markerNumber,
  prefersReducedMotion,
  type MapPadding,
} from "../lib/maps";
import { loadMapLibre } from "../lib/maplibre";
import { greatCircle, type Journey } from "../lib/route-surface";
import { addTerrain } from "../lib/terrain";
import { mapColors } from "../lib/tokens";
import type { TripLocation } from "../lib/types";

/** Map camera durations (DESIGN.md §10) — 400–600ms, nothing else. */
const CAMERA_MS = 500;

/**
 * Camera padding, as a centre offset in px.
 *
 * MapLibre has two padding mechanisms and they ADD UP, which is a trap worth
 * spelling out: `fitBounds` bakes `options.padding` into the centre/zoom it
 * computes and then deletes it (`_fitInternal`), while `easeTo({padding})`
 * sets the transform's persistent padding. Use both and the view is shifted
 * twice — the route ends up above the visible strip, clipped against the top
 * edge, which looks exactly like a broken fit.
 *
 * So this component never touches persistent padding: `fitBounds` gets
 * `padding`, and a centre move gets the equivalent `offset` instead.
 */
function paddingOffset(p: MapPadding): [number, number] {
  return [(p.left - p.right) / 2, (p.top - p.bottom) / 2];
}

interface RouteMapProps {
  journey: Journey;
  /** Camera keep-out for the sheet/rail occlusion — see `SplitView`. */
  padding: MapPadding;
  selected: TripLocation | null;
  onSelect: (loc: TripLocation) => void;
}

/**
 * The trip route as a map SURFACE (#39, DESIGN.md §2.2): the whole journey,
 * numbered markers, legs drawn by their own state.
 *
 * This is not `MapView` with a bigger box. `MapView` is a document-surface
 * card — fixed height, one shot, and the booklet PDF renders through it, so it
 * stays exactly as it is. A surface map fills its container, is driven by
 * selection and camera padding from outside, and is **never printed**: the
 * booklet's route map is still `MapView`'s (#37), which is why nothing here
 * carries the `data-maplibre` handshake the PDF waiter looks for.
 */
export function RouteMap({ journey, padding, selected, onSelect }: RouteMapProps) {
  const trip = useTrip();
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, HTMLElement>>(new Map());
  const fitRef = useRef<(() => void) | null>(null);
  // Latest selection handler, read from the marker's own click listener — the
  // markers are DOM built once, so they must not close over a stale prop.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;

  // v6 dropped the WebGL1 fallback entirely, so this is a hard gate, not a
  // preference — without WebGL2 the constructor throws (DESIGN.md §8.2).
  const [webgl2] = useState(hasWebGL2);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const legsKey = journey.legs.map((l) => `${l.from.name}>${l.to.name}:${l.stage}`).join("|");

  useEffect(() => {
    if (!webgl2 || !ref.current || journey.stops.length < 1) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    const abort = new AbortController();
    const markers: MapLibreMarker[] = [];
    markersRef.current = new Map();

    (async () => {
      try {
        const lib = await loadMapLibre();
        if (cancelled || !ref.current) return;

        // Colours come off the token layer, resolved against this element so
        // they carry THIS trip's identity (§8.4). No hex literal belongs in
        // map code.
        const colors = mapColors(ref.current);

        const bounds = new lib.LngLatBounds();
        journey.stops.forEach((s) => bounds.extend([s.lng!, s.lat!]));

        map = new lib.Map({
          container: ref.current,
          style: MAP_STYLE_URL,
          attributionControl: { compact: true },
          bounds: journey.stops.length > 1 ? bounds : undefined,
          center: journey.stops.length === 1 ? [journey.stops[0].lng!, journey.stops[0].lat!] : undefined,
          zoom: journey.stops.length === 1 ? 9 : undefined,
          fitBoundsOptions: { padding: paddingRef.current, maxZoom: 12 },
        });
        mapRef.current = map;

        map.addControl(new lib.NavigationControl({ showCompass: true, visualizePitch: true }), "top-left");
        const syncOriented = () => {
          if (!map || !ref.current) return;
          ref.current.classList.toggle("map-oriented", map.getBearing() !== 0 || map.getPitch() !== 0);
        };
        map.on("rotate", syncOriented);
        map.on("pitch", syncOriented);

        map.on("error", () => {
          if (!cancelled && !map?.loaded()) setFailed(true);
        });

        journey.stops.forEach((loc) => {
          const n = markerNumber(trip, loc);
          const el = document.createElement("button");
          el.type = "button";
          // The list beside the map is the accessible path to every place
          // (kiseki-map-ux), so the pins stay out of the tab order rather than
          // duplicating every stop in it — but they are still real buttons, so
          // a pointer gets button semantics and a 44px target.
          el.tabIndex = -1;
          el.setAttribute("aria-hidden", "true");
          el.title = loc.name;
          el.dataset.place = loc.name;
          el.className = "route-pin grid h-11 w-11 cursor-pointer place-items-center";
          const pin = document.createElement("span");
          // Pin colours are Tailwind utilities off --color-marker /
          // --color-marker-fg, so the pin is per-trip for free and no colour
          // is written in JS at all.
          pin.className =
            "route-pin-dot grid h-7 w-7 place-items-center rounded-full border border-marker-fg bg-marker text-[12px] font-bold leading-none text-marker-fg shadow-card transition-transform duration-120";
          pin.textContent = String(n);
          el.appendChild(pin);
          el.addEventListener("click", () => onSelectRef.current(loc));
          markersRef.current.set(loc.name, el);
          markers.push(new lib.Marker({ element: el }).setLngLat([loc.lng!, loc.lat!]).addTo(map!));
        });

        await new Promise<void>((resolve) => {
          if (map!.loaded()) resolve();
          else map!.once("load", () => resolve());
        });
        if (cancelled || !map) return;

        // Elevation first, so the route lands ON TOP of the hillshade (#38).
        // Deliberately not awaited — a slow DEM must not hold up the line the
        // surface exists to draw.
        void addTerrain(map, lib);

        // Real geometry when the backend can give it; the trip's own
        // coordinates when it can't (maps unconfigured, or a leg with no road
        // route). A surface whose whole point is the route must draw SOMETHING.
        // `chain` + `loop` is exactly the pair list `journey.legs` describes:
        // the backend closes the loop itself, so the chain must NOT already
        // repeat the first stop or the route gains a zero-length leg.
        const fetched = journey.legs.length
          ? await fetchRouteLegs(
              trip,
              journey.chain.map((s) => s.name),
              journey.loop,
              abort.signal,
            )
          : null;
        if (cancelled || !map) return;

        const features = journey.legs.map((leg) => {
          const hit = fetched?.find(
            (f) =>
              (f.from === leg.from.name && f.to === leg.to.name) ||
              (f.from === leg.to.name && f.to === leg.from.name),
          );
          const road = hit?.road ?? false;
          const coordinates =
            hit?.geometry.coordinates ??
            greatCircle([leg.from.lng!, leg.from.lat!], [leg.to.lng!, leg.to.lat!]);
          return {
            type: "Feature" as const,
            properties: { state: leg.stage, road },
            geometry: { type: "LineString" as const, coordinates },
          };
        });

        map.addSource("journey", { type: "geojson", data: { type: "FeatureCollection", features } });

        // Under the basemap's labels so place names stay readable across the
        // route (§8.5). Found by layer TYPE, not id — hardcoded ids do not
        // survive the per-trip style swap #40 will make.
        const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;

        // Provisional legs are dashed and dim, committed ones solid and full
        // width — the map shows intent, not just geography (§5.3).
        const solid: import("maplibre-gl").FilterSpecification = [
          "all",
          ["get", "road"],
          ["!=", ["get", "state"], "provisional"],
        ];
        const dashed: import("maplibre-gl").FilterSpecification = [
          "any",
          ["!", ["get", "road"]],
          ["==", ["get", "state"], "provisional"],
        ];
        const width: import("maplibre-gl").DataDrivenPropertyValueSpecification<number> = [
          "match",
          ["get", "state"],
          "booked",
          4.5,
          "planned",
          3.5,
          3,
        ];
        const opacity: import("maplibre-gl").DataDrivenPropertyValueSpecification<number> = [
          "match",
          ["get", "state"],
          "booked",
          1,
          "planned",
          0.85,
          0.6,
        ];

        // Every line twice: a wide casing under a narrower body, or the route
        // vanishes over roads of a similar colour (§8.4). The dashed casing
        // shares the dash pattern — a solid casing under a dashed body fills
        // the gaps back in and the leg stops reading as provisional.
        map.addLayer(
          {
            id: "journey-casing",
            type: "line",
            source: "journey",
            filter: solid,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": colors.routeCasing, "line-width": 7.5, "line-opacity": 0.9 },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "journey-dashed-casing",
            type: "line",
            source: "journey",
            filter: dashed,
            layout: { "line-cap": "butt", "line-join": "round" },
            paint: {
              "line-color": colors.routeCasing,
              "line-width": 6,
              "line-opacity": 0.7,
              "line-dasharray": [2, 2.2],
            },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "journey-solid",
            type: "line",
            source: "journey",
            filter: solid,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": colors.route, "line-width": width, "line-opacity": opacity },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "journey-dashed",
            type: "line",
            source: "journey",
            filter: dashed,
            layout: { "line-cap": "butt", "line-join": "round" },
            paint: {
              "line-color": colors.route,
              "line-width": width,
              "line-opacity": opacity,
              "line-dasharray": [2, 2.2],
            },
          },
          firstSymbol,
        );

        // Frame the whole journey on the settled container, including the road
        // geometry — a real route swings well outside the straight line
        // between its pins.
        const full = new lib.LngLatBounds();
        journey.stops.forEach((s) => full.extend([s.lng!, s.lat!]));
        features.forEach((f) => f.geometry.coordinates.forEach((c) => full.extend(c as [number, number])));
        fitRef.current = () => {
          if (!mapRef.current || journey.stops.length < 2) return;
          mapRef.current.fitBounds(full, {
            padding: paddingRef.current,
            maxZoom: 12,
            animate: !prefersReducedMotion(),
            duration: CAMERA_MS,
          });
        };
        fitRef.current();
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      markers.forEach((m) => m.remove());
      map?.remove();
      mapRef.current = null;
      fitRef.current = null;
    };
  }, [trip, legsKey, webgl2]);

  // Selection: the pin grows and gets a ring, the others dim to 45% —
  // dimmed, never hidden (§8.3). Done with classes so no colour is written in
  // JS and the paint layers are never re-set.
  useEffect(() => {
    const container = ref.current;
    if (container) container.classList.toggle("route-map-focused", !!selected);
    markersRef.current.forEach((el, name) => {
      el.classList.toggle("is-selected", selected?.name === name);
    });
  }, [selected, ready]);

  // Frame whatever the surface is currently about, in the part of the map the
  // content does NOT cover.
  //
  // Both inputs land here: a new selection, and a new occlusion (a detent
  // drag, a rotation, a breakpoint change). Forgetting the second one is the
  // #1 bug in map+sheet layouts — the route hides under the sheet and it reads
  // as "the map is broken".
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!selected || selected.lng == null || selected.lat == null) {
      fitRef.current?.();
      return;
    }
    const opts = {
      center: [selected.lng, selected.lat] as [number, number],
      zoom: Math.max(map.getZoom(), 9),
      offset: paddingOffset(padding),
    };
    if (prefersReducedMotion()) map.jumpTo(opts);
    else map.easeTo({ ...opts, duration: CAMERA_MS });
  }, [selected, padding, ready]);

  if (!webgl2 || failed) {
    return (
      <div
        role="img"
        aria-label={failed ? "Map failed to load" : "Map requires WebGL2"}
        className="grid h-full w-full place-items-center bg-muted p-6 text-center text-sm text-muted-foreground"
      >
        {failed
          ? "The map couldn't load. Every place and day is in the list."
          : "This browser has no WebGL2, so the map can't draw. Every place and day is in the list."}
      </div>
    );
  }

  return (
    <>
      <div ref={ref} className="h-full w-full" />
      {!ready && (
        // Themed skeleton while the style loads (§8.5) — never an empty grey box.
        <div className="pointer-events-none absolute inset-0 animate-pulse bg-muted" aria-hidden="true" />
      )}
      {/* Map controls are real buttons with labels and a 44px target — a WebGL
          canvas gives keyboard users nothing (§11). */}
      <button
        type="button"
        onClick={() => fitRef.current?.()}
        aria-label="Frame the whole route"
        className="map-chip-btn absolute right-0 top-0 z-10 grid h-11 w-11 place-items-center"
      >
        <span className="floating grid h-8 w-8 place-items-center rounded-lg text-muted-foreground">
          <Maximize2 className="h-4 w-4" aria-hidden="true" />
        </span>
      </button>
    </>
  );
}
