import type { Trip, TripLocation } from "./types";

/** Resolve a place name/alias to a location entry (case-insensitive). */
export function findLocation(trip: Trip, name: string): TripLocation | undefined {
  const n = name.trim().toLowerCase();
  return (trip.locations ?? []).find(
    (l) => l.name.toLowerCase() === n || (l.alias ?? []).some((a) => a.toLowerCase() === n),
  );
}

/** Static map proxy URL for a set of places (server adds the key — print-safe). */
export function staticMapUrl(trip: Trip, places: string[]): string | null {
  const resolvable = places.filter((p) => findLocation(trip, p));
  if (resolvable.length < 2) return null;
  return `/api/maps/static/${trip.token}?places=${encodeURIComponent(resolvable.join(","))}`;
}

/** All trip locations with coords, in marker order. */
export function locatedPlaces(trip: Trip): TripLocation[] {
  return (trip.locations ?? []).filter((l) => l.lat != null && l.lng != null);
}

let mapsPromise: Promise<typeof google.maps> | null = null;

/** Load the Google Maps JS API once; resolves with the global namespace. */
export function loadGoogleMaps(key: string): Promise<typeof google.maps> {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    const cb = `__kisekiMaps${Date.now()}`;
    (window as unknown as Record<string, unknown>)[cb] = () => {
      resolve(window.google.maps);
      try {
        delete (window as unknown as Record<string, unknown>)[cb];
      } catch {
        /* noop */
      }
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${cb}&v=weekly`;
    s.async = true;
    s.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(s);
  });
  return mapsPromise;
}
