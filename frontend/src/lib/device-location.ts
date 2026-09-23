/**
 * The trip map's device-location session (#383) — ONE tracker, ONE store.
 *
 * `geolocation.ts` wraps the browser; this module owns the session: whether
 * the device is being watched, the latest fix, the permission as last seen,
 * and the one-line notice the map control shows when a start fails. It is a
 * module singleton rather than React state for two reasons:
 *
 *  - the CHAT needs the position at send time, from a component tree the map
 *    does not own (the drawer is mounted by `TripLayout`), and
 *  - the trip map must not lose the session when the surface remounts (a
 *    typed navigation, a browser reload of the level) — a fix that is 2s old
 *    is a fix, and re-prompting is exactly what this feature avoids.
 *
 * Only `RouteMap` starts it. The landing and home maps never call in here, so
 * "current location is a trip-map affordance" is enforced by the call graph,
 * not by a prop somebody can forget.
 *
 * PRIVACY: nothing is persisted (no localStorage, no cookie) and nothing is
 * sent anywhere except the next chat turn you submit, while the map is
 * tracking. Stop the control and the fix is gone.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  geolocationSupported,
  isFresh,
  isValidFix,
  queryLocationPermission,
  toChatLocation,
  watchDeviceFix,
  watchLocationPermission,
  type DeviceChatLocation,
  type DeviceFix,
  type LocationError,
  type LocationPermission,
} from "./geolocation";

export interface DeviceLocationState {
  /** Is the device being watched right now? */
  tracking: boolean;
  /** The latest fix (null until the first one lands, and again after a stop). */
  fix: DeviceFix | null;
  /** Permission as last observed. `unknown` = no Permissions API — see geolocation.ts. */
  permission: LocationPermission;
  /** Why the last start failed, as one line of traveler-facing text. */
  notice: string | null;
}

const IDLE: DeviceLocationState = {
  tracking: false,
  fix: null,
  permission: "unknown",
  notice: null,
};

let state: DeviceLocationState = IDLE;
const listeners = new Set<() => void>();

/** The live watch's stop function (null = not tracking). */
let stopWatch: (() => void) | null = null;
/** The live permission listener's stop function. */
let stopPermissionWatch: (() => void) | null = null;
/** Increments on every stop: callbacks from a superseded watch are ignored, so
 *  a slow first fix can never paint a dot after the traveler turned it off. */
let generation = 0;

function setState(patch: Partial<DeviceLocationState>): void {
  const next = { ...state, ...patch };
  if (
    next.tracking === state.tracking &&
    next.fix === state.fix &&
    next.permission === state.permission &&
    next.notice === state.notice
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeDeviceLocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current snapshot — a stable reference until something actually changes
 *  (`useSyncExternalStore` requires that, and the setter above guarantees it). */
export function deviceLocationSnapshot(): DeviceLocationState {
  return state;
}

export function isTrackingDevice(): boolean {
  return state.tracking;
}

/**
 * Start watching. Safe to call from a tap, from an effect, or twice in a row:
 * a second call while already tracking is a no-op, and the permission watcher
 * makes the app stop if the traveler revokes access mid-session.
 */
export function startTrackingDevice(): void {
  if (stopWatch) return; // already watching
  if (!geolocationSupported()) {
    setState({ permission: "unknown", notice: "This device can’t share a location." });
    return;
  }
  const mine = ++generation;
  const stillMine = () => mine === generation;
  setState({ tracking: true, notice: null });
  stopWatch = watchDeviceFix(
    (fix) => {
      if (!stillMine()) return;
      // The permission that drove this watch is granted by construction (the
      // browser only calls back with a position when it is), so record it.
      setState({ fix, permission: "granted" });
    },
    (error: LocationError) => {
      if (!stillMine()) return;
      // A failed watch is not a tracking session: the control must go back to
      // "show my location" instead of showing a live button with no dot.
      stopTrackingDevice();
      if (error.code === "denied") {
        setState({ permission: "denied", notice: error.message });
        return;
      }
      setState({ notice: error.message });
    },
  );
  stopPermissionWatch = watchLocationPermission((permission) => {
    if (!stillMine()) return;
    setState({ permission });
    if (permission === "denied") {
      stopTrackingDevice();
      setState({ permission: "denied", notice: "Location is blocked for this site." });
    }
  });
  // Remember the browser's own answer so the control's next state is honest
  // (a tap that triggers the prompt ends up "granted" a moment later).
  void queryLocationPermission().then((permission) => {
    if (!stillMine() || !state.tracking) return;
    setState({ permission });
  });
}

/**
 * Start watching ONLY if the browser already holds a granted permission for
 * this origin. This is the trip map's on-mount call: a returning traveler who
 * allowed location before sees their dot straight away, and everyone else
 * sees an idle control and no prompt.
 */
export function startTrackingDeviceIfPermitted(): void {
  if (stopWatch) return;
  void queryLocationPermission().then((permission) => {
    setState({ permission });
    if (permission === "granted") startTrackingDevice();
  });
}

export function stopTrackingDevice(): void {
  generation += 1; // orphan any in-flight fix from the watch being stopped
  stopWatch?.();
  stopWatch = null;
  stopPermissionWatch?.();
  stopPermissionWatch = null;
  setState({ tracking: false, fix: null });
}

/** Clear the notice (the map control dismisses it, or a new attempt replaces it). */
export function dismissDeviceNotice(): void {
  if (state.notice != null) setState({ notice: null });
}

/**
 * The position to attach to the next chat turn, or null.
 *
 * Null unless the map is TRACKING and the fix is fresh (`FIX_FRESH_MS`): the
 * agent must never be told "the traveler is here" from a session that was
 * stopped, or from a fix a suspended tab left behind. Read at send time — not
 * subscribable — because only the turn being submitted cares.
 */
export function deviceLocationForChat(now: number = Date.now()): DeviceChatLocation | null {
  if (!state.tracking || state.fix == null) return null;
  if (!isValidFix(state.fix) || !isFresh(state.fix, now)) return null;
  return toChatLocation(state.fix);
}

export interface UseDeviceLocationResult {
  state: DeviceLocationState;
  start: () => void;
  stop: () => void;
  dismissNotice: () => void;
}

/** React binding for the trip map's control. */
export function useDeviceLocation(): UseDeviceLocationResult {
  const snapshot = useSyncExternalStore(
    subscribeDeviceLocation,
    deviceLocationSnapshot,
    deviceLocationSnapshot,
  );
  const start = useCallback(() => startTrackingDevice(), []);
  const stop = useCallback(() => stopTrackingDevice(), []);
  const dismissNotice = useCallback(() => dismissDeviceNotice(), []);
  return { state: snapshot, start, stop, dismissNotice };
}

/** Test seam: back to a cold session between cases. */
export function resetDeviceLocationForTests(): void {
  generation += 1;
  stopWatch?.();
  stopWatch = null;
  stopPermissionWatch?.();
  stopPermissionWatch = null;
  state = IDLE;
  listeners.clear();
}
