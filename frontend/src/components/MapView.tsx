import { useEffect, useRef, useState } from "react";
import { useTrip } from "./theme";
import { findLocation, loadGoogleMaps, locatedPlaces, staticMapUrl } from "../lib/maps";

/**
 * Dynamic Google Map (JS API) for a set of places: numbered markers + connecting
 * polyline. Hidden in print — the booklet uses StaticMapImg instead.
 */
export function MapView({ places, className = "" }: { places: string[]; className?: string }) {
  const trip = useTrip();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let map: any = null;
    let poly: any = null;
    const markers: any[] = [];

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

        const center = {
          lat: located.reduce((s, l) => s + (l.lat ?? 0), 0) / located.length,
          lng: located.reduce((s, l) => s + (l.lng ?? 0), 0) / located.length,
        };
        map = new maps.Map(ref.current, {
          center,
          zoom: 6,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        const bounds = new maps.LatLngBounds();
        located.forEach((l, i) => {
          const pos = { lat: l.lat!, lng: l.lng! };
          bounds.extend(pos);
          markers.push(
            new maps.Marker({
              position: pos,
              label: { text: String(i + 1), color: "#ffffff", fontWeight: "700", fontSize: "12px" },
              title: l.name,
            }),
          );
        });
        poly = new maps.Polyline({
          path: located.map((l) => ({ lat: l.lat!, lng: l.lng! })),
          geodesic: true,
          strokeColor: "#0f766e",
          strokeOpacity: 0.9,
          strokeWeight: 4,
        });
        poly.setMap(map);
        map.fitBounds(bounds);
      } catch {
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
      markers.forEach((m) => m.setMap(null));
      poly?.setMap(null);
      map?.unbindAll();
    };
  }, [trip, places]);

  if (error) return null;
  return <div ref={ref} className={`h-48 w-full rounded-lg border border-border md:h-56 ${className}`} />;
}

/** Static map image (server-proxied, key-safe) — used in the booklet/print. */
export function StaticMapImg({ places, className = "" }: { places: string[]; className?: string }) {
  const trip = useTrip();
  const url = staticMapUrl(trip, places);
  if (!url) return null;
  return <img src={url} alt="Route map" className={`w-full rounded-lg border border-border ${className}`} />;
}

/**
 * One map, both worlds: JS map on screen, static image in print — with a fallback
 * to the static image whenever the JS map can't render (no key / error).
 */
export function TripMap({ places }: { places: string[] }) {
  const trip = useTrip();
  const all = locatedPlaces(trip);
  if (all.length < 2) return null;
  return (
    <>
      <div className="hidden print:block">
        <StaticMapImg places={places} />
      </div>
      <div className="print:hidden">
        <MapView places={places} />
      </div>
    </>
  );
}
