import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin } from "lucide-react";
import { hasWebGL2, makeMapLabelElement, MAP_LABEL_PIN_OFFSET_PX, MAP_STYLE_URL, pinClassForStage, prefersReducedMotion, type MapPadding } from "../lib/maps";
import { loadMapLibre } from "../lib/maplibre";
import { applyOverviewGlobe, shouldUseGlobe } from "../lib/globe";
import { deviceFixIfGranted, START_FIX_QUICK_MS, type DeviceFix } from "../lib/geolocation";
import { clusterPins, fitZoomCenteredOn, isOnVisibleHemisphere, normalizeLng, placeHomeLabels, selectHomeLabels, unfoldLngs, type HomeLabelPlacement, type HomeMapPin, type ProjectedPin } from "../lib/home-geo";

/** Map camera durations (DESIGN.md §10) — 400–600ms, nothing else. */
const CAMERA_MS = 500;
/** Pins closer than this on screen tap as one (a count, not a range — §8.3). */
const CLUSTER_PX = 48;
/** Never zoom past a street into a pin set — the fit's ceiling. */
const MAX_FIT_ZOOM = 12;
/** One located trip: open close enough to read it (a whole town, not a street). */
const SINGLE_PIN_ZOOM = 10;

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
 * ## The globe opens where the traveler is, when the browser already allows it
 *
 * The camera's STARTING point is the traveler's own position when this origin
 * already holds a granted location permission (#393), so the first frame faces
 * them instead of MapLibre's `[0,0]` default — and a camera the pin fit cannot
 * claim (an unmeasurable box, a padding that leaves no room) falls back to the
 * same place rather than leaving null island up. The pin fit still wins
 * whenever it has something to say: the trips are what this surface is for.
 *
 * It never prompts — `deviceFixIfGranted` asks the browser only when the
 * permission is ALREADY granted — and it never starts a tracked session: one
 * question, asked once, and the trip map's locate control stays the app's only
 * tracker.
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
    // The traveler's own starting point, once known (#393). Held here rather
    // than threaded through every call so `framePins` — which runs on load, on
    // a resize, on a sheet detent and on a late fix — can centre on it whenever
    // it has it. `null` means "no granted fix", which changes nothing.
    let currentFix: DeviceFix | null = null;
    // The globe's starting centre (#393), asked for HERE — in parallel with
    // the library load — so a browser that ALREADY holds a fix can hand it to
    // the constructor, the one way the FIRST painted frame is the traveler's
    // own patch of the world instead of MapLibre's `[0,0]` default. A real
    // first fix takes seconds, though, so the map never waits for it: what the
    // constructor does not get inside `START_FIX_QUICK_MS` is applied as a
    // re-centre when it lands (see below). Granted-only and never a session:
    // see `deviceFixIfGranted`. A `null` answer is no fix, and changes nothing.
    const startFixPromise = deviceFixIfGranted();

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
      //
      // #377 slice 2: the partition covers MARKER CONSTRUCTION, not just
      // clustering. A lone averted pin gets NO marker (its projection would
      // otherwise mirror onto the visible disc as a ghost), and a far-side
      // cluster gets no badge either (its unprojected centroid can land on
      // the visible disc). Only the facing half is clustered and painted;
      // labels ride the same partition below. Rotating the globe fires
      // `moveend`, which rebuilds — rotated-in pins come back with no new
      // rebuild system.
      const center = live.getCenter();
      const facing: ProjectedPin[] = [];
      const screenById = new Map<string, { x: number; y: number }>();
      const facingIds = new Set<string>();
      for (const p of current) {
        const pt = live.project([p.lng, p.lat]);
        const item: ProjectedPin = { dtId: p.dtId, x: pt.x, y: pt.y };
        screenById.set(p.dtId, { x: pt.x, y: pt.y });
        if (isOnVisibleHemisphere(p.lat, p.lng, center.lat, center.lng)) {
          facing.push(item);
          facingIds.add(p.dtId);
        }
      }
      const byId = new Map(current.map((p) => [p.dtId, p]));
      const facingPins = current.filter((p) => facingIds.has(p.dtId));
      const clusteredItems = clusterPins(facing, CLUSTER_PX);
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
      const labelled = selectHomeLabels(facingPins, clustered, selected);
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

    /**
     * Frame the pins. Returns whether a camera was actually APPLIED — the
     * caller needs the negative, because a fit with nothing to say (no pins,
     * an unmeasurable box, a padding that leaves no room) must fall back to
     * the traveler's own starting point rather than leave null island up
     * (#393). Every `return` below is deliberate.
     *
     * **When a granted fix is known, the CENTER IS THE TRAVELER** and the zoom
     * is the one that keeps the trips around them in view (`fitZoomCenteredOn`)
     * — the overview's middle is where you are, which is what #393 asked for.
     * Without a fix, nothing changes: the trips' own bounding box picks the
     * camera, exactly as before.
     */
    const framePins = (): boolean => {
      const live = mapRef.current;
      const lib = libRef.current;
      if (cancelled || !lib || !live) return false;
      const current = pinsRef.current;
      if (!current.length) return false;
      // Never fit into an empty box — that is the no-op that parks the camera
      // on null island (see the container note above).
      const el = ref.current;
      if (el && (!el.clientWidth || !el.clientHeight)) return false;
      const box = {
        width: el ? el.clientWidth : 0,
        height: el ? el.clientHeight : 0,
        padding: paddingRef.current,
      };
      // #393: with the traveler's own position in hand, the camera stands on
      // THEM. The zoom is capped at what the ordinary fit would have used, so
      // centring on the traveler can only ever widen the view, never crop the
      // trips further than the fit already did.
      if (currentFix) {
        const zoom = fitZoomCenteredOn(
          { lat: currentFix.lat, lng: currentFix.lng },
          current,
          box,
          current.length === 1 ? SINGLE_PIN_ZOOM : MAX_FIT_ZOOM,
        );
        if (zoom !== null) {
          const target = { center: [currentFix.lng, currentFix.lat] as [number, number], zoom };
          if (prefersReducedMotion()) live.jumpTo(target);
          else live.easeTo({ ...target, duration: CAMERA_MS });
          fixFramed = true;
          return true;
        }
        // No room to reason about a zoom (the #368 class): fall through to the
        // ordinary fit, which answers `null` here too and leaves the caller to
        // fall back to the traveler's bare centre.
      }
      if (current.length === 1) {
        const only = current[0];
        if (prefersReducedMotion()) live.jumpTo({ center: [only.lng, only.lat], zoom: SINGLE_PIN_ZOOM });
        else live.easeTo({ center: [only.lng, only.lat], zoom: SINGLE_PIN_ZOOM, duration: CAMERA_MS });
        return true;
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
      // A padding that leaves no room for the box answers `null` — the fit has
      // nothing to say (the #368 class), so the caller falls back to the
      // traveler's own starting point rather than leaving the default camera.
      if (!camera) return false;
      const at = camera.center ? lib.LngLat.convert(camera.center) : null;
      const center: [number, number] = at ? [normalizeLng(at.lng), at.lat] : [unfolded[0], current[0].lat];
      const target = { center, zoom: camera.zoom };
      if (prefersReducedMotion()) live.jumpTo(target);
      else live.easeTo({ ...target, duration: CAMERA_MS });
      return true;
    };

    // The box + padding a fit last ACTUALLY APPLIED for. A fit is expensive and
    // camera-moving, so it only re-runs when one of those changed — and a fit
    // that bailed is not an answer, so it stays retryable (see below).
    let lastFitKey = "";
    /**
     * True once a camera CENTRED ON THE TRAVELER has been applied. The fix
     * itself arriving is not that: `currentFix` may be known while the box is
     * still laying out and no camera has moved yet, which is exactly the moment
     * a bare "face them" jump is still owed.
     */
    let fixFramed = false;
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
      // Only a fit that APPLIED a camera is final for this box+padding. A fit
      // that bailed — `cameraForBounds` answering `null` because the padding left
      // no room for the box (#368), which a phone can measure while its sheet is
      // still laying out — is not an answer, so it stays retryable: a container
      // event that re-measures the SAME box+padding (MapLibre's own class
      // landing, a detent settling on the same numbers) gets a second chance
      // instead of being skipped as "already done" for the rest of the session,
      // which would leave the camera on MapLibre's `[0,0]`.
      if (framePins()) lastFitKey = key;
      rebuildMarkers();
      return true;
    };
    reframeRef.current = reframeIfOurs;

    /**
     * Hand the camera the traveler's own starting point (#393).
     *
     * Since `framePins` CENTRES on a known fix, this is the path a fix that
     * arrives LATE takes: the constructor's quick window expired, the trips
     * framed themselves, and then the browser finally answered. Re-framing puts
     * the middle back on the traveler with the trips still in view — which is
     * the whole of what #393 asked for.
     *
     * Two ways this is a no-op, both load-bearing: no granted fix (nothing to
     * move to), and a viewer who has moved the camera themselves (§10 — the
     * camera is theirs; we only ever set it up).
     */
    const applyStartFix = (fix: DeviceFix | null): void => {
      if (cancelled || !fix || tookOverRef.current) return;
      // The camera is already standing on them — nothing left to do.
      if (fixFramed) return;
      currentFix = fix;
      if (framePins()) {
        rebuildMarkers();
      } else {
        // Nothing measurable to choose a ZOOM from (a box still laying out) —
        // at least face the traveler; the ResizeObserver re-frames properly the
        // moment the container reports a size.
        mapRef.current?.jumpTo({ center: [fix.lng, fix.lat] });
      }
      ref.current?.setAttribute("data-home-start", "device-fallback");
    };

    /** The placeholder stays up until the canvas has a real box behind it. */
    const markReadyIfSized = () => {
      const el = ref.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) setReady(true);
    };

    /**
     * State the camera's own centre in the DOM (`data-home-camera`), because the
     * camera lives inside a WebGL canvas the DOM cannot read. Without this the
     * only seam is `data-home-start`, which records where the camera STARTED —
     * a starting point the pin fit then walked away from looks identical to one
     * that held, and "#393 the middle is my location" is a claim about the
     * camera the browser probe can only check here.
     */
    const publishCamera = (): void => {
      const centre = mapRef.current?.getCenter();
      if (centre) {
        ref.current?.setAttribute("data-home-camera", `${centre.lat.toFixed(2)},${centre.lng.toFixed(2)}`);
      }
    };

    void (async () => {
      try {
        // The library is the only thing the FIRST PAINT waits for (#393
        // follow-up). A real first fix is a network round-trip measured at 1.5 s
        // and up, so the constructor is handed one only when the browser already
        // held it (a cached read lands inside `START_FIX_QUICK_MS`); anything
        // slower re-centres the globe when it arrives (below) instead of holding
        // the canvas — which is what the previous version, with its 1 s budget,
        // silently failed to do on every real device.
        const lib = await loadMapLibre();
        const startFix = await Promise.race([
          startFixPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), START_FIX_QUICK_MS)),
        ]);
        if (cancelled || !ref.current) return;
        libRef.current = lib;
        map = new lib.Map({
          container: ref.current,
          style: MAP_STYLE_URL,
          attributionControl: { compact: true },
          // Start ON the traveler, when we have their own starting point
          // (#393): the same world zoom as ever, facing them rather than the
          // Gulf of Guinea. This is the constructor's centre, not a camera
          // move — nothing animates and the viewer never sees a jump.
          ...(startFix ? { center: [startFix.lng, startFix.lat] as [number, number] } : {}),
        });
        mapRef.current = map;
        // A constructor centre means the camera is BORN on the traveler — record
        // it, and hold the fix so the very first frame `framePins` draws is
        // centred on them too (the constructor centre alone would be overwritten
        // by that fit a moment later, which is exactly the bug #393 reports).
        if (startFix) currentFix = startFix;
        // Which face of the globe the camera opened on has no representation in
        // the DOM (the canvas is WebGL), so the component states it — the seam
        // the phone probe reads (`device` / `device-fallback` / `default`).
        ref.current.setAttribute("data-home-start", startFix ? "device" : "default");
        // ONE zoom control for the whole app (2026-09-23): the landing used to
        // draw its own 44px chip pair while every trip surface used MapLibre's
        // NavigationControl, so the same gesture had two looks depending on
        // where you were. This is the trip maps' control, options and corner
        // included — `showCompass` + `visualizePitch` are the way back out of a
        // tilt or a rotation (§8 terrain note).
        map.addControl(new lib.NavigationControl({ showCompass: true, visualizePitch: true }), "top-left");
        map.getCanvas().setAttribute("aria-label", "Map of your trips");
        map.on("error", () => {
          if (!cancelled && map && !map.loaded()) {
            ref.current?.setAttribute("data-map-failed", "true");
            setFailed(true);
          }
        });
        map.on("moveend", () => {
          rebuildMarkers();
          publishCamera();
        });
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
        // through the same guard the resize path uses. With a granted fix in
        // hand this frame is centred on the traveler; without one it is the
        // trips' fit, exactly as it always was.
        map.resize();
        if (!reframeIfOurs()) rebuildMarkers();
        // If the fix was not known at construction, this records that it arrived
        // and re-centres — see `applyStartFix`.
        applyStartFix(startFix);
        // A fix that missed the constructor's quick window still gets its say: a
        // slow device lands on the traveler a couple of seconds in, instead of
        // opening on null island and staying there for good. The same §10 guard
        // applies — a viewer who has already moved the camera keeps it.
        if (!startFix) {
          void startFixPromise.then((late) => {
            if (late) applyStartFix(late);
          });
        }
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
          className={`home-globe map-surface h-full w-full transition-opacity duration-300 ${
            ready ? "opacity-100" : "opacity-0"
          }`}
        />
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
