import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Maximize2 } from "lucide-react";
import { useTrip } from "./theme";
import {
  applyBasemapTint,
  fetchRouteLegs,
  formatMapLabel,
  hasWebGL2,
  makeMapChipLabelElement,
  makeMapLabelElement,
  MAP_LABEL_PIN_OFFSET_PX,
  MAP_LABEL_ZOOM_FLOOR,
  markerNumber,
  markerPinClass,
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
import { fetchTrack, trackDataUrl, trackSegments, type TrackSegment } from "../lib/tracks";
import { greatCircle, legModes, placeRole, resolveLegCoordinates, type Journey } from "../lib/route-surface";
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
import { applyOverviewGlobe, clearOverviewGlobe } from "../lib/globe";
import { mapColors } from "../lib/tokens";
import type { TripLocation } from "../lib/types";

/** Map camera durations (DESIGN.md §10) — 400–600ms, nothing else. */
const CAMERA_MS = 500;

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
  const activeBlockRef = useRef(activeBlock);
  activeBlockRef.current = activeBlock;

  const isDay = day != null;

  // v6 dropped the WebGL1 fallback entirely, so this is a hard gate, not a
  // preference — without WebGL2 the constructor throws (DESIGN.md §8.2).
  const [webgl2] = useState(hasWebGL2);
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
        // Zoom-scaled pins (#357 slice 2): --pin-scale shrinks the visible
        // dot toward ~22px at journey zoom; the 44px hit target never moves.
        // Below the collision zoom the label layer drops (pins stay).
        const syncZoom = () => {
          if (!map || !ref.current) return;
          const z = map.getZoom() ?? 0;
          ref.current.style.setProperty("--pin-scale", String(pinScaleAtZoom(z)));
          ref.current.classList.toggle("map-labels-off", z < MAP_LABEL_ZOOM_FLOOR);
        };
        map.on("zoom", syncZoom);
        syncZoom();
        // Zoomed in from below the floor with no labels built: build them now
        // (either layer — a chip-only day leaves the place layer empty).
        map.on("zoomend", () => {
          if (labelMarkersRef.current.length === 0 && chipLabelMarkersRef.current.length === 0) {
            rebuildLabelsRef.current?.(selectedRef.current?.name ?? null);
            rebuildChipLabelsRef.current?.(activeBlockRef.current);
          }
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
      // #361 slice 3: the whole-trip overview renders on a globe. This
      // surface is screen-only by construction (never printed — the booklet
      // route map is MapView, #37), so there is no pdf gate here; the day
      // level below goes back to Mercator on every level switch.
      applyOverviewGlobe(map, map.getContainer());
      journeyRef.current.chain.forEach((loc) => {
        const el = addPin(loc, false);
        el.addEventListener("click", () => onSelectRef.current(loc));
      });
      journeyRef.current.excursions.forEach((loc) => {
        const el = addPin(loc, true);
        el.addEventListener("click", () => onSelectRef.current(loc));
      });
      const scanByName = new Map(journeyRef.current.chain.map((loc) => [loc.name, loc] as const));
      buildLabels(scanByName, selectedRef.current?.name ?? null);
      rebuildLabelsRef.current = (sel) => buildLabels(scanByName, sel);
      // #361 slice 2: the unselected overview names its places without a
      // tap — rebuild the capped layer every time the camera settles
      // (selected-first with a selection, top-8 chain stops without one).
      // The day level keeps its focus-driven behaviour: no settle rebuild.
      const onSettle = () => buildLabels(scanByName, selectedRef.current?.name ?? null);
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
      // That day's world stays flat — the globe is the overview's alone.
      clearOverviewGlobe(map);
      const surface = d;
      for (const m of surface.markers) {
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
      rebuildLabelsRef.current = null;
      rebuildChipLabelsRef.current = null;
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
      // The selected pin's label always wins — rebuild the capped layer
      // around the new selection (pins themselves only change classes).
      rebuildLabelsRef.current?.(selected?.name ?? null);
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
    // `.is-spy` = "this pin belongs to the chapter in view" — the CSS dims
    // `.route-pin:not(.is-spy)` (everything outside the chapter). Getting this
    // backwards dims the chapter itself and leaves the rest bright (#92).
    markersRef.current.forEach((el, name) => {
      el.classList.toggle("is-spy", spy.has(name));
    });
  }, [spyPlaces, selected, isDay, ready]);

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
    </>
  );
}
