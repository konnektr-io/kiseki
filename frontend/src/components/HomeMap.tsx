import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin, Minus, Plus } from "lucide-react";
import { hasWebGL2, MAP_STYLE_URL, pinClassForStage, prefersReducedMotion, type MapPadding } from "../lib/maps";
import { loadMapLibre } from "../lib/maplibre";
import { clusterPins, type HomeMapPin } from "../lib/home-geo";

/** Map camera durations (DESIGN.md §10) — 400–600ms, nothing else. */
const CAMERA_MS = 500;
/** Pins closer than this on screen tap as one (a count, not a range — §8.3). */
const CLUSTER_PX = 48;

interface HomeMapProps {
  /** The pins to draw — the E2 rows, verbatim. Never invented here. */
  pins: HomeMapPin[];
  /** The band row's answer on the map (and vice versa). */
  selectedDtId: string | null;
  /** A pin tap raises its band row — the chip↔card idiom from #104. */
  onSelect: (dtId: string) => void;
  /** Camera keep-out for the sheet/rail occlusion — see `SplitView`. */
  padding: MapPadding;
}

/**
 * The signed-in home's map (#249, slice 3) — pins for the trips the viewer
 * may list, on the keyless OpenFreeMap style, in the app's own pin vocabulary
 * (`pinClassForStage` + the `route-pin` / `is-selected` / `route-map-focused`
 * grammar from the trip maps — no second marker language).
 *
 * The map answers "where", the bands answer "what": no routes, no legs, one
 * dot per trip, stage-coloured. Colliding pins group into a count badge that
 * zooms in on tap. The bands are the keyboard-reachable list equivalent (§11);
 * pins are real `<button>`s all the same, so pointer and keyboard reach the
 * same trips.
 *
 * SSR note (shared with `LandingMap`): nothing here may touch `document`
 * during render. The WebGL2 check and the map build live in effects, and the
 * placeholder is the only thing the server ever renders.
 */
export function HomeMap({ pins, selectedDtId, onSelect, padding }: HomeMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const [webgl2, setWebgl2] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Live props, read through refs inside the marker build so it can key on
  // STABLE identities (pins contents, selection) instead of objects rebuilt
  // every render.
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const selectedRef = useRef(selectedDtId);
  selectedRef.current = selectedDtId;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  // `pins` is built inline by the caller, so its identity changes every
  // render — key the effects on the contents instead of the array.
  const pinsKey = pins.map((p) => `${p.dtId}:${p.lat},${p.lng}:${p.stage}`).join("|");

  const empty = pins.length === 0;

  useEffect(() => {
    if (empty) return;
    if (!hasWebGL2()) {
      setWebgl2(false);
      return;
    }
    setWebgl2(true);

    let cancelled = false;
    let map: MapLibreMap | null = null;

    const rebuildMarkers = () => {
      const lib = libRef.current;
      const live = mapRef.current;
      if (cancelled || !lib || !live) return;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      const current = pinsRef.current;
      if (!current.length) return;
      const projected = current.map((p) => {
        const pt = live.project([p.lng, p.lat]);
        return { dtId: p.dtId, x: pt.x, y: pt.y };
      });
      const byId = new Map(current.map((p) => [p.dtId, p]));
      for (const item of clusterPins(projected, CLUSTER_PX)) {
        if (item.kind === "cluster") {
          markersRef.current.push(buildClusterMarker(lib, live, item.cluster));
        } else {
          const pin = byId.get(item.pin.dtId);
          if (pin) markersRef.current.push(buildPinMarker(lib, live, pin, selectedRef, selectRef));
        }
      }
      // The focus story, same grammar as the trip maps: one selected place,
      // everything else recedes — dimmed, never hidden.
      ref.current?.classList.toggle("route-map-focused", selectedRef.current != null);
    };

    const framePins = () => {
      const live = mapRef.current;
      const lib = libRef.current;
      if (cancelled || !lib || !live) return;
      const current = pinsRef.current;
      if (!current.length) return;
      if (current.length === 1) {
        const only = current[0];
        if (prefersReducedMotion()) live.jumpTo({ center: [only.lng, only.lat], zoom: 10 });
        else live.easeTo({ center: [only.lng, only.lat], zoom: 10, duration: CAMERA_MS });
        return;
      }
      const bounds = new lib.LngLatBounds();
      current.forEach((p) => bounds.extend([p.lng, p.lat]));
      live.fitBounds(bounds, {
        padding: paddingRef.current,
        maxZoom: 12,
        animate: !prefersReducedMotion(),
        duration: CAMERA_MS,
      });
    };

    void (async () => {
      try {
        const lib = await loadMapLibre();
        if (cancelled || !ref.current) return;
        libRef.current = lib;
        map = new lib.Map({
          container: ref.current,
          style: MAP_STYLE_URL,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        map.getCanvas().setAttribute("aria-label", "Map of your trips");
        map.on("error", () => {
          if (!cancelled && map && !map.loaded()) {
            ref.current?.setAttribute("data-map-failed", "true");
            setFailed(true);
          }
        });
        map.on("moveend", rebuildMarkers);
        await new Promise<void>((resolve) => {
          if (map!.loaded()) resolve();
          else map!.once("load", () => resolve());
        });
        if (cancelled || !map) return;
        framePins();
        rebuildMarkers();
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map?.remove();
      mapRef.current = null;
    };
    // Re-run when the PIN SET changes (geo arriving late) — selection-only
    // changes restyle in place below, never re-frame: the camera moves on
    // explicit intent, never on render (§10).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty, pinsKey]);

  // Selection restyle without a camera move: retoggle the classes in place.
  useEffect(() => {
    ref.current?.classList.toggle("route-map-focused", selectedDtId != null);
    const container = ref.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>("[data-pin]").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.pin === selectedDtId);
    });
  }, [selectedDtId, ready]);

  const state = empty ? "empty" : failed ? "failed" : webgl2 === false ? "no-webgl2" : ready ? "ready" : "idle";

  const zoomBy = (delta: number) => {
    const live = mapRef.current;
    if (!live) return;
    if (delta > 0) live.zoomIn({ duration: prefersReducedMotion() ? 0 : CAMERA_MS });
    else live.zoomOut({ duration: prefersReducedMotion() ? 0 : CAMERA_MS });
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted">
      {/* Placeholder: the themed box, never an empty grey one (§8.5). It holds
          the height before the map arrives and stays for no-JS / no-WebGL2. */}
      <div
        role="img"
        aria-label={empty ? "No trip locations to show on the map" : `Map of ${pins.length} trip ${pins.length === 1 ? "location" : "locations"}`}
        className={`absolute inset-0 grid place-items-center transition-opacity duration-300 ${
          ready ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <span className="flex flex-col items-center gap-2 text-muted-foreground">
          <MapPin className="h-8 w-8" strokeWidth={1.5} aria-hidden="true" />
          <span className="text-xs">
            {empty ? "No located trips yet" : `${pins.length} ${pins.length === 1 ? "trip" : "trips"}`}
          </span>
        </span>
      </div>
      {!empty && (
        <div
          ref={ref}
          data-home-map={state}
          className={`map-surface absolute inset-0 transition-opacity duration-300 ${
            ready ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {/* Zoom stays a real button (§11): pinch is the gesture a motor
          impairment rules out. Small chips in 44px targets, top-left — the
          drive-time corner (top-right) belongs to the layer toggle. */}
      {!empty && (
        <div className="absolute left-3 top-3 z-10 flex flex-col gap-2">
          <button
            type="button"
            aria-label="Zoom in"
            disabled={!ready}
            onClick={() => zoomBy(1)}
            className="floating grid h-11 w-11 place-items-center rounded-xl text-foreground disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            disabled={!ready}
            onClick={() => zoomBy(-1)}
            className="floating grid h-11 w-11 place-items-center rounded-xl text-foreground disabled:opacity-50"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/** One trip's dot: the stage-coloured pin, a 44px button around it (§8.3). */
function buildPinMarker(
  lib: typeof import("maplibre-gl"),
  map: MapLibreMap,
  pin: HomeMapPin,
  selectedRef: React.MutableRefObject<string | null>,
  selectRef: React.MutableRefObject<(dtId: string) => void>,
): MapLibreMarker {
  const el = document.createElement("button");
  el.type = "button";
  // The trip-map grammar, reused: `route-pin` carries the hit target,
  // `route-pin-dot` the dot, `is-selected` the raise+ring.
  el.className = "route-pin grid h-11 w-11 place-items-center";
  el.dataset.pin = pin.dtId;
  el.setAttribute("aria-label", pin.title ? `${pin.title} — ${pin.name}` : pin.name);
  if (selectedRef.current === pin.dtId) el.classList.add("is-selected");
  const dot = document.createElement("span");
  dot.className = `route-pin-dot ${pinClassForStage(pin.stage)}`;
  el.appendChild(dot);
  el.addEventListener("click", () => selectRef.current(pin.dtId));
  return new lib.Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(map);
}

/** Colliding pins, drawn as one count badge — tapping zooms in. */
function buildClusterMarker(
  lib: typeof import("maplibre-gl"),
  map: MapLibreMap,
  cluster: { key: string; memberDtIds: string[]; x: number; y: number },
): MapLibreMarker {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "grid h-11 w-11 place-items-center";
  el.setAttribute("aria-label", `${cluster.memberDtIds.length} trips — zoom in`);
  const badge = document.createElement("span");
  // Token colours only — the count, not a range (§8.3).
  badge.className =
    "grid h-7 min-w-7 place-items-center rounded-full border border-primary-foreground/40 bg-primary px-1.5 text-[12px] font-bold tabular-nums text-primary-foreground shadow-card";
  badge.textContent = String(cluster.memberDtIds.length);
  el.appendChild(badge);
  // The badge sits at the members' screen centroid, unprojected back to the
  // map — not snapped onto one member's pin.
  const at = map.unproject([cluster.x, cluster.y]);
  const center: [number, number] = [at.lng, at.lat];
  el.addEventListener("click", () => {
    const zoom = Math.min(map.getZoom() + 2, 12);
    if (prefersReducedMotion()) map.jumpTo({ center, zoom });
    else map.easeTo({ center, zoom, duration: CAMERA_MS });
  });
  return new lib.Marker({ element: el }).setLngLat(center).addTo(map);
}
