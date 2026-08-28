import { useEffect, useRef, useState } from "react";
import { useTrip } from "./theme";
import { findLocation, loadGoogleMaps, locatedPlaces, staticMapUrl } from "../lib/maps";

interface MapViewProps {
  places: string[];
  loop?: boolean;
  className?: string;
  showLiveTime?: boolean;
}

/**
 * Dynamic Google Map (JS API): numbered markers + the REAL driving route
 * (DirectionsService), live traffic layer, and — for two-place legs — a live
 * drive-time chip. Terrain basemap (closest to the old booklet maps).
 * Hidden in print — the booklet uses StaticMapImg instead.
 */
export function MapView({ places, loop = false, className = "", showLiveTime = true }: MapViewProps) {
  const trip = useTrip();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const [liveTime, setLiveTime] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let map: any = null;
    let traffic: any = null;
    const markers: any[] = [];
    const renderers: any[] = [];

    const located = places
      .map((p) => findLocation(trip, p))
      .filter((l): l is NonNullable<typeof l> => !!l && l.lat != null && l.lng != null);
    if (located.length < 2) return;

    (async () => {
      try {
        const keyResp = await fetch("/api/maps/key").then((r) => r.json());
        if (!keyResp.key || cancelled) return;
        const maps = await loadGoogleMaps(keyResp.key);
        if (cancelled || !ref.current) return;

        const coords = located.map((l) => ({ lat: l.lat!, lng: l.lng! }));
        const center = {
          lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
          lng: coords.reduce((s, c) => s + c.lng, 0) / coords.length,
        };
        map = new maps.Map(ref.current, {
          center,
          zoom: 6,
          mapTypeId: "terrain",
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });

        // numbered markers — MUST be attached with `map` in the constructor
        located.forEach((l, i) => {
          const pos = { lat: l.lat!, lng: l.lng! };
          markers.push(
            new maps.Marker({
              map,
              position: pos,
              label: { text: String(i + 1), color: "#ffffff", fontWeight: "700", fontSize: "12px" },
              title: l.name,
            }),
          );
        });

        // live traffic
        traffic = new maps.TrafficLayer();
        traffic.setMap(map);

        // real driving route + live drive time via DirectionsService.
        // NOTE: the JS API rejects origin == destination (ZERO_RESULTS), so a
        // closed loop is drawn as two requests: 1→last via waypoints, then last→1.
        const dirService = new maps.DirectionsService();
        const renderRoute = (origin: any, destination: any, waypoints: any[], legOnly = false) => {
          dirService.route(
            {
              origin,
              destination,
              waypoints,
              travelMode: "DRIVING",
              drivingOptions: { departureTime: new Date(), trafficModel: "best_guess" },
            },
            (result: any, status: string) => {
              if (cancelled || status !== "OK" || !result?.routes?.length) return;
              const renderer = new maps.DirectionsRenderer({
                map,
                suppressMarkers: true,
                polylineOptions: { strokeColor: "#1e3a8a", strokeWeight: 5, strokeOpacity: 0.95 },
              });
              renderer.setDirections(result);
              renderers.push(renderer);
              if (legOnly && showLiveTime) {
                const leg = result.routes[0].legs[0];
                const dur = leg?.duration_in_traffic?.text ?? leg?.duration?.text;
                if (dur) setLiveTime(dur);
              }
            },
          );
        };
        if (loop && coords.length >= 3) {
          renderRoute(
            coords[0],
            coords[coords.length - 1],
            coords.slice(1, -1).map((c) => ({ location: c })),
          );
          renderRoute(coords[coords.length - 1], coords[0], []);
        } else {
          const origin = coords[0];
          const destination = coords[coords.length - 1];
          renderRoute(
            origin,
            destination,
            coords.slice(1, -1).map((c) => ({ location: c })),
            true,
          );
        }

        const bounds = new maps.LatLngBounds();
        coords.forEach((c) => bounds.extend(c));
        map.fitBounds(bounds);
      } catch {
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
      markers.forEach((m) => m.setMap(null));
      renderers.forEach((r) => r.setMap(null));
      traffic?.setMap(null);
      map?.unbindAll();
    };
  }, [trip, places, loop, showLiveTime]);

  if (error) return null;
  return (
    <div className={`relative ${className}`}>
      <div ref={ref} className="h-48 w-full rounded-lg border border-border md:h-56" />
      {liveTime && (
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2.5 py-1 text-[11px] font-semibold text-foreground shadow-sm backdrop-blur">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
          ≈ {liveTime} · live
        </span>
      )}
    </div>
  );
}

/** Static map image (server-proxied: real route + key-safe) — used in the booklet/print. */
export function StaticMapImg({ places, loop = false, className = "" }: { places: string[]; loop?: boolean; className?: string }) {
  const trip = useTrip();
  const url = staticMapUrl(trip, places, loop);
  if (!url) return null;
  return <img src={url} alt="Route map" className={`w-full rounded-lg border border-border ${className}`} />;
}

/**
 * One map, both worlds: JS map on screen (traffic + live drive time), static
 * image in print (real route). Falls back gracefully when maps aren't configured.
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
