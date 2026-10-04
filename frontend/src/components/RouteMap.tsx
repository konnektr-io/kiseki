import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Locate, LocateFixed, Maximize2, X } from "lucide-react";
import { useTrip } from "./theme";
import {
  applyBasemapTint,
  EXCURSION_LABEL_DIAMOND_OFFSET_PX,
  farEnoughApart,
  fetchRouteLegs,
  formatMapLabel,
  hasWebGL2,
  makeMapChipLabelElement,
  makeMapExcursionLabelElement,
  makeMapLabelElement,
  MAP_LABEL_PIN_OFFSET_PX,
  MAP_LABEL_ZOOM_FLOOR,
  markerNumber,
  markerPinClass,
  orderExcursionLabels,
  pinScaleAtZoom,
  prefersReducedMotion,
  resolveMapStyle,
  ROUTE_BODY_WIDTH,
  ROUTE_CASING_OPACITY,
  ROUTE_CASING_WIDTH,
  selectChipLabels,
  selectMapLabels,
  type MapPadding,
  type RouteLeg,
} from "../lib/maps";
import { loadMapLibre } from "../lib/maplibre";
import { CLUSTER_PX, clusterMarkers, type PinCluster } from "../lib/marker-cluster";
import { fetchTrack, trackDataUrl, trackSegments, type TrackSegment } from "../lib/tracks";
import { greatCircle, legModes, markerPaintRank, placeRole, resolveLegCoordinates, type Journey } from "../lib/route-surface";
import {
  addLegGlyphLayer,
  classifiedGlyphMode,
  legGlyphMode,
  legGlyphPoints,
  registerLegGlyphs,
  type LegGlyphFeature,
} from "../lib/leg-glyphs";
import type { TransportMode } from "../lib/transport";
import type { DaySurface } from "../lib/day-surface";
import { addTerrain } from "../lib/terrain";
import { mapColors } from "../lib/tokens";
import { accuracyRadiusPx, locateControl, type DeviceFix } from "../lib/geolocation";
import { startTrackingDeviceIfPermitted, useDeviceLocation } from "../lib/device-location";
import type { TripLocation } from "../lib/types";

/** Map camera durations (DESIGN.md §10) — 400–600ms, nothing else. */
const CAMERA_MS = 500;

/** MapLibre source + layer id for the device accuracy halo (#383). One id for
 *  both, so the zoom listener and the fix effect cannot drift apart. */
const DEVICE_SOURCE = "device-accuracy";

/**
 * The accuracy halo's geometry: one point at the fix — the RADIUS is a paint
 * property (metres → pixels at the current zoom), never geometry, because a
 * hand-built polygon in degrees would be wrong at every latitude.
 */
function deviceHalo(fix: DeviceFix | null) {
  return {
    type: "FeatureCollection" as const,
    features: fix
      ? [
          {
            type: "Feature" as const,
            properties: {},
            geometry: {
              type: "Point" as const,
              coordinates: [fix.lng, fix.lat] as [number, number],
            },
          },
        ]
      : [],
  };
}

/** One resolved leg to draw, scan or day. */
interface LegFeature {
  coordinates: [number, number][];
  stage: string;
  road: boolean;
  /** Transport glyph for the leg, if its data declares one (#357 slice 3B). */
  glyph: TransportMode | null;
}

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
  /** The whole journey (scan level) — read through a ref inside the effects. */
  journey: Journey;
  /** Camera keep-out for the sheet/rail occlusion — see `SplitView`. */
  padding: MapPadding;
  /* ---- scan level ---- */
  selected: TripLocation | null;
  onSelect: (loc: TripLocation) => void;
  /** Places of the chapter currently in view (scroll-spy, #92) — their pins
   *  stay full-strength while the rest dim. Null = no spy / a selection owns
   *  the focus story. */
  spyPlaces: string[] | null;
  /* ---- day level (#90) — null `day` = scan level ---- */
  day: DaySurface | null;
  dayIdx: number | null;
  /** The selected day block id — its chip rings, its card pulses in the rail. */
  activeBlock: string | null;
  /** Chip / day-pin tap from the map. `""` clears the chip focus. */
  onBlockTap: (blockId: string) => void;
}

/**
 * The trip map SURFACE (DESIGN.md §7.6): ONE MapLibre instance serving BOTH
 * levels — the itinerary scan (#92) and the day read (#90) — that stays
 * mounted while the app navigates between them. Only the markers, the line
 * layers and the camera change with the level; the map never remounts, so
 * there is no basemap flash and no tile re-fetch on day→day moves.
 *
 * Scan level draws the whole journey: numbered stop pins, excursion diamonds,
 * legs styled by their own state. Day level draws THAT DAY's world: the same
 * numbered place pins (the registry through-line, §8.3), letter chips for the
 * day's activities, and cased polylines for the day's drive legs — flights
 * appear as endpoint pins only, never an arc (#90).
 *
 * This is not `MapView` with a bigger box. `MapView` is a document-surface
 * card — fixed height, one shot, and the booklet PDF renders through it, so it
 * stays exactly as it is. A surface map fills its container, is driven by
 * selection and camera padding from outside, and is **never printed**: the
 * booklet's route map is still `MapView`'s (#37), which is why nothing here
 * carries the `data-maplibre` handshake the PDF waiter looks for.
 */
export function RouteMap({
  journey,
  padding,
  selected,
  onSelect,
  spyPlaces,
  day,
  dayIdx,
  activeBlock,
  onBlockTap,
}: RouteMapProps) {
  const trip = useTrip();
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  /** The maplibre module, captured at mount — the level effect needs its
   *  `Marker`/`LngLatBounds` constructors and re-importing is pointless. */
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  /** Live marker elements by identity: place name (pins/diamonds) or the
   *  chip's FIRST block id (letter chips). */
  const markersRef = useRef<Map<string, HTMLElement>>(new Map());
  /** Chip coordinates by first-block id — the tap↔card flyTo. */
  const chipPosRef = useRef<Map<string, [number, number]>>(new Map());
  const fitJourneyRef = useRef<(() => void) | null>(null);
  const fitDayRef = useRef<(() => void) | null>(null);
  // Live props, read through refs inside effects so those effects can key on
  // STABLE identities (level key, legs data) instead of objects rebuilt every
  // render.
  const journeyRef = useRef(journey);
  journeyRef.current = journey;
  const dayRef = useRef(day);
  dayRef.current = day;
  const dayIdxRef = useRef(dayIdx);
  dayIdxRef.current = dayIdx;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onBlockTapRef = useRef(onBlockTap);
  onBlockTapRef.current = onBlockTap;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** On-map label markers, owned by the level build + selection rebuilds. */
  const labelMarkersRef = useRef<MapLibreMarker[]>([]);
  /** Day-level chip label markers (#361 slice 6) — a separate layer from the
   *  place labels above, owned by the day build + the chip-focus rebuild. */
  const chipLabelMarkersRef = useRef<MapLibreMarker[]>([]);
  /** Excursion (diamond) label markers (#388 follow-up) — the scan level's
   *  third, QUIETEST label layer: secondary names for the venues beside the
   *  numbered stops, owned by the scan build + its selection/zoom rebuilds. */
  const excursionLabelMarkersRef = useRef<MapLibreMarker[]>([]);
  /** Cluster badge bookkeeping (#398), so the selection effect can answer for a
   *  venue that has no diamond of its own: member place name → its cluster's
   *  key, cluster key → its badge element, and cluster key → its camera centre.
   *  All three are set by the scan build and cleared in its teardown. */
  const clusterMembersRef = useRef<Map<string, string>>(new Map());
  const clusterMarkerElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const clusterCentersRef = useRef<Map<string, [number, number]>>(new Map());
  /** The numbered stop-pin ELEMENTS, by place name — a cluster badge needs their
   *  screen positions to avoid being drawn underneath one (#402). Kept separate
   *  from `markersRef`, whose keys are shared with cluster badges. */
  const stopPinEls = useRef<Map<string, HTMLElement>>(new Map());
  /** Bumped whenever the cluster set changes, so the scroll-spy pass can re-run
   *  for a badge that appeared after its own effect last fired (#398). */
  const [clusterRevision, setClusterRevision] = useState(0);
  /** Transport sprite modes registered on the map (mount effect) — levels
   *  only add sources + layers on top. */
  const glyphModesRef = useRef<TransportMode[]>([]);
  /** Rebuild the label layer for a selected place — assigned by the level
   *  effect (it owns the level's place list), called by selection + zoom. */
  const rebuildLabelsRef = useRef<((selectedName: string | null) => void) | null>(null);
  /** Rebuild the day-level chip label layer for a focused chip — assigned by
   *  the day build (it owns the chip list), called by the chip-focus effect
   *  so the focused chip's label always wins without rebuilding the level. */
  const rebuildChipLabelsRef = useRef<((active: string | null) => void) | null>(null);
  /** Same seam for the scan level's excursion (diamond) labels — assigned by
   *  the scan build (it owns the excursion list), called by the selection
   *  effect and by camera settle. */
  const rebuildExcursionLabelsRef = useRef<((selectedName: string | null) => void) | null>(null);
  /** Re-cluster the scan level's diamonds for the current camera (#398) —
   *  assigned by the scan build, called by the zoomend backfill. */
  const rebuildExcursionClustersRef = useRef<(() => void) | null>(null);
  const activeBlockRef = useRef(activeBlock);
  activeBlockRef.current = activeBlock;

  const isDay = day != null;

  /* ---- the traveler's own position (#383) ---- */
  /** The device-location session — module store, so it survives a level change
   *  and is readable by the chat drawer at send time (lib/device-location). */
  const { state: device, start: startLocate, stop: stopLocate, dismissNotice } = useDeviceLocation();
  /** Whether the CAMERA is following the dot. On from the tap that starts or
   *  recentres, off the moment the traveler moves the map themselves: the
   *  camera is theirs, and an unexplained snap-back is the worst thing a
   *  locate control can do (the same rule Apple/Google Maps use). */
  const [following, setFollowing] = useState(false);
  /** A centre-once is pending for the next fix — the tap usually lands before
   *  the first fix exists (it may be the tap that triggers the permission
   *  prompt), so the flight happens when a position actually arrives. */
  const recentreRef = useRef(false);
  /** The dot marker — a DOM element like the pins, so no colour is ever
   *  written in JS (`.route-locate-dot` off `--map-locate`). */
  const locateMarkerRef = useRef<MapLibreMarker | null>(null);
  /** The fix the halo is drawn for, shared by the zoom listener (radius) and
   *  the fix effect (data) — neither can derive it from the other. */
  const haloFixRef = useRef<DeviceFix | null>(null);
  /** Re-derive the halo radius for the current camera — assigned by the mount
   *  effect (it owns the zoom listener) and called when a fix lands. */
  const syncHaloRef = useRef<(() => void) | null>(null);
  /** Live mirror of `following` for the map's own event listeners, which are
   *  registered once and must not close over a stale state. */
  const followingRef = useRef(following);
  followingRef.current = following;

  // v6 dropped the WebGL1 fallback entirely, so this is a hard gate, not a
  // preference — without WebGL2 the constructor throws (DESIGN.md §8.2).
  const [webgl2] = useState(hasWebGL2);

  /* A trip map never ASKS for location on its own (#383): it starts watching
   * only when the browser already grants it for this origin — a returning
   * traveler sees their dot straight away, and everyone else sees an idle
   * control until they tap it. A prompt on load is how an app teaches people
   * to deny, and a denial is sticky. */
  useEffect(() => {
    if (!webgl2) return;
    startTrackingDeviceIfPermitted();
  }, [webgl2]);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  /** Journey leg geometry from the backend (scan level). `undefined` = still
   *  fetching, `null` = nothing to fetch (no legs / maps unconfigured). */
  const [legsData, setLegsData] = useState<LegFeature[] | null | undefined>(undefined);
  /** Day leg geometry (#104): real road route per declared day leg, same
   *  fetch pathway as the scan level. `undefined` = fetching, `null` = the
   *  fetch answered unusable (maps unconfigured / API miss) — the day map
   *  then falls back to the straight pair, drawn DASHED so it never poses as
   *  a road. Keyed on the day's leg pair list so a day→day level change
   *  refetches only when the pairs actually differ. */
  const [dayLegsData, setDayLegsData] = useState<Map<string, LegFeature> | null | undefined>(undefined);
  const dayLegKey = day?.legs.map((l) => `${l.from.name}>${l.to.name}`).join("|") ?? "";
  /** Recorded track geometry (#193), blockId → its drawable segments. Each
   *  segment is a classified leg (#290): ride = solid, lift = dashed — so a
   *  day map can show the shape of the day the way Slopes/Strava do. Empty =
   *  none on the day (or every fetch missed — the card's download link stays). */
  const [dayTracksData, setDayTracksData] = useState<Map<string, TrackSegment[]>>(new Map());
  const dayTracksKey = (day?.tracks ?? []).map((t) => t.url).join("|");

  useEffect(() => {
    // Only the day level fetches here; the scan fetch is the mount effect's.
    if (!isDay || !webgl2 || !ready) return;
    const legs = day?.legs ?? [];
    if (!legs.length) {
      setDayLegsData(null);
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    (async () => {
      try {
        // One backend call per unique ordered pair (the endpoint routes a
        // comma-separated place list; a single A→B call is exactly one leg).
        // Unique-ified because a day can repeat a pair (out-and-back). Each
        // call carries that pair's declared transport mode — flight/ferry legs
        // are answered with straight geometry (road: false), never a car
        // route; drive/train/unclassified ride as the historical default.
        const pairs = [...new Set(legs.map((l) => [l.from.name, l.to.name] as const).map((p) => p.join(">")))];
        const modeByPair = new Map<string, string | null>();
        for (const l of legs) {
          const key = `${l.from.name}>${l.to.name}`;
          if (!modeByPair.has(key)) modeByPair.set(key, l.mode ?? null);
        }
        const fetchedLists = await Promise.all(
          pairs.map((p) => {
            const [a, b] = p.split(">");
            return fetchRouteLegs(trip, [a, b], false, abort.signal, [modeByPair.get(p) ?? null]);
          }),
        );
        if (cancelled) return;
        const byPair = new Map<string, RouteLeg | null>();
        pairs.forEach((p, i) => byPair.set(p, fetchedLists[i]?.[0] ?? null));
        const anyUsable = [...byPair.values()].some((h) => h && h.road);
        if (!anyUsable) {
          // Maps unconfigured or every leg missed — the DASHED straight-pair
          // fallback below, never a fake solid road.
          setDayLegsData(null);
          return;
        }
        setDayLegsData(
          new Map(
            legs.map((l) => {
              const hit = byPair.get(`${l.from.name}>${l.to.name}`) ?? null;
              return [
                `${l.from.name}>${l.to.name}`,
                {
                  stage: l.stage,
                  road: hit?.road ?? false,
                  // A road:false hit draws the §8.4 great-circle arc, never
                  // the straight backend line (#357 slice 3A).
                  coordinates:
                    hit != null
                      ? resolveLegCoordinates(hit)
                      : greatCircle([l.from.lng!, l.from.lat!], [l.to.lng!, l.to.lat!]),
                  glyph: legGlyphMode({
                    road: hit?.road ?? false,
                    mode: classifiedGlyphMode(l.block),
                  }),
                } satisfies LegFeature,
              ] as const;
            }),
          ),
        );
      } catch {
        if (!cancelled) setDayLegsData(null);
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
    // `trip` is stable across a level change; the day's pair list is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDay, ready, webgl2, dayLegKey]);

  useEffect(() => {
    // Recorded tracks ride the same readiness gate as the day legs: the map
    // exists, the level is the day, and the track list is the key — a failed
    // fetch is an empty line set, never a broken level.
    if (!isDay || !webgl2 || !ready) return;
    const list = dayRef.current?.tracks ?? [];
    if (!list.length) {
      setDayTracksData(new Map());
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    (async () => {
      try {
        const fetched = await Promise.all(
          list.map(async (t) => {
            const url = trackDataUrl(t.url);
            if (!url) return null;
            try {
              const feature = await fetchTrack(url, abort.signal);
              return [t.blockId, trackSegments(feature)] as const;
            } catch {
              return null;
            }
          }),
        );
        if (!cancelled) setDayTracksData(new Map(fetched.filter((f): f is NonNullable<typeof f> => f != null)));
      } catch {
        if (!cancelled) setDayTracksData(new Map());
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
    // The track URL list is the key; the surface object itself is rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDay, ready, webgl2, dayTracksKey]);

  const journeyKey =
    journey.legs.map((l) => `${l.from.name}>${l.to.name}:${l.stage}`).join("|") +
    "#" +
    journey.stops.map((s) => s.name).join(",") +
    "#" +
    journey.excursions.map((s) => s.name).join(",") +
    (journey.loop ? "#loop" : "");

  /* ------------------------------------------------------------------ */
  /* Mount: the map instance itself, terrain, and the journey leg fetch. */
  /* Level content (markers, layers, camera) is the NEXT effect.         */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!webgl2 || !ref.current || journeyRef.current.stops.length < 1) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    const abort = new AbortController();

    (async () => {
      try {
        const lib = await loadMapLibre();
        if (cancelled || !ref.current) return;
        libRef.current = lib;

        const bounds = new lib.LngLatBounds();
        journeyRef.current.stops.forEach((s) => bounds.extend([s.lng!, s.lat!]));
        journeyRef.current.excursions.forEach((s) => bounds.extend([s.lng!, s.lat!]));

        // Same preset voice as the card maps (#40) — one derivation, both surfaces.
        const mapStyle = resolveMapStyle(trip);
        map = new lib.Map({
          container: ref.current,
          style: mapStyle.styleUrl,
          attributionControl: { compact: true },
          bounds: journeyRef.current.stops.length > 1 ? bounds : undefined,
          center:
            journeyRef.current.stops.length === 1
              ? [journeyRef.current.stops[0].lng!, journeyRef.current.stops[0].lat!]
              : undefined,
          zoom: journeyRef.current.stops.length === 1 ? 9 : undefined,
          fitBoundsOptions: { padding: paddingRef.current, maxZoom: 12 },
        });
        mapRef.current = map;

        map.addControl(new lib.NavigationControl({ showCompass: true, visualizePitch: true }), "top-left");
        /** A gesture on the map is the traveler taking the wheel (#383):
         *  following yields at once and the control starts offering "come back
         *  to me" instead. `dragstart` is pointer-only, but `zoomstart` fires
         *  for the map's own `easeTo`/`fitBounds` too — without the
         *  `originalEvent` test, Kiseki's own camera work would pause follow. */
        const onUserGesture = (e: { originalEvent?: unknown }) => {
          if (e?.originalEvent == null) return;
          if (!followingRef.current) return;
          followingRef.current = false;
          setFollowing(false);
        };
        map.on("dragstart", onUserGesture);
        map.on("zoomstart", onUserGesture);
        /** The halo's radius is metres at the current ground resolution, and
         *  MapLibre's `circle-radius` is always PIXELS — so this is the one
         *  device-location value that has to be recomputed on zoom. Before the
         *  layer exists (or after the map is gone) it is a no-op. */
        const syncHalo = () => {
          if (!map || !map.getLayer(DEVICE_SOURCE)) return;
          const fix = haloFixRef.current;
          map.setPaintProperty(
            DEVICE_SOURCE,
            "circle-radius",
            fix ? accuracyRadiusPx(fix.accuracy, fix.lat, map.getZoom() ?? 0) : 0,
          );
        };
        syncHaloRef.current = syncHalo;
        // Zoom-scaled pins (#357 slice 2): --pin-scale shrinks the visible
        // dot toward ~22px at journey zoom; the 44px hit target never moves.
        // Below the collision zoom the label layer drops (pins stay).
        const syncZoom = () => {
          if (!map || !ref.current) return;
          const z = map.getZoom() ?? 0;
          ref.current.style.setProperty("--pin-scale", String(pinScaleAtZoom(z)));
          ref.current.classList.toggle("map-labels-off", z < MAP_LABEL_ZOOM_FLOOR);
          // The DOM contract for the session, same idea as `data-device-location`
          // below: the live zoom has no DOM representation of its own. Publishing
          // it lets a probe assert a camera-dependent claim as a measured fact
          // instead of a guess — and it is how the excursion label layer's own
          // display curve (#388 follow-up) gets sampled zoom by zoom.
          ref.current.dataset.mapZoom = z.toFixed(2);
          syncHalo();
        };
        map.on("zoom", syncZoom);
        syncZoom();
        // Zoomed in from below the floor with no labels built: build them now
        // (either layer — a chip-only day leaves the place layer empty).
        // The excursion layer (#388 follow-up) joins the check because its own
        // gate is camera-dependent too: closing on a venue cluster must reveal
        // its names without needing a selection change to nudge them.
        map.on("zoomend", () => {
          if (labelMarkersRef.current.length === 0 && chipLabelMarkersRef.current.length === 0) {
            rebuildLabelsRef.current?.(selectedRef.current?.name ?? null);
            rebuildChipLabelsRef.current?.(activeBlockRef.current);
          }
          if (excursionLabelMarkersRef.current.length === 0) {
            rebuildExcursionLabelsRef.current?.(selectedRef.current?.name ?? null);
          }
          // Clustering is camera-dependent (#398): crossing the separation
          // threshold on the way in must hand the venues back as diamonds.
          rebuildExcursionClustersRef.current?.();
        });
        const syncOriented = () => {
          if (!map || !ref.current) return;
          ref.current.classList.toggle("map-oriented", map.getBearing() !== 0 || map.getPitch() !== 0);
        };
        map.on("rotate", syncOriented);
        map.on("pitch", syncOriented);

        map.on("error", () => {
          if (!cancelled && !map?.loaded()) setFailed(true);
        });

        await new Promise<void>((resolve) => {
          if (map!.loaded()) resolve();
          else map!.once("load", () => resolve());
        });
        if (cancelled || !map) return;

        // Preset tint of the base layers (#40 D2) — repaint, never re-author.
        applyBasemapTint(map, mapStyle.tint);

        // The traveler's accuracy halo (#383): a real circle layer, created
        // with the map and BEFORE any level's route layers, so the trip always
        // draws on top of it. The radius (metres → px) rides `syncHalo`, which
        // the zoom listener and every new fix call; the data is one point.
        map.addSource(DEVICE_SOURCE, { type: "geojson", data: deviceHalo(null) });
        map.addLayer({
          id: DEVICE_SOURCE,
          type: "circle",
          source: DEVICE_SOURCE,
          paint: {
            "circle-color": mapColors(map.getContainer()).locate,
            "circle-opacity": 0.16,
            "circle-radius": 0,
            "circle-stroke-color": mapColors(map.getContainer()).locate,
            "circle-stroke-opacity": 0.35,
            "circle-stroke-width": 1,
          },
        });
        syncHalo();

        // Transport glyph sprites (#357 slice 3B) — registered once per map
        // instance; levels only add sources + layers. A failed registration
        // draws the route glyph-less, never broken.
        try {
          glyphModesRef.current = await registerLegGlyphs(map, mapColors(map.getContainer()));
        } catch {
          glyphModesRef.current = [];
        }

        // Elevation first, so the route lands ON TOP of the hillshade (#38).
        // Deliberately not awaited — a slow DEM must not hold up the line the
        // surface exists to draw.
        void addTerrain(map, lib, mapStyle.terrain);

        // Real geometry when the backend can give it; the trip's own
        // coordinates when it can't (maps unconfigured, or a leg with no road
        // route). A surface whose whole point is the route must draw SOMETHING.
        // `chain` + `loop` is exactly the pair list `journey.legs` describes:
        // the backend closes the loop itself, so the chain must NOT already
        // repeat the first stop or the route gains a zero-length leg.
        const j = journeyRef.current;
        if (j.legs.length) {
          const fetched = await fetchRouteLegs(
            trip,
            j.chain.map((s) => s.name),
            j.loop,
            abort.signal,
            legModes(trip, j.chain.map((s) => s.name), j.loop),
          );
          if (cancelled) return;
          const resolved: LegFeature[] | null =
            fetched == null
              ? null
              : j.legs.map((leg) => {
                  const hit = fetched.find(
                    (f) =>
                      (f.from === leg.from.name && f.to === leg.to.name) ||
                      (f.from === leg.to.name && f.to === leg.from.name),
                  );
                  return {
                    stage: leg.stage,
                    road: hit?.road ?? false,
                    // A road:false hit draws the §8.4 great-circle arc, never
                    // the straight backend line (#357 slice 3A).
                    coordinates:
                      hit != null
                        ? resolveLegCoordinates(hit)
                        : greatCircle([leg.from.lng!, leg.from.lat!], [leg.to.lng!, leg.to.lat!]),
                    // Glyph mode is the leg's own data, classified (#357
                    // slice 3B) — geometry never decides.
                    glyph: legGlyphMode({
                      road: hit?.road ?? false,
                      mode: classifiedGlyphMode(leg.block),
                    }),
                  };
                });
          setLegsData(resolved);
        } else {
          setLegsData(null);
        }
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      map?.remove();
      mapRef.current = null;
      libRef.current = null;
      markersRef.current = new Map();
      chipPosRef.current = new Map();
      glyphModesRef.current = [];
      fitJourneyRef.current = null;
      fitDayRef.current = null;
      // The device dot and halo belonged to THIS map instance; the session
      // itself (lib/device-location) outlives it on purpose, so re-entering
      // the trip map shows the dot again without a second permission prompt.
      locateMarkerRef.current?.remove();
      locateMarkerRef.current = null;
      haloFixRef.current = null;
      syncHaloRef.current = null;
      followingRef.current = false;
      setFollowing(false);
      recentreRef.current = false;
      setReady(false);
      setLegsData(undefined);
    };
    // `trip` and `journey` are read through refs; the stable identity is the
    // signature — a changed journey (a content write) rebuilds the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, journeyKey, webgl2]);

  /* ------------------------------------------------------------------ */
  /* Level content: markers + line layers + camera, rebuilt on every     */
  /* level change (scan ↔ day ↔ day) while the MAP ITSELF stays up.      */
  /*                                                                     */
  /* Fully synchronous (everything it needs is already loaded), so the   */
  /* effect's own cleanup is the whole teardown story — no async races.  */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || !ready) return;
    const d = dayRef.current;
    const levelIsDay = d != null && dayIdxRef.current != null;
    const colors = mapColors(map.getContainer());

    const markers: MapLibreMarker[] = [];
    const addedLayers: string[] = [];
    const addedSources: string[] = [];
    /** Detach this build's camera-settle listener, if it added one. */
    let settleDetach: (() => void) | null = null;

    /** A numbered place pin — the same registry ordinal on every surface. */
    const addPin = (loc: TripLocation, excursion: boolean) => {
      const el = document.createElement("button");
      el.type = "button";
      // The rail/sheet beside the map is the accessible path (kiseki-map-ux),
      // so pins stay out of the tab order — but they are real buttons, so a
      // pointer gets button semantics and a 44px target.
      el.tabIndex = -1;
      el.setAttribute("aria-hidden", "true");
      el.title = excursion ? `${loc.name} (excursion)` : loc.name;
      el.dataset.place = loc.name;
      if (excursion) {
        el.className = "route-pin route-pin-excursion grid h-11 w-11 cursor-pointer place-items-center";
        const pin = document.createElement("span");
        // Excursions (#91): secondary weight — hollow diamond, no number (it
        // must not claim a slot in the ① ② ③ index).
        pin.className =
          "route-pin-dot route-pin-dot-excursion h-5 w-5 rotate-45 rounded-[4px] border-2 border-marker bg-surface shadow-card transition-transform duration-120";
        el.appendChild(pin);
      } else {
        el.className = "route-pin grid h-11 w-11 cursor-pointer place-items-center";
        const pin = document.createElement("span");
        // Pin colours are the shared stage-aware class map (lib/maps.ts) —
        // the surface, the card maps and the booklet render the same pin.
        pin.className = `route-pin-dot ${markerPinClass(trip, loc)} transition-transform duration-120`;
        pin.textContent = String(markerNumber(trip, loc));
        el.appendChild(pin);
      }
      markersRef.current.set(loc.name, el);
      markers.push(new lib.Marker({ element: el }).setLngLat([loc.lng!, loc.lat!]).addTo(map));
      return el;
    };

    /** A letter chip — the day level's activity marker (§8.3): square, so it
     *  can never be confused with the round numbered pins. */
    const addChip = (blockId: string, letter: string, place: TripLocation) => {
      const el = document.createElement("button");
      el.type = "button";
      el.tabIndex = -1;
      el.setAttribute("aria-hidden", "true");
      el.title = `${letter} — ${place.name}`;
      el.dataset.block = blockId;
      el.className = "route-chip grid h-11 w-11 cursor-pointer place-items-center";
      const chip = document.createElement("span");
      chip.className =
        "route-chip-dot grid h-6 w-6 place-items-center rounded-md bg-marker font-heading text-[13px] font-semibold leading-none text-marker-fg shadow-card transition-transform duration-120";
      chip.textContent = letter;
      el.appendChild(chip);
      markersRef.current.set(blockId, el);
      chipPosRef.current.set(blockId, [place.lng!, place.lat!]);
      markers.push(new lib.Marker({ element: el }).setLngLat([place.lng!, place.lat!]).addTo(map));
      el.addEventListener("click", () => onBlockTapRef.current(blockId));
    };

    /** On-map labels (#357 slice 2): numbered pills below their pins, at
     *  most ~8, selected first, none below the collision zoom. Excursions
     *  take no label (no ordinal — the label vocabulary is numbered). */
    const buildLabels = (byName: Map<string, TripLocation>, selectedName: string | null) => {
      for (const m of labelMarkersRef.current) m.remove();
      labelMarkersRef.current = [];
      const names = selectMapLabels([...byName.keys()], selectedName, map.getZoom() ?? 0);
      for (const name of names) {
        const loc = byName.get(name);
        if (!loc || loc.lng == null || loc.lat == null) continue;
        const el = makeMapLabelElement(formatMapLabel(markerNumber(trip, loc), loc.name));
        if (name === selectedName) el.classList.add("is-selected");
        labelMarkersRef.current.push(
          new lib.Marker({
            element: el,
            anchor: "top",
            offset: [0, MAP_LABEL_PIN_OFFSET_PX] as [number, number],
          })
            .setLngLat([loc.lng, loc.lat])
            .addTo(map),
        );
      }
    };

    /** Excursion (diamond) labels (#388 follow-up): the scan level's quietest
     *  label layer — venue names beside the numbered stops.
     *
     *  The display rule is MEASURED, not zoomed: `map.project` puts each
     *  candidate on screen and `farEnoughApart` keeps only the names that clear
     *  one pill's width from each other. A venue cluster therefore reveals its
     *  names as the traveler zooms in and a sparse trip names itself at once,
     *  with no floor constant to re-tune per trip (see `farEnoughApart`). The
     *  tapped diamond is exempt, so a tap is always answered.
     *
     *  Fed the diamonds the CLUSTER layer left visible, so a name never appears
     *  for a place that is currently represented by a count badge (#398) — a
     *  badge says "six venues here", and six labels under it would be the pile
     *  clustering exists to prevent. */
    const buildExcursionLabels = (
      byName: Map<string, TripLocation>,
      selectedName: string | null,
    ) => {
      for (const m of excursionLabelMarkersRef.current) m.remove();
      excursionLabelMarkersRef.current = [];
      const candidates = [...byName.values()].filter((l) => l.lng != null && l.lat != null);
      if (!candidates.length) return;
      const ordered = orderExcursionLabels(candidates.map((l) => l.name), selectedName);
      if (!ordered.length) return;
      const points = ordered.map((name) => {
        const loc = byName.get(name)!;
        const p = map.project([loc.lng!, loc.lat!]);
        return [p.x, p.y] as [number, number];
      });
      const shown = farEnoughApart(ordered, points, selectedName);
      for (const name of shown) {
        const loc = byName.get(name);
        if (!loc || loc.lng == null || loc.lat == null) continue;
        const el = makeMapExcursionLabelElement(loc.name);
        if (name === selectedName) el.classList.add("is-selected");
        excursionLabelMarkersRef.current.push(
          new lib.Marker({
            element: el,
            anchor: "top",
            offset: [0, EXCURSION_LABEL_DIAMOND_OFFSET_PX] as [number, number],
          })
            .setLngLat([loc.lng, loc.lat])
            .addTo(map),
        );
      }
    };

    /** The numbered stop pins, in the MAP CONTAINER's coordinate space — the
     *  space `map.project()` returns, and therefore the space `cluster.x/y`
     *  live in. `getBoundingClientRect` is VIEWPORT-relative, so it must be
     *  converted by subtracting the container's own origin; mixing the two
     *  spaces silently offsets every pin by where the map sits on the page. */
    const stopPinsInMapSpace = (): Array<[number, number]> => {
      const origin = map.getContainer().getBoundingClientRect();
      const out: Array<[number, number]> = [];
      for (const el of stopPinEls.current.values()) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) out.push([r.x + r.width / 2 - origin.left, r.y + r.height / 2 - origin.top]);
      }
      return out;
    };

    /** Where a cluster's badge DRAWS, in container px: its members' centroid,
     *  pushed clear of any numbered stop pin it lands on.
     *
     *  A venue cluster inside a re-base town has its centroid ON that town's
     *  numbered stop pin, and the stacking ladder (correctly, #388) keeps the
     *  pin on top — so the count painted underneath and was unreadable. Measured
     *  live on the Japan trip: badge "8" and pin "1" one pixel apart, with
     *  `elementFromPoint` at the badge's centre returning the pin's 28px dot.
     *
     *  A DRAWING offset only: membership, the count and the tap target are
     *  untouched, and a cluster not sitting on a pin — the common case, and every
     *  cluster on a sparse trip — never moves.
     *
     *  Returns SCREEN px, so every caller must `unproject` before handing the
     *  value to a Marker. That is not a detail: the first attempt passed this
     *  return value straight into `setLngLat`, which takes [lng, lat], so a y of
     *  ~200 was read as latitude 200 and MapLibre threw "Invalid LngLat latitude
     *  value" — the map vanished into the error boundary while `tsc`, `vitest`
     *  and the build all stayed green. The offset is also CLAMPED so a nudge can
     *  never walk off the container; when the clamped position still does not
     *  clear the pin, the badge stays put, because a badge under a pin is a
     *  cosmetic miss and a dead map is not. */
    const drawPosition = (cluster: PinCluster): [number, number] => {
      const el = map.getContainer();
      const w = el.clientWidth;
      const h = el.clientHeight;
      const clamp = (x: number, y: number): [number, number] =>
        w > 0 && h > 0
          ? [Math.min(Math.max(x, CLUSTER_PX / 2), w - CLUSTER_PX / 2),
             Math.min(Math.max(y, CLUSTER_PX / 2), h - CLUSTER_PX / 2)]
          : [x, y];
      let [x, y] = clamp(cluster.x, cluster.y);
      for (const [px, py] of stopPinsInMapSpace()) {
        if (Math.hypot(x - px, y - py) >= CLUSTER_PX) continue;
        const d = Math.hypot(cluster.x - px, cluster.y - py);
        // Push out along the line from the pin, so the badge keeps pointing at
        // the cluster it stands for instead of jumping to a fixed corner.
        const angle = d < 1 ? -Math.PI / 2 : Math.atan2(cluster.y - py, cluster.x - px);
        const moved = clamp(px + Math.cos(angle) * CLUSTER_PX, py + Math.sin(angle) * CLUSTER_PX);
        // Only take the nudge if it clears the pin AFTER clamping.
        if (Math.hypot(moved[0] - px, moved[1] - py) >= CLUSTER_PX / 2) [x, y] = moved;
      }
      return [x, y];
    };

    /** A cluster of colliding diamonds, drawn as ONE count badge (#398).
     *
     *  §8.3 has specified clustering since the marker system was written, and
     *  v0.92.0 logged the gap: Revelstoke's six venues sat ~4px apart, so five
     *  of six lozenges could not be tapped or read. A count badge is the honest
     *  drawing — "six venues here" — and its one tap zooms in until they
     *  separate. Same grammar as the home map's cluster (`marker-cluster.ts`),
     *  which is where the rule now lives so the two surfaces cannot drift.
     *
     *  It sits at the members' screen centroid unprojected back to the map, NOT
     *  snapped onto one member — a badge that inherits one venue's coordinates
     *  claims that venue's identity and its day. */
    const addClusterMarker = (cluster: PinCluster) => {
      const el = document.createElement("button");
      el.type = "button";
      el.tabIndex = -1;
      el.setAttribute("aria-hidden", "true");
      el.className = "route-cluster grid h-11 w-11 cursor-pointer place-items-center";
      el.title = `${cluster.memberDtIds.length} places here — zoom in`;
      el.dataset.cluster = cluster.key;
      el.setAttribute("data-cluster-marker", cluster.key);
      const badge = document.createElement("span");
      // Token colours only, and a COUNT rather than a number range (§8.3).
      // Hollow and DASHED like the diamond it stands for, so a cluster can
      // never be read as a numbered stop — the one thing a count badge on this
      // map must not do. `route-cluster-badge` is what the selection, dim and
      // scroll-spy rules in index.css address.
      badge.className =
        "route-cluster-badge grid h-7 min-w-7 place-items-center rounded-full border-2 border-dashed border-marker bg-surface px-1.5 font-heading text-[12px] font-bold tabular-nums text-marker shadow-card transition-transform duration-120";
      badge.textContent = String(cluster.memberDtIds.length);
      el.appendChild(badge);
      const at = map.unproject(drawPosition(cluster));
      const center: [number, number] = [at.lng, at.lat];
      // Bookkeeping so the selection effect can answer for a member: the rail
      // can select a venue that currently lives inside a badge, and the map has
      // to say where that is (see the selection effect).
      el.addEventListener("click", () => {
        // Close in until the members separate, and never past the zoom where
        // they are separate anyway (a step of 2 lands it either side; the
        // component's own label rule takes over from there).
        const zoom = Math.min(map.getZoom() + 2, 15);
        const opts = { center, zoom, offset: paddingOffset(paddingRef.current) };
        // `easeTo` takes the offset (it sets the transform's padding);
        // `jumpTo` does not — one of the two paths would drop it, so the
        // reduced-motion path jumps without it rather than silently differing.
        if (prefersReducedMotion()) map.jumpTo({ center, zoom });
        else map.easeTo({ ...opts, duration: CAMERA_MS });
      });
      // Registered in `markersRef` like every other marker, so the selection
      // and scroll-spy passes iterate it too (a badge the decor passes cannot
      // see would never dim or highlight — the whole focus story).
      markersRef.current.set(cluster.key, el);
      const marker = new lib.Marker({ element: el }).setLngLat(center).addTo(map);
      markers.push(marker);
      return marker;
    };

    /** Transport glyphs (#357 slice 3B): one symbol layer of leg midpoints,
     *  above the route, below the basemap's labels. Glyph-less legs
     *  contribute nothing; a level with no declared modes draws no layer. */
    const addGlyphLayer = (source: string, layerId: string, legs: LegFeature[]) => {
      if (!glyphModesRef.current.length) return;
      const registered = new Set(glyphModesRef.current);
      const features: LegGlyphFeature[] = legs.flatMap((f) => {
        const mode = f.glyph;
        if (mode == null || !registered.has(mode)) return [];
        return legGlyphPoints(f.coordinates).map((coordinates) => ({ mode, coordinates }));
      });
      if (!features.length) return;
      const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
      addLegGlyphLayer(map, source, layerId, features, firstSymbol);
      addedSources.push(source);
      addedLayers.push(layerId);
    };

    /** Cased line layers for the level's legs — the §8.4 grammar. */
    const addLineLayers = (source: string, legs: LegFeature[]) => {
      map.addSource(source, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: legs.map((f) => ({
            type: "Feature" as const,
            properties: { state: f.stage, road: f.road },
            geometry: { type: "LineString" as const, coordinates: f.coordinates },
          })),
        },
      });
      addedSources.push(source);
      // Under the basemap's labels so place names stay readable across the
      // route (§8.5). Found by layer TYPE, not id — hardcoded ids do not
      // survive the per-trip style swap #40 will make.
      const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
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
      // Route weight is the ONE shared grammar in lib/maps.ts (#357): the
      // body interpolates with zoom, the casing stays at ~1.6× the body.
      // Stage still speaks through dash + opacity (provisional dashed and
      // dim, booked solid) — width no longer varies by stage.
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
      const specs: Array<{
        id: string;
        filter: import("maplibre-gl").FilterSpecification;
        body: boolean;
        dashed: boolean;
      }> = [
        { id: `${source}-casing`, filter: solid, body: false, dashed: false },
        { id: `${source}-dashed-casing`, filter: dashed, body: false, dashed: true },
        { id: `${source}-solid`, filter: solid, body: true, dashed: false },
        { id: `${source}-dashed`, filter: dashed, body: true, dashed: true },
      ];
      for (const s of specs) {
        map.addLayer(
          {
            id: s.id,
            type: "line",
            source,
            filter: s.filter,
            layout: s.dashed
              ? { "line-cap": "butt", "line-join": "round" }
              : { "line-cap": "round", "line-join": "round" },
            paint: s.body
              ? {
                  "line-color": colors.route,
                  "line-width": ROUTE_BODY_WIDTH,
                  "line-opacity": opacity,
                  ...(s.dashed ? { "line-dasharray": [2, 2.2] } : {}),
                }
              : {
                  "line-color": colors.routeCasing,
                  "line-width": ROUTE_CASING_WIDTH,
                  "line-opacity": s.dashed ? 0.7 : ROUTE_CASING_OPACITY,
                  ...(s.dashed ? { "line-dasharray": [2, 2.2] } : {}),
                },
          } as Parameters<MapLibreMap["addLayer"]>[0],
          firstSymbol,
        );
        addedLayers.push(s.id);
      }
    };

    const bounds = new lib.LngLatBounds();
    const extend = (loc: TripLocation) => bounds.extend([loc.lng!, loc.lat!]);

    if (!levelIsDay) {
      /* ---------------- SCAN LEVEL (#92) ---------------- */
      // Mercator here, deliberately (Niko, 2026-09-23): the itinerary map is
      // where elevation is the point — a heliski week reads as terrain, not as
      // a ball. #361 slice 3 had put the whole-trip scan level on the globe;
      // with a globe projection MapLibre stops drawing the DEM (hillshade and
      // the 3D mesh), so the trip surface lost exactly the relief the terrain
      // work (#38) exists to show. The globe stays where it belongs: the
      // landing map (`HomeMap`) and the signed-in overview feature map
      // (`OverviewPage` -> `MapView globe`). Nothing sets a projection on this
      // surface, so both levels are Mercator by construction.
      // Paint order, lowest first: the excursion diamonds — or, where they
      // collide, their CLUSTER badges (#398) — then the numbered stops they
      // stand on. MapLibre stacks marker elements in the order they are ADDED
      // (all of them `position: absolute`, `z-index: auto`), so a diamond added
      // after its pin wins the tap — the venue round added 23 of them and made
      // the trip's own pins untappable at journey zoom (#388).
      //
      // The cluster badges are added in the SAME slot as the diamonds they
      // replace, deliberately: #388 is a paint-order bug, and a "fix" that
      // rebuilds clusters on camera move would append them after the stop pins
      // and resurrect it. Clustering therefore never re-adds a marker after the
      // level build — the camera's contribution is labels and the cluster SET
      // is fixed per level (see `visibleExcursionNames` below).
      const excursionByName = new Map(journeyRef.current.excursions.map((loc) => [loc.name, loc] as const));
      const locatedExcursions = journeyRef.current.excursions.filter(
        (l) => l.lng != null && l.lat != null,
      );
      // Every excursion keeps its OWN marker element for the lifetime of the
      // build, so the DOM order that #388 depends on never changes. Clustering
      // then decides per frame which diamonds SHOW and which are represented by
      // a badge: a diamond is hidden while it is inside a cluster, never
      // removed. That is what lets the cluster membership follow the camera
      // without ever re-appending a marker (the bug that would put #388 back).
      const excursionEls = new Map<string, HTMLElement>();
      for (const loc of locatedExcursions) {
        const el = addPin(loc, true);
        el.addEventListener("click", () => onSelectRef.current(loc));
        excursionEls.set(loc.name, el);
      }
      journeyRef.current.chain.forEach((loc) => {
        const el = addPin(loc, false);
        el.addEventListener("click", () => onSelectRef.current(loc));
        stopPinEls.current.set(loc.name, el);
      });

      /** Badge elements, reused across frames and keyed by membership. A badge
       *  that already exists is only REPOSITIONED — never re-added — so the
       *  stacking ladder (index.css) and the #388 order both hold. */
      const badgePool = new Map<string, { marker: MapLibreMarker; el: HTMLElement }>();
      /** The diamonds the cluster layer leaves visible — the label layer's
       *  candidates. A clustered venue is represented by a count, so naming it
       *  would reintroduce exactly the pile the badge replaced. */
      let visibleExcursionNames = new Set<string>();

      const syncExcursionClusters = () => {
        const grouped = clusterMarkers(
          locatedExcursions.map((l) => {
            const pt = map.project([l.lng!, l.lat!]);
            return { dtId: l.name, x: pt.x, y: pt.y };
          }),
          CLUSTER_PX,
        );
        visibleExcursionNames = new Set<string>();
        const liveKeys = new Set<string>();
        for (const item of grouped) {
          if (item.kind === "pin") {
            visibleExcursionNames.add(item.pin.dtId);
            continue;
          }
          const { cluster } = item;
          liveKeys.add(cluster.key);
          let entry = badgePool.get(cluster.key);
          if (!entry) {
            const marker = addClusterMarker(cluster);
            if (!marker) continue;
            entry = { marker, el: marker.getElement() };
            badgePool.set(cluster.key, entry);
          } else {
            // Reposition an existing badge: the count and title can change when
            // the membership changes, the element identity may not.
            entry.el.querySelector(".route-cluster-badge")!.textContent = String(cluster.memberDtIds.length);
            entry.el.title = `${cluster.memberDtIds.length} places here — zoom in`;
            entry.el.dataset.cluster = cluster.key;
            // `setLngLat` takes [lng, lat], not screen px — unproject first,
            // exactly like the create path. Passing drawPosition()'s output
            // directly read a y of ~200 as latitude 200 and threw
            // "Invalid LngLat latitude value", taking the whole map down.
            const moved = map.unproject(drawPosition(cluster));
            entry.marker.setLngLat([moved.lng, moved.lat]);
          }
          entry.el.removeAttribute("hidden");
          for (const member of cluster.memberDtIds) {
            excursionEls.get(member)?.setAttribute("hidden", "");
            clusterMembersRef.current.set(member, cluster.key);
          }
        }
        // Retire badges whose membership no longer exists (their venues split).
        for (const [key, entry] of badgePool) {
          if (liveKeys.has(key)) continue;
          entry.marker.remove();
          badgePool.delete(key);
        }
        // Re-show every diamond that is not currently inside a badge.
        for (const [name, el] of excursionEls) {
          if (visibleExcursionNames.has(name)) el.removeAttribute("hidden");
          else el.setAttribute("hidden", "");
        }
        clusterCentersRef.current.clear();
        for (const [key, entry] of badgePool) {
          const at = entry.marker.getLngLat();
          clusterCentersRef.current.set(key, [at.lng, at.lat]);
        }
        clusterMarkerElsRef.current.clear();
        for (const [key, entry] of badgePool) clusterMarkerElsRef.current.set(key, entry.el);
        // A badge created here has never seen the scroll-spy pass, so it would
        // sit dimmed at 0.45 while the very pins it stands for are full
        // strength. Measured: all five of Revelstoke's venues `is-spy`, the badge
        // covering them not. Re-run the pass whenever the set changes.
        setClusterRevision((n) => n + 1);
      };
      syncExcursionClusters();
      rebuildExcursionClustersRef.current = syncExcursionClusters;
      const scanByName = new Map(journeyRef.current.chain.map((loc) => [loc.name, loc] as const));
      buildLabels(scanByName, selectedRef.current?.name ?? null);
      rebuildLabelsRef.current = (sel) => buildLabels(scanByName, sel);
      /* Excursion labels (#388 follow-up): the diamonds name themselves, so
       * the itinerary is readable without tapping every lozenge. Built from
       * `journey.excursions`, which is by construction the complement of
       * `chain` (never a numbered stop — see `tripExcursions`), so this layer
       * can never double-label a pin or claim an ordinal. Same quiet
       * discipline as the place labels above and the settle-rebuild below.
       * Fed only the UNCLUSTERED diamonds (#398), for the reason on
       * `visibleExcursionNames`. */
      const currentExcursionLabels = () =>
        new Map(
          [...visibleExcursionNames]
            .map((name) => excursionByName.get(name))
            .filter((l): l is TripLocation => l != null)
            .map((loc) => [loc.name, loc] as const),
        );
      buildExcursionLabels(currentExcursionLabels(), selectedRef.current?.name ?? null);
      rebuildExcursionLabelsRef.current = (sel) => buildExcursionLabels(currentExcursionLabels(), sel);
      // #361 slice 2: the unselected overview names its places without a
      // tap — rebuild the capped layer every time the camera settles
      // (selected-first with a selection, top-8 chain stops without one).
      // The day level keeps its focus-driven behaviour: no settle rebuild.
      const onSettle = () => {
        syncExcursionClusters();
        buildLabels(scanByName, selectedRef.current?.name ?? null);
        // The candidate set is whatever survived clustering THIS frame, so the
        // label layer cannot name a venue that is currently a count badge.
        buildExcursionLabels(currentExcursionLabels(), selectedRef.current?.name ?? null);
      };
      map.on("moveend", onSettle);
      settleDetach = () => {
        map.off("moveend", onSettle);
      };
      if (legsData != null && legsData.length) addLineLayers("journey", legsData);
      addGlyphLayer("journey-glyphs", "journey-glyphs", legsData ?? []);
      journeyRef.current.stops.forEach(extend);
      journeyRef.current.excursions.forEach(extend);
      (legsData ?? []).forEach((l) => l.coordinates.forEach((c) => bounds.extend(c)));
      // Frame the whole journey on the settled container, including the road
      // geometry — a real route swings well outside the straight line
      // between its pins.
      fitJourneyRef.current = () => {
        if (!mapRef.current || journeyRef.current.stops.length < 2) return;
        mapRef.current.fitBounds(bounds, {
          padding: paddingRef.current,
          maxZoom: 12,
          animate: !prefersReducedMotion(),
          duration: CAMERA_MS,
        });
      };
      fitJourneyRef.current();
    } else {
      /* ---------------- DAY LEVEL (#90) ---------------- */
      // Flat, like the scan level above — neither level of the trip surface
      // sets a projection, so there is nothing to switch back from.
      const surface = d;
      // Same paint order as the scan level (see `markerPaintRank`): the day's
      // excursion diamonds, then its stop pins, then the letter chips — a chip
      // opens a block, so it keeps the top target it already had.
      const dayMarkers = [...surface.markers].sort(
        (a, b) => markerPaintRank(trip, a) - markerPaintRank(trip, b),
      );
      for (const m of dayMarkers) {
        if (m.role === "place") {
          const excursion = placeRole(trip, m.place.name) === "excursion";
          const el = addPin(m.place, excursion);
          // A day pin tap is not a card — it just clears the chip focus so
          // the map's focus story resets.
          el.addEventListener("click", () => onBlockTapRef.current(""));
        } else {
          addChip(m.blockIds[0], m.letter, m.place);
        }
      }
      const dayByName = new Map<string, TripLocation>();
      for (const m of surface.markers) {
        if (m.role === "place" && !dayByName.has(m.place.name)) dayByName.set(m.place.name, m.place);
      }
      buildLabels(dayByName, null);
      rebuildLabelsRef.current = (sel) => buildLabels(dayByName, sel);
      /* Day-level chip labels (#361 slice 6): the square A/B/C activity
       * markers name their activity in the same pill vocabulary as the place
       * labels — letter badge + block title, capped at ~8 with the focused
       * chip first, gone below the collision zoom (pins and chips stay).
       * Excursion diamonds never reach this path (role "place" only draws
       * them, and this layer only ever sees role "activity"). Anchored below
       * the chip and pointer-events-none like the place labels, so a label
       * never covers a pin, a chip hit target, or the drive-time chip (DOM
       * chrome above the canvas). */
      const chipEntries: Array<{ id: string; letter: string; title: string; place: TripLocation }> = [];
      {
        const dayBlocks = trip.days[dayIdxRef.current ?? -1]?.blocks ?? [];
        const titleById = new Map(dayBlocks.map((b) => [b.id, b.title] as const));
        for (const m of surface.markers) {
          if (m.role !== "activity") continue;
          if (m.place.lng == null || m.place.lat == null) continue;
          const id = m.blockIds[0];
          chipEntries.push({ id, letter: m.letter, title: titleById.get(id) || m.place.name, place: m.place });
        }
      }
      const buildChipLabels = (active: string | null) => {
        for (const mk of chipLabelMarkersRef.current) mk.remove();
        chipLabelMarkersRef.current = [];
        const byId = new Map(chipEntries.map((c) => [c.id, c] as const));
        for (const id of selectChipLabels(chipEntries.map((c) => c.id), active, map.getZoom() ?? 0)) {
          const c = byId.get(id);
          if (!c) continue;
          const el = makeMapChipLabelElement(c.letter, c.title);
          if (id === active) el.classList.add("is-selected");
          chipLabelMarkersRef.current.push(
            new lib.Marker({
              element: el,
              anchor: "top",
              offset: [0, MAP_LABEL_PIN_OFFSET_PX] as [number, number],
            })
              .setLngLat([c.place.lng!, c.place.lat!])
              .addTo(map),
          );
        }
      };
      buildChipLabels(activeBlockRef.current);
      rebuildChipLabelsRef.current = buildChipLabels;
      if (surface.legs.length) {
        // #104: real road geometry when the backend gave it; while the fetch
        // is in flight the great-circle arc draws (the fit must not wait on
        // the network). A leg whose hit came back non-road — or the whole fetch
        // unusable — draws its arc DASHED (the `road:false` branch
        // in `addLineLayers`), so a curve never poses as a road.
        const geo = dayLegsData;
        const dayLegs: LegFeature[] = surface.legs.map((l) => {
          const hit = geo?.get(`${l.from.name}>${l.to.name}`);
          // road=true only when REAL geometry is in hand — everything
          // else (fallback pair, provisional leg, fetch miss) dashes.
          const road = !!hit && hit.road && l.stage !== "provisional";
          return {
            // Non-road draws the great-circle arc, never a straight
            // screen-space line (#357 slice 3A).
            coordinates:
              hit && hit.road
                ? hit.coordinates
                : greatCircle(
                    [l.from.lng!, l.from.lat!],
                    [l.to.lng!, l.to.lat!],
                  ),
            stage: l.stage,
            road,
            glyph: legGlyphMode({ road, mode: classifiedGlyphMode(l.block) }),
          };
        });
        addLineLayers("day", dayLegs);
        addGlyphLayer("day-glyphs", "day-glyphs", dayLegs);
      }
      // Recorded tracks (#193, #290): the shape of the day as cased lines in
      // the trip route colour (§8.4 — wide casing under a narrower body, solid
      // and full-strength: a completed activity is not provisional). Ridden
      // runs draw solid; lift rides draw dashed and lighter — the distinction
      // Slopes and Strava make on their own maps, so the day reads as a day
      // and not as one 33 km run. Drawn under the basemap's labels.
      const trackSegmentsAll = [...dayTracksData.values()].flat();
      if (trackSegmentsAll.length) {
        map.addSource("day-tracks", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: trackSegmentsAll.map((segment) => ({
              type: "Feature" as const,
              properties: { lift: segment.type === "lift" },
              geometry: { type: "LineString" as const, coordinates: segment.coordinates },
            })),
          },
        });
        addedSources.push("day-tracks");
        const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
        const ride: import("maplibre-gl").FilterSpecification = ["!", ["get", "lift"]];
        const lift: import("maplibre-gl").FilterSpecification = ["get", "lift"];
        // Every line twice (§8.4), and every CASING before any body — a lift's
        // casing must not sit on top of a neighbouring ride's body.
        const specs: Array<{
          id: string;
          filter: import("maplibre-gl").FilterSpecification;
          body: boolean;
          dashed: boolean;
        }> = [
          { id: "day-tracks-casing", filter: ride, body: false, dashed: false },
          { id: "day-tracks-lift-casing", filter: lift, body: false, dashed: true },
          { id: "day-tracks-body", filter: ride, body: true, dashed: false },
          { id: "day-tracks-lift-body", filter: lift, body: true, dashed: true },
        ];
        for (const s of specs) {
          map.addLayer(
            {
              id: s.id,
              type: "line",
              source: "day-tracks",
              filter: s.filter,
              layout: {
                "line-cap": s.dashed ? "butt" : "round",
                "line-join": "round",
              },
              paint: s.body
                ? {
                    "line-color": colors.route,
                    "line-width": ROUTE_BODY_WIDTH,
                    "line-opacity": s.dashed ? 0.75 : 1,
                    ...(s.dashed ? { "line-dasharray": [2, 2.2] } : {}),
                  }
                : {
                    "line-color": colors.routeCasing,
                    "line-width": ROUTE_CASING_WIDTH,
                    "line-opacity": s.dashed ? 0.6 : 0.9,
                    ...(s.dashed ? { "line-dasharray": [2, 2.2] } : {}),
                  },
            } as Parameters<MapLibreMap["addLayer"]>[0],
            firstSymbol,
          );
          addedLayers.push(s.id);
        }
      }
      surface.markers.forEach((m) => extend(m.place));
      // The day's extent INCLUDES the track — a traverse swings outside its
      // pins, and a track-only day (no markers at all) still frames.
      for (const segment of trackSegmentsAll) {
        for (const c of segment.coordinates) bounds.extend(c);
      }
      // #104: the fit must include the ROAD, not just the endpoints — a real
      // route swings well outside the straight line (Rogers Pass rides north
      // of the ②→③ pair), and endpoint-only bounds clip the pin it exists to
      // frame. The `dayLegsData` dep re-runs this build when the fetch lands.
      if (dayLegsData) {
        for (const f of dayLegsData.values()) {
          f.coordinates.forEach((c) => bounds.extend(c));
        }
      }
      fitDayRef.current = () => {
        // A track-only day (no markers, a recorded line) still frames — the
        // track IS the day's extent there.
        if (!mapRef.current || (surface.markers.length === 0 && trackSegmentsAll.length === 0)) return;
        if (bounds.isEmpty()) return;
        if (surface.markers.length === 1 && trackSegmentsAll.length === 0) {
          const p = surface.markers[0].place;
          const opts = {
            center: [p.lng!, p.lat!] as [number, number],
            zoom: Math.max(mapRef.current.getZoom(), 11),
            offset: paddingOffset(paddingRef.current),
          };
          if (prefersReducedMotion()) mapRef.current.jumpTo(opts);
          else mapRef.current.easeTo({ ...opts, duration: CAMERA_MS });
          return;
        }
        mapRef.current.fitBounds(bounds, {
          padding: paddingRef.current,
          maxZoom: 13,
          animate: !prefersReducedMotion(),
          duration: CAMERA_MS,
        });
      };
      fitDayRef.current();
    }

    return () => {
      // Tear down THIS build's content: the settle listener it added, the
      // markers it added and the layers on its own sources. Runs before the
      // next build and on unmount.
      settleDetach?.();
      settleDetach = null;
      markers.forEach((m) => m.remove());
      for (const m of labelMarkersRef.current) m.remove();
      labelMarkersRef.current = [];
      for (const m of chipLabelMarkersRef.current) m.remove();
      chipLabelMarkersRef.current = [];
      for (const m of excursionLabelMarkersRef.current) m.remove();
      excursionLabelMarkersRef.current = [];
      stopPinEls.current.clear();
      clusterMembersRef.current.clear();
      clusterMarkerElsRef.current.clear();
      clusterCentersRef.current.clear();
      rebuildLabelsRef.current = null;
      rebuildChipLabelsRef.current = null;
      rebuildExcursionLabelsRef.current = null;
      rebuildExcursionClustersRef.current = null;
      for (const id of [...addedLayers].reverse()) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const source of addedSources) {
        if (map.getSource(source)) map.removeSource(source);
      }
    };
    // `trip` is read for marker numbers/roles and IS a dep: a content write
    // that changes the registry must restyle the pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, ready, legsData, dayLegsData, dayTracksData, isDay, dayIdx]);

  /* Selection visuals + the camera that follows it. Level-aware: the scan
     selection moves to a place; the day selection moves to a letter chip. */
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    if (!isDay) {
      container.classList.toggle("route-map-focused", !!selected);
      markersRef.current.forEach((el, name) => {
        el.classList.toggle("is-selected", selected?.name === name);
      });
      // A clustered venue has no diamond of its own, but the RAIL can still
      // select it (a venue lives in a day card, so the itinerary can name it
      // from there). Mark the badge that CONTAINS the selection and pull the
      // camera to it, so the map still answers WHERE the traveler picked.
      // Without this the selection is invisible on the map: the sheet says
      // "Day 3 is highlighted below" while no marker on the map is it.
      const clusterKey = clusterMembersRef.current.get(selected?.name ?? "");
      for (const [key, el] of clusterMarkerElsRef.current) {
        el.classList.toggle("is-selected", key === clusterKey);
      }
      if (clusterKey != null) {
        const center = clusterCentersRef.current.get(clusterKey);
        const map = mapRef.current;
        if (center && map) {
          const zoom = Math.max(map.getZoom(), 13);
          if (prefersReducedMotion()) map.jumpTo({ center, zoom });
          else
            map.easeTo({
              center,
              zoom,
              offset: paddingOffset(paddingRef.current),
              duration: CAMERA_MS,
            });
        }
      }
      // The selected pin's label always wins — rebuild the capped layer
      // around the new selection (pins themselves only change classes).
      rebuildLabelsRef.current?.(selected?.name ?? null);
      // …and so does a selected DIAMOND's label (#388 follow-up) — the "or
      // clicking them" half of the ask. `farEnoughApart` exempts the selected
      // name from the separation test, so a tap is always answered; a selected
      // chain stop is not in this layer's list at all and leaves it untouched.
      // Re-cluster first: a selection can change what is a badge (a selected
      // member always gets its own diamond back), and the label layer must
      // agree with the markers.
      rebuildExcursionLabelsRef.current?.(selected?.name ?? null);
    } else {
      container.classList.toggle("route-map-focused", !!activeBlock);
      markersRef.current.forEach((el, id) => {
        const isChip = el.classList.contains("route-chip");
        el.classList.toggle("is-selected", isChip ? id === activeBlock : false);
      });
      // The focused chip's label always wins — rebuild the capped chip layer
      // around the new focus (chips themselves only change classes).
      rebuildChipLabelsRef.current?.(activeBlock);
      const chip = activeBlock ? chipPosRef.current.get(activeBlock) : null;
      const map = mapRef.current;
      if (chip && map) {
        const opts = {
          center: chip,
          zoom: Math.max(map.getZoom(), 11.5),
          offset: paddingOffset(paddingRef.current),
        };
        if (prefersReducedMotion()) map.jumpTo(opts);
        else map.easeTo({ ...opts, duration: CAMERA_MS });
      }
    }
  }, [selected, activeBlock, isDay, ready]);

  /* Scroll-spy raise (#92): at scan level, with no explicit selection, the
     pins of the chapter in view stay full-strength and the rest dim. */
  useEffect(() => {
    const container = ref.current;
    if (!container || isDay || selected || !spyPlaces) {
      container?.classList.remove("route-spy-active");
      markersRef.current.forEach((el) => el.classList.remove("is-spy"));
      return;
    }
    const spy = new Set(spyPlaces);
    container.classList.add("route-spy-active");
    // Cluster badges (#398) key their membership as cluster key → members, so a
    // badge counts as in-view when ANY of its venues is in the chapter. Without
    // this a badge's key (its members joined by "+") never matches a place name
    // and every badge dims with the out-of-chapter markers.
    const membersByCluster = new Map<string, Set<string>>();
    for (const [member, key] of clusterMembersRef.current) {
      const set = membersByCluster.get(key) ?? new Set<string>();
      set.add(member);
      membersByCluster.set(key, set);
    }
    markersRef.current.forEach((el, name) => {
      // `.is-spy` = "this pin belongs to the chapter in view" — the CSS dims
      // `.route-pin:not(.is-spy)` (everything outside the chapter). Getting this
      // backwards dims the chapter itself and leaves the rest bright (#92).
      const members = membersByCluster.get(name);
      const inSpy = spy.has(name) || (members != null && [...members].some((m) => spy.has(m)));
      el.classList.toggle("is-spy", inSpy);
    });
    // `clusterRevision` is in the deps because cluster membership is derived
    // from the CAMERA (#398): a camera move can create a badge with no
    // spy/selection change to trigger this effect, and that badge needs the
    // same `is-spy` decoration the pins it stands for already have.
  }, [spyPlaces, selected, isDay, ready, clusterRevision]);

  /* ------------------------------------------------------------------ */
  /* The traveler's own position (#383): the dot, its accuracy halo, and */
  /* the camera that follows it. Level-independent by construction — one */
  /* map instance serves both levels, and "where am I" means the same    */
  /* thing on the whole-trip scan as on a single day.                    */
  /* ------------------------------------------------------------------ */

  /** Fly the camera to the dot — the ONE movement the traveler asked for.
   *  Keeps the current zoom when it is already closer (a traveler zoomed into
   *  a street does not want to be pulled back out). */
  const flyToFix = (fix: DeviceFix) => {
    const map = mapRef.current;
    if (!map) return;
    const opts = {
      center: [fix.lng, fix.lat] as [number, number],
      zoom: Math.max(map.getZoom(), 13),
      offset: paddingOffset(paddingRef.current),
    };
    if (prefersReducedMotion()) map.jumpTo(opts);
    else map.easeTo({ ...opts, duration: CAMERA_MS });
  };

  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    const container = ref.current;
    if (!map || !lib || !container || !ready) return;
    const fix = device.tracking ? device.fix : null;
    haloFixRef.current = fix;
    // The DOM contract for the session (`data-device-location`) — the same idea
    // as `data-map-ready` for the PDF waiter: a surface state other code (and
    // the browser probe in `scripts/probe-device-location.py`) can assert
    // without reaching into a WebGL canvas.
    container.dataset.deviceLocation = fix ? "live" : "off";

    // The dot: a DOM marker like the pins, so its colour is a CSS class off
    // `--map-locate` and no literal is ever written in JS (§8.4). `aria-hidden`
    // and pointer-events-none: it is a "you are here", never a target.
    if (fix) {
      if (locateMarkerRef.current) {
        locateMarkerRef.current.setLngLat([fix.lng, fix.lat]);
      } else {
        const el = document.createElement("div");
        el.className = "route-locate-dot pointer-events-none";
        el.setAttribute("aria-hidden", "true");
        locateMarkerRef.current = new lib.Marker({ element: el })
          .setLngLat([fix.lng, fix.lat])
          .addTo(map);
      }
    } else if (locateMarkerRef.current) {
      locateMarkerRef.current.remove();
      locateMarkerRef.current = null;
    }

    // The halo: one point plus a radius in pixels at this camera's ground
    // resolution (syncHalo owns the maths — the zoom listener needs it too).
    const source = map.getSource(DEVICE_SOURCE) as GeoJSONSource | undefined;
    source?.setData(deviceHalo(fix));
    syncHaloRef.current?.();

    if (!fix) return;
    if (recentreRef.current) {
      // The flight a start/recentre tap asked for, deferred until a position
      // actually existed (the tap may be what triggers the permission prompt).
      recentreRef.current = false;
      flyToFix(fix);
      return;
    }
    // Following: a plain jump per fix, never an animation — a 500ms ease per
    // GPS tick is a camera that never settles, and the dot is the thing that
    // should move. Zoom is untouched: the framing stays the traveler's.
    if (followingRef.current) map.jumpTo({ center: [fix.lng, fix.lat] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.tracking, device.fix, ready]);

  /* Camera reframes when the occlusion changes (a detent drag, a rotation, a
     breakpoint change) — at whichever level is live. Forgetting this is the
     #1 bug in map+sheet layouts: the route hides under the sheet and it
     reads as "the map is broken". */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (isDay) {
      fitDayRef.current?.();
      return;
    }
    if (!selected || selected.lng == null || selected.lat == null) {
      fitJourneyRef.current?.();
      return;
    }
    const opts = {
      center: [selected.lng, selected.lat] as [number, number],
      zoom: Math.max(map.getZoom(), 9),
      offset: paddingOffset(padding),
    };
    if (prefersReducedMotion()) map.jumpTo(opts);
    else map.easeTo({ ...opts, duration: CAMERA_MS });
  }, [selected, padding, ready, isDay]);

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

  /* The locate control's state (#383) — a pure mapping (lib/geolocation), so
     the button below is presentation only. */
  const locate = locateControl({ tracking: device.tracking, following });

  /** The tap: start+centre, come back to me, or stop — see `locateControl`. */
  const onLocate = () => {
    if (locate.action === "start") {
      setFollowing(true);
      recentreRef.current = true; // flies when the first fix lands
      startLocate();
      return;
    }
    if (locate.action === "recentre") {
      setFollowing(true);
      if (device.fix) flyToFix(device.fix); // a fix is in hand — go now
      else recentreRef.current = true;
      return;
    }
    stopLocate();
    setFollowing(false);
  };

  return (
    <>
      <div ref={ref} className="map-pin-scaled h-full w-full" />
      {!ready && (
        // Themed skeleton while the style loads (§8.5) — never an empty grey box.
        <div className="pointer-events-none absolute inset-0 animate-pulse bg-muted" aria-hidden="true" />
      )}
      {/* Map controls are real buttons with labels and a 44px target — a WebGL
          canvas gives keyboard users nothing (§11). */}
      <button
        type="button"
        onClick={() => (isDay ? fitDayRef.current?.() : fitJourneyRef.current?.())}
        aria-label={isDay ? "Frame the day" : "Frame the whole route"}
        className="map-chip-btn absolute right-0 top-0 z-10 grid h-11 w-11 place-items-center"
      >
        <span className="floating grid h-8 w-8 place-items-center rounded-lg text-muted-foreground">
          <Maximize2 className="h-4 w-4" aria-hidden="true" />
        </span>
      </button>
      {/* The traveler's own position (#383) — the only control on this surface
          that is about the viewer rather than the trip. Idle until tapped, or
          until the browser already grants location; the label states what the
          tap will do, because the same button starts, recentres and stops. */}
      <button
        type="button"
        onClick={onLocate}
        aria-label={locate.label}
        title={locate.label}
        data-locate={locate.action}
        data-tracking={device.tracking ? "true" : "false"}
        className="map-chip-btn absolute right-0 top-11 z-10 grid h-11 w-11 place-items-center"
      >
        <span
          className={`floating grid h-8 w-8 place-items-center rounded-lg ${
            locate.following ? "text-accent" : "text-muted-foreground"
          }`}
        >
          {locate.icon === "locate-fixed" ? (
            <LocateFixed className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Locate className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
      </button>
      {/* Why a start failed (blocked, no fix) — one line, floating, dismissed
          by the traveler, and never a modal: the map is still the surface. */}
      {device.notice && (
        <div className="map-locate-notice absolute right-0 top-[5.5rem] z-10" role="status">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1">{device.notice}</span>
            <button
              type="button"
              onClick={dismissNotice}
              aria-label="Dismiss"
              className="-m-1 grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
