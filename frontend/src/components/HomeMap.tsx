import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin, Minus, Plus } from "lucide-react";
import { hasWebGL2, makeMapLabelElement, MAP_LABEL_PIN_OFFSET_PX, MAP_STYLE_URL, pinClassForStage, prefersReducedMotion, type MapPadding } from "../lib/maps";
import { loadMapLibre } from "../lib/maplibre";
import { applyOverviewGlobe, shouldUseGlobe } from "../lib/globe";
import { clusterPins, isOnVisibleHemisphere, normalizeLng, placeHomeLabels, selectHomeLabels, unfoldLngs, type HomeLabelPlacement, type HomeMapPin, type ProjectedPin } from "../lib/home-geo";

/** Map camera durations (DESIGN.md §10) — 400–600ms, nothing else. */
const CAMERA_MS = 500;
/** Pins closer than this on screen tap as one (a count, not a range — §8.3). */
const CLUSTER_PX = 48;
/** Never zoom past a street into a pin set — the fit's ceiling. */
const MAX_FIT_ZOOM = 12;

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
 * The canvas renders on the landing globe (#372 slice 1): the shared
 * `lib/globe.ts` machinery (`setProjection({ type: "globe" })` + the token-sky
 * atmosphere), routed through the one `shouldUseGlobe` rule. The camera,
 * clustering and marker grammar below are unchanged.
 *
 * The map answers "where", the bands answer "what": no routes, no legs, one
 * dot per trip, stage-coloured. Colliding pins group into a count badge that
 * zooms in on tap. Unclustered pins carry a visible title label (#372 slice
 * 2): the `map-place-label` pill below the pin, the trip title only — the dot
 * keeps the stage colour, the anchor name stays in the pin's `aria-label`,
 * and clusters show counts, never labels. The bands are the keyboard-reachable
 * list equivalent (§11); pins are real `<button>`s all the same, so pointer
 * and keyboard reach the same trips.
 *
 * ## The container must carry its OWN height (do not "simplify" this)
 *
 * The map box is `h-full w-full`, **not** `absolute inset-0`, and that is
 * load-bearing. MapLibre adds its `maplibregl-map` class to whatever element it
 * is handed, and `maplibre-gl.css` ships UNLAYERED:
 *
 * ```css
 * .maplibregl-map { position: relative; }
 * ```
 *
 * Unlayered rules beat every `@layer` rule, so Tailwind's `@layer utilities`
 * `.absolute` loses the moment the class lands — measured: the container's
 * computed `position` flips `absolute` → `relative` at the instant the map is
 * constructed. With no in-flow children (the canvas is absolutely positioned),
 * `position: relative` + `height: auto` collapses the box to **0**, MapLibre
 * measures 0 and keeps its default 300px canvas, and `fitBounds` into a
 * 0-height box is a silent no-op: the camera stays at zoom 0 / null island and
 * every pin is painted off-screen. On a phone that never recovered (the sheet's
 * layout settles without a *window* resize, so MapLibre's own `trackResize`
 * never fires); on desktop a later rebuild masked it.
 *
 * So: give the box a height that does not depend on which `position` wins, and
 * keep the canvas honest with a `ResizeObserver`. Anything else reintroduces a
 * bug that only shows on one viewport and only sometimes.
 *
 * ## The camera is still explicit-intent-only (§10)
 *
 * Re-framing happens on the initial load, on a container resize, and when the
 * camera padding changes (the sheet detent moves the visible band) — but only
 * until the viewer moves the map themselves. After that, only `resize()` runs;
 * the camera is theirs.
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
  // True once the VIEWER has moved the camera (a drag, a pinch, a wheel, the
  // zoom chips). From then on the map only ever resizes — auto-framing under
  // someone's hands is the §10 violation the trip maps already guard against.
  const tookOverRef = useRef(false);
  // The build effect publishes its "re-frame if the camera is still ours"
  // closure here, so the padding effect can reach it without rebuilding the
  // map (a rebuild would throw the camera away on every sheet detent).
  const reframeRef = useRef<(() => void) | null>(null);
  // `pins` is built inline by the caller, so its identity changes every
  // render — key the effects on the contents instead of the array.
  const pinsKey = pins.map((p) => `${p.dtId}:${p.lat},${p.lng}:${p.stage}`).join("|");
  const paddingKey = `${padding.top},${padding.right},${padding.bottom},${padding.left}`;

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
    let resizeObserver: ResizeObserver | null = null;

    const rebuildMarkers = () => {
      const lib = libRef.current;
      const live = mapRef.current;
      if (cancelled || !lib || !live) return;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      const current = pinsRef.current;
      if (!current.length) return;
      // On the globe a pin's screen projection survives the horizon, so
      // screen distance alone cannot decide what clusters with what (#372
      // slice 1): partition by the camera's hemisphere first, then cluster
      // each half separately. A pin over the horizon never joins a visible
      // cluster even when `project` lands it on top of one; the limb itself
      // still counts as visible (`isOnVisibleHemisphere`).
      const center = live.getCenter();
      const facing: ProjectedPin[] = [];
      const averted: ProjectedPin[] = [];
      const screenById = new Map<string, { x: number; y: number }>();
      for (const p of current) {
        const pt = live.project([p.lng, p.lat]);
        const item: ProjectedPin = { dtId: p.dtId, x: pt.x, y: pt.y };
        screenById.set(p.dtId, { x: pt.x, y: pt.y });
        (isOnVisibleHemisphere(p.lat, p.lng, center.lat, center.lng) ? facing : averted).push(item);
      }
      const byId = new Map(current.map((p) => [p.dtId, p]));
      const clusteredItems = [...clusterPins(facing, CLUSTER_PX), ...clusterPins(averted, CLUSTER_PX)];
      const clustered = new Set<string>();
      for (const item of clusteredItems) {
        if (item.kind === "cluster") {
          for (const id of item.cluster.memberDtIds) clustered.add(id);
        }
      }
      for (const item of clusteredItems) {
        if (item.kind === "cluster") {
          markersRef.current.push(buildClusterMarker(lib, live, item.cluster));
        } else {
          const pin = byId.get(item.pin.dtId);
          if (pin) markersRef.current.push(buildPinMarker(lib, live, pin, selectedRef, selectRef));
        }
      }
      // Title labels (#372 slice 2): the same rebuild, the same marker array
      // — no second rebuild system, no new state. `selectHomeLabels` decides
      // (cap, selected-first, no labels for clusters) and takes NO zoom: on
      // the globe a settled phone camera lives at NEGATIVE zoom (measured
      // −2.28 at 390×844), so any floor here hides every label on the device
      // that asked for them — see the rule's doc comment. `placeHomeLabels`
      // (#375) then fits each pill inside the box — capped width, edge clamp,
      // bottom flip, overlap drop — from the projections above and the live
      // container size. The pill sits BELOW its pin so a label can never
      // cover it, is `pointer-events-none` so it never steals a tap, and the
      // zoom chips are DOM chrome above the canvas so they are never covered.
      const selected = selectedRef.current;
      const labelled = selectHomeLabels(current, clustered, selected);
      const box = ref.current;
      const placed = placeHomeLabels(
        labelled,
        screenById,
        box?.clientWidth ?? 0,
        box?.clientHeight ?? 0,
      );
      const placedById = new Map(placed.map((p) => [p.dtId, p]));
      for (const pin of labelled) {
        const placement = placedById.get(pin.dtId);
        // An overlap-dropped pill paints nothing — its pin stays.
        if (!placement) continue;
        markersRef.current.push(buildTitleLabelMarker(lib, live, pin, selected === pin.dtId, placement));
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
      // Never fit into an empty box — that is the no-op that parks the camera
      // on null island (see the container note above).
      const el = ref.current;
      if (el && (!el.clientWidth || !el.clientHeight)) return;
      if (current.length === 1) {
        const only = current[0];
        if (prefersReducedMotion()) live.jumpTo({ center: [only.lng, only.lat], zoom: 10 });
        else live.easeTo({ center: [only.lng, only.lat], zoom: 10, duration: CAMERA_MS });
        return;
      }
      // Longitudes unfolded around their widest gap, so a set spanning the
      // antimeridian is measured by its SHORTEST arc and not the long way round
      // (`unfoldLngs` — this is what makes a three-continent pin set fit a
      // phone; see the helper's note).
      const unfolded = unfoldLngs(current.map((p) => p.lng));
      const bounds = new lib.LngLatBounds();
      current.forEach((p, i) => bounds.extend([unfolded[i], p.lat]));
      // Compute the camera and apply it, rather than `fitBounds`: MapLibre 6
      // routes fitBounds through `flyTo`, whose arc was measured leaving the
      // zoom and the latitude at their PREVIOUS values (only the centre moved)
      // when the fit had to zoom out — and an explicit camera also lets the
      // centre be normalised back out of the unfolded frame.
      const camera = live.cameraForBounds(bounds, {
        padding: paddingRef.current,
        maxZoom: MAX_FIT_ZOOM,
      });
      if (!camera) return;
      const at = camera.center ? lib.LngLat.convert(camera.center) : null;
      const center: [number, number] = at ? [normalizeLng(at.lng), at.lat] : [unfolded[0], current[0].lat];
      const target = { center, zoom: camera.zoom };
      if (prefersReducedMotion()) live.jumpTo(target);
      else live.easeTo({ ...target, duration: CAMERA_MS });
    };

    // The box + padding a fit was last computed for. A fit is expensive and
    // camera-moving, so it only re-runs when one of those actually changed.
    let lastFitKey = "";
    /**
     * Frame the pins, unless the viewer owns the camera now. Cheap to call: it
     * exits before touching the map whenever nothing relevant changed.
     * Returns true when it framed — the caller then knows the markers were
     * rebuilt too, so it does not rebuild them a second time.
     */
    const reframeIfOurs = (): boolean => {
      if (cancelled || tookOverRef.current) return false;
      const el = ref.current;
      const live = mapRef.current;
      if (!el || !live) return false;
      if (!el.clientWidth || !el.clientHeight) return false;
      const key = `${el.clientWidth}x${el.clientHeight}|${paddingKeyOf(paddingRef.current)}`;
      if (key === lastFitKey) return false;
      lastFitKey = key;
      framePins();
      rebuildMarkers();
      return true;
    };
    reframeRef.current = reframeIfOurs;

    /** The placeholder stays up until the canvas has a real box behind it. */
    const markReadyIfSized = () => {
      const el = ref.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) setReady(true);
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
        // A gesture, not a programmatic move: MapLibre only sets `originalEvent`
        // when a real pointer/keyboard was behind it.
        const onUserIntent = (e?: { originalEvent?: unknown }) => {
          if (e?.originalEvent) tookOverRef.current = true;
        };
        map.on("dragstart", onUserIntent);
        map.on("zoomstart", onUserIntent);
        map.on("rotatestart", onUserIntent);
        map.on("pitchstart", onUserIntent);
        await new Promise<void>((resolve) => {
          if (map!.loaded()) resolve();
          else map!.once("load", () => resolve());
        });
        if (cancelled || !map) return;
        // Landing globe (#372 slice 1): the signed-in home renders on a
        // globe with the token-sky atmosphere. Screen-only by construction —
        // this canvas is never printed (the booklet renders trip docs, never
        // this surface) and never compact, so the pdf/compact gates pass
        // through. Still routed through the one `shouldUseGlobe` rule rather
        // than hardcoded, so there is one projection rule, not two — and no
        // per-trip projection knob.
        const isPdfRender =
          typeof window !== "undefined" &&
          (window as unknown as Record<string, unknown>).__KISEKI_PDF_RENDER__ === true;
        const skyEl = ref.current;
        if (skyEl && shouldUseGlobe({ globe: true, isPdfRender, compact: false })) {
          applyOverviewGlobe(map, skyEl);
        }
        // The container may have been 0-sized (or a different size) all through
        // the library load, so give the canvas the box it has NOW and then frame
        // through the same guard the resize path uses.
        map.resize();
        if (!reframeIfOurs()) rebuildMarkers();
        markReadyIfSized();
        // A container-only size change (the rail dragging, a detent, a phone's
        // chrome collapsing, MapLibre's own class landing) is something
        // MapLibre's `trackResize` never sees — it listens to the WINDOW only.
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            if (cancelled || !mapRef.current) return;
            mapRef.current.resize();
            reframeIfOurs();
            markReadyIfSized();
          });
          resizeObserver.observe(ref.current);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      reframeRef.current = null;
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

  // The visible band moves when the sheet detent does, so the camera has to be
  // re-fitted — the same "padding is a camera instruction" contract `SplitView`
  // documents for the trip maps. It never rebuilds the map, and it is a no-op
  // once the viewer has moved the camera themselves.
  useEffect(() => {
    reframeRef.current?.();
  }, [paddingKey]);

  // Selection restyle without a camera move: retoggle the classes in place.
  useEffect(() => {
    ref.current?.classList.toggle("route-map-focused", selectedDtId != null);
    const container = ref.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>("[data-pin]").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.pin === selectedDtId);
    });
    // The title labels ride the same in-place restyle — no rebuild.
    container.querySelectorAll<HTMLElement>("[data-home-label]").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.homeLabel === selectedDtId);
    });
  }, [selectedDtId, ready]);

  const state = empty ? "empty" : failed ? "failed" : webgl2 === false ? "no-webgl2" : ready ? "ready" : "idle";

  const zoomBy = (delta: number) => {
    const live = mapRef.current;
    if (!live) return;
    // Asking for a specific zoom IS taking the camera.
    tookOverRef.current = true;
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
          /* `h-full w-full`, NOT `absolute inset-0`: MapLibre's unlayered
             `.maplibregl-map{position:relative}` defeats Tailwind's `.absolute`,
             and a relative box with no in-flow children is 0 tall. See the
             component doc comment — this line is the bug fix. */
          className={`map-surface h-full w-full transition-opacity duration-300 ${
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

/** A padding's identity, for the "did anything the fit cares about change" key. */
function paddingKeyOf(padding: MapPadding): string {
  return `${padding.top},${padding.right},${padding.bottom},${padding.left}`;
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

/** One trip's title label (#372 slice 2, geometry #375): the pill vocabulary,
 *  below its pin unless the box says otherwise. */
function buildTitleLabelMarker(
  lib: typeof import("maplibre-gl"),
  map: MapLibreMap,
  pin: HomeMapPin,
  selected: boolean,
  placement: HomeLabelPlacement,
): MapLibreMarker {
  // The title only — no number, no second index. The dot keeps the stage
  // colour; the anchor name stays in the pin button's `aria-label`. The pill
  // class carries `pointer-events-none` + the heading font + `bg-surface/90`
  // (token colours only, never hex) and is `aria-hidden`: the pin button is
  // the accessible name, the label is paint. `is-home` caps the width with
  // an ellipsis; `title` keeps the full text.
  const el = makeMapLabelElement(pin.title, { home: true });
  el.dataset.homeLabel = pin.dtId;
  if (selected) el.classList.add("is-selected");
  // Edge clamp (#375): the marker offset shifts the pill so it stays inside
  // the box; a bottom flip puts it above the pin instead of below.
  const flipped = placement.anchor === "bottom";
  return new lib.Marker({
    element: el,
    anchor: flipped ? "bottom" : "top",
    offset: [placement.offsetX, flipped ? -MAP_LABEL_PIN_OFFSET_PX : MAP_LABEL_PIN_OFFSET_PX] as [number, number],
  })
    .setLngLat([pin.lng, pin.lat])
    .addTo(map);
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
