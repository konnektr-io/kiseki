/**
 * Device location — the browser Geolocation API, permission-first (#383).
 *
 * Kiseki asks for the traveler's position in exactly TWO ways, and nothing
 * else in the app may touch `navigator.geolocation`:
 *
 *  1. **Already-granted permission** — a returning traveler who allowed
 *     location for this origin before is tracked again without a prompt.
 *  2. **An explicit tap** on the trip map's locate control.
 *
 * Why that pairing is load-bearing: a permission prompt on load trains people
 * to deny, and a denial is sticky — the browser never asks again. So the app
 * never calls `watchPosition` on its own initiative (see `device-location.ts`,
 * the only caller), and a fresh visitor sees no prompt at all until they ask.
 *
 * Everything here is a thin, mockable wrapper over `navigator.geolocation` /
 * `navigator.permissions` plus the pure geometry the map needs. No React, no
 * MapLibre — the state machine lives in `device-location.ts` and the surface
 * in `components/RouteMap.tsx`, both of which stay readable because the
 * browser edge is confined to this file. It is also SSR-safe: `prerender.tsx`
 * runs these pages in node, where `navigator` does not exist.
 */

/** One position fix, normalized: numbers only, plus when we received it. */
export interface DeviceFix {
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres (68% confidence), when the browser says. */
  accuracy: number | null;
  /** `Date.now()` at reception — the freshness clock, not the GPS timestamp. */
  at: number;
}

/**
 * Permission as the BROWSER reports it. `unknown` is not an error state: the
 * Permissions API either does not cover geolocation (older Safari/Firefox) or
 * the query was refused. An `unknown` permission means "ask only on a tap" —
 * never a silent start, because an unqueryable permission could be `prompt`,
 * and prompting is what this feature exists to avoid.
 */
export type LocationPermission = "granted" | "prompt" | "denied" | "unknown";

/** The geolocation failures that mean something to a traveler. */
export type LocationErrorCode = "denied" | "unavailable" | "timeout" | "unknown";

export interface LocationError {
  code: LocationErrorCode;
  /** One line, traveler-facing: shown beside the map control, never a code. */
  message: string;
}

/**
 * A fix older than this is NOT shared with the chat.
 *
 * `watchPosition` delivers continuously, so a stale fix means the page stopped
 * receiving (tab suspended, device asleep, a fixed desktop position). Offering
 * it as "where I am now" would answer "find restaurants around me" from where
 * the traveler was an hour ago — worse than saying nothing.
 */
export const FIX_FRESH_MS = 10 * 60 * 1000;

/**
 * Watch options. `enableHighAccuracy` because a trip map's whole point is the
 * street the traveler is standing on; `maximumAge` accepts a fix the browser
 * already has (up to 5s) so the first tap paints immediately instead of
 * waiting for a new satellite round-trip; the timeout keeps a bad fix from
 * hanging the control in a loading state forever.
 */
const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 15000,
};

/**
 * The grid the fix is rounded to when it is shared with the chat: 5 decimals
 * ≈ 1.1 m. Sub-metre precision buys the agent nothing and a location is the
 * most sensitive thing this app ever sends.
 */
const CHAT_PRECISION = 5;

export function geolocationSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

/** Normalize a browser position. Exported: the store's tests drive it directly. */
export function toFix(pos: GeolocationPosition): DeviceFix {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy:
      typeof pos.coords.accuracy === "number" && Number.isFinite(pos.coords.accuracy)
        ? pos.coords.accuracy
        : null,
    at: Date.now(),
  };
}

/** Whether a value is a usable fix — the guard between a browser and the wire. */
export function isValidFix(value: unknown): value is DeviceFix {
  if (value == null || typeof value !== "object") return false;
  const f = value as Partial<DeviceFix>;
  return (
    typeof f.lat === "number" &&
    Number.isFinite(f.lat) &&
    f.lat >= -90 &&
    f.lat <= 90 &&
    typeof f.lng === "number" &&
    Number.isFinite(f.lng) &&
    f.lng >= -180 &&
    f.lng <= 180 &&
    typeof f.at === "number" &&
    Number.isFinite(f.at)
  );
}

/** Fresh enough to be presented as "where I am now". */
export function isFresh(fix: DeviceFix, now: number = Date.now()): boolean {
  return now - fix.at <= FIX_FRESH_MS;
}

export function describeLocationError(error: {
  code?: number;
  PERMISSION_DENIED?: number;
  POSITION_UNAVAILABLE?: number;
  TIMEOUT?: number;
}): LocationError {
  // The constants live on `GeolocationPositionError` (and on the prototype in
  // some engines), so read them off the error itself and fall back to the
  // spec's fixed numbers — a browser that answers with neither still lands on
  // a useful message.
  const denied = error.PERMISSION_DENIED ?? 1;
  const unavailable = error.POSITION_UNAVAILABLE ?? 2;
  const timeout = error.TIMEOUT ?? 3;
  switch (error.code) {
    case denied:
      return { code: "denied", message: "Location is blocked for this site." };
    case unavailable:
      return { code: "unavailable", message: "Your location isn’t available right now." };
    case timeout:
      return { code: "timeout", message: "Couldn’t get a location fix." };
    default:
      return { code: "unknown", message: "Couldn’t get your location." };
  }
}

/**
 * Permission as the browser reports it, never throwing.
 *
 * A rejected `query` (Safari has historically refused unknown descriptors)
 * degrades to `unknown` rather than failing the caller: no permission answer
 * must never mean no locate control.
 */
export async function queryLocationPermission(): Promise<LocationPermission> {
  try {
    const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!permissions || typeof permissions.query !== "function") return "unknown";
    const status = await permissions.query({ name: "geolocation" });
    const state = status?.state;
    return state === "granted" || state === "prompt" || state === "denied" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Follow the permission while the trip map is open, so the control tells the
 * truth after a change made in the browser's own settings (a revocation turns
 * a live tracking session off instead of leaving a dot that never moves
 * again). Returns a no-op unsubscribe when the API is unavailable.
 */
export function watchLocationPermission(
  onChange: (permission: LocationPermission) => void,
): () => void {
  let status: PermissionStatus | null = null;
  let cancelled = false;
  const handler = () => onChange(status?.state as LocationPermission);
  try {
    const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!permissions || typeof permissions.query !== "function") return () => {};
    void permissions
      .query({ name: "geolocation" })
      .then((s) => {
        if (cancelled) return;
        status = s;
        s.addEventListener?.("change", handler);
      })
      .catch(() => {
        /* no permission handle: the control simply does not follow changes */
      });
  } catch {
    return () => {};
  }
  return () => {
    cancelled = true;
    status?.removeEventListener?.("change", handler);
  };
}

/**
 * Start watching the device position. Returns the stop function.
 *
 * Both callbacks are required so a caller cannot forget the failure path: a
 * watch that dies silently leaves the control looking live with a dot frozen
 * on the last fix.
 */
export function watchDeviceFix(
  onFix: (fix: DeviceFix) => void,
  onError: (error: LocationError) => void,
): () => void {
  if (!geolocationSupported()) {
    onError({ code: "unknown", message: "This device can’t share a location." });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix(toFix(pos)),
    (err) => onError(describeLocationError(err)),
    WATCH_OPTIONS,
  );
  return () => navigator.geolocation.clearWatch(id);
}

/**
 * Ground resolution at a latitude/zoom, in metres per CSS pixel — the Web
 * Mercator formula (156543.03392 m/px at z0 on the equator, halved per zoom
 * level, scaled by `cos(lat)`). This is what turns a fix's accuracy in METRES
 * into the accuracy halo's radius in PIXELS; MapLibre's `circle-radius` is
 * always pixels, so a halo that means "±50 m" has to be recomputed when the
 * camera zooms.
 */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/** The accuracy halo's radius in pixels, clamped to something drawable. */
export function accuracyRadiusPx(accuracyM: number | null, lat: number, zoom: number): number {
  if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM <= 0) return 0;
  const px = accuracyM / metersPerPixel(lat, zoom);
  return Math.min(Math.max(px, 3), 512);
}

/** The device position as the chat payload carries it: bounded, rounded, no prose. */
export interface DeviceChatLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
}

/** Round a fix for the chat. Returns null for anything that is not a real fix. */
export function toChatLocation(fix: DeviceFix): DeviceChatLocation | null {
  if (!isValidFix(fix)) return null;
  return {
    lat: Number(fix.lat.toFixed(CHAT_PRECISION)),
    lng: Number(fix.lng.toFixed(CHAT_PRECISION)),
    accuracy: fix.accuracy == null ? null : Math.round(fix.accuracy),
  };
}

/** The locate control's action for a given state — see `locateControl`. */
export type LocateAction = "start" | "recentre" | "stop";

export interface LocateControl {
  action: LocateAction;
  /** The traveler-facing label (also the button's `aria-label`). */
  label: string;
  /** Which glyph the button paints. */
  icon: "locate" | "locate-fixed";
  /** The camera is following the dot right now (accent tint, filled icon). */
  following: boolean;
}

/**
 * One button, three states — and every state reversible (Apple/Google Maps'
 * cycle, minus heading):
 *
 * | state                          | tap does                                |
 * |--------------------------------|-----------------------------------------|
 * | not tracking                   | start watching, centre on the first fix |
 * | tracking, camera following     | stop watching, remove the dot           |
 * | tracking, camera left free     | centre again, resume following          |
 *
 * The middle row is why "stop" is not a second control: while the camera
 * follows, the traveler's own gestures (a drag, a pinch-zoom) pause following
 * — see `RouteMap` — so the button has to mean "come back to me" in that
 * state, and a separate stop chip would be a second knob for the rarer action.
 * Pure: the tests pin the whole table without a map.
 */
export function locateControl(state: {
  tracking: boolean;
  following: boolean;
}): LocateControl {
  if (!state.tracking) {
    return { action: "start", label: "Show my location", icon: "locate", following: false };
  }
  if (state.following) {
    return { action: "stop", label: "Stop showing my location", icon: "locate-fixed", following: true };
  }
  return { action: "recentre", label: "Recentre on my location", icon: "locate-fixed", following: false };
}
