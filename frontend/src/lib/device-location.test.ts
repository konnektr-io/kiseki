import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceLocationForChat,
  deviceLocationSnapshot,
  dismissDeviceNotice,
  isTrackingDevice,
  resetDeviceLocationForTests,
  startTrackingDevice,
  startTrackingDeviceIfPermitted,
  stopTrackingDevice,
  subscribeDeviceLocation,
} from "./device-location";
import { FIX_FRESH_MS } from "./geolocation";

/**
 * #383: the trip map's device-location session.
 *
 * These are the behavioural promises the feature is defined by:
 *
 *  - a fresh visitor is NEVER prompted (permission `prompt`/`unknown` does not
 *    start a watch),
 *  - a returning traveler with granted permission IS tracked without a tap,
 *  - a failed or revoked watch puts the control back to idle rather than
 *    leaving a live button with a frozen dot,
 *  - the chat only ever sees a position from a session that is TRACKING and
 *    from a fix that is FRESH.
 */

/** A scriptable `navigator.geolocation`, plus a permission state we control. */
function installBrowser(opts: {
  permission?: string | null;
  fix?: { latitude: number; longitude: number; accuracy: number } | null;
  fail?: number;
  watch?: boolean;
}) {
  const stops = { clearWatch: vi.fn(), removeEventListener: vi.fn() };
  const state = { emit: null as ((pos: GeolocationPosition) => void) | null };
  const failWith = opts.fail ?? null;
  const geolocation = {
    watchPosition: (ok: (pos: GeolocationPosition) => void, err: (e: { code: number }) => void) => {
      state.emit = ok;
      if (failWith != null) queueMicrotask(() => err({ code: failWith }));
      else if (opts.fix) {
        const fix = opts.fix;
        queueMicrotask(() =>
          ok({
            coords: { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy },
            timestamp: 0,
          } as GeolocationPosition),
        );
      }
      return 11;
    },
    clearWatch: stops.clearWatch,
  };
  const permissions =
    opts.permission === null
      ? undefined
      : {
          query: () =>
            Promise.resolve({
              state: opts.permission ?? "prompt",
              addEventListener: () => {},
              removeEventListener: stops.removeEventListener,
            }),
        };
  vi.stubGlobal("navigator", { geolocation, permissions });
  return { ...stops, state };
}

/** Let the promise chain behind a start land. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const AMSTERDAM = { latitude: 52.0907, longitude: 5.1214, accuracy: 8 };

afterEach(() => {
  resetDeviceLocationForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startTrackingDeviceIfPermitted (the on-mount path)", () => {
  it("starts silently when the browser already holds a granted permission", async () => {
    installBrowser({ permission: "granted", fix: AMSTERDAM });
    startTrackingDeviceIfPermitted();
    await settle();
    expect(isTrackingDevice()).toBe(true);
    expect(deviceLocationSnapshot().fix).toMatchObject({ lat: 52.0907, lng: 5.1214 });
  });

  it("does NOT start on `prompt` — the whole point of the feature", async () => {
    const browser = installBrowser({ permission: "prompt" });
    startTrackingDeviceIfPermitted();
    await settle();
    expect(isTrackingDevice()).toBe(false);
    expect(browser.clearWatch).not.toHaveBeenCalled();
    expect(deviceLocationSnapshot()).toMatchObject({ permission: "prompt", tracking: false });
  });

  it("does NOT start when the permission is unqueryable (unknown)", async () => {
    installBrowser({ permission: null });
    startTrackingDeviceIfPermitted();
    await settle();
    expect(isTrackingDevice()).toBe(false);
    expect(deviceLocationSnapshot().permission).toBe("unknown");
  });

  it("does NOT start on `denied`", async () => {
    installBrowser({ permission: "denied" });
    startTrackingDeviceIfPermitted();
    await settle();
    expect(isTrackingDevice()).toBe(false);
  });
});

describe("startTrackingDevice (the tap path)", () => {
  it("tracks, records the fix, and stops cleanly", async () => {
    const browser = installBrowser({ permission: "granted", fix: AMSTERDAM });
    const seen: boolean[] = [];
    subscribeDeviceLocation(() => seen.push(deviceLocationSnapshot().tracking));
    startTrackingDevice();
    await settle();
    expect(deviceLocationSnapshot()).toMatchObject({
      tracking: true,
      permission: "granted",
      notice: null,
    });
    stopTrackingDevice();
    expect(browser.clearWatch).toHaveBeenCalledWith(11);
    expect(deviceLocationSnapshot()).toMatchObject({ tracking: false, fix: null });
    // ...and the subscribers saw exactly that transition, never a flicker back
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    expect(seen.slice(0, -1).every(Boolean)).toBe(true);
  });

  it("is a no-op when already tracking (a second tap, a StrictMode mount)", async () => {
    const browser = installBrowser({ permission: "granted", fix: AMSTERDAM });
    startTrackingDevice();
    startTrackingDevice();
    await settle();
    stopTrackingDevice();
    expect(browser.clearWatch).toHaveBeenCalledTimes(1);
  });

  it("ignores a fix that arrives after the traveler turned it off", async () => {
    const browser = installBrowser({ permission: "granted" });
    startTrackingDevice();
    await settle();
    stopTrackingDevice();
    // the watch had not answered yet; its callback must not repaint a dot
    browser.state.emit!({
      coords: { latitude: 52.1, longitude: 5.1, accuracy: 5 },
      timestamp: 0,
    } as GeolocationPosition);
    expect(deviceLocationSnapshot()).toMatchObject({ tracking: false, fix: null });
  });

  it("reports a denial as a notice and goes back to idle", async () => {
    installBrowser({ permission: "prompt", fail: 1 });
    startTrackingDevice();
    await settle();
    expect(deviceLocationSnapshot()).toMatchObject({
      tracking: false,
      permission: "denied",
      notice: "Location is blocked for this site.",
    });
    dismissDeviceNotice();
    expect(deviceLocationSnapshot().notice).toBeNull();
  });

  it("reports a timeout as a notice, quietly", async () => {
    installBrowser({ permission: "granted", fail: 3 });
    startTrackingDevice();
    await settle();
    expect(deviceLocationSnapshot().tracking).toBe(false);
    expect(deviceLocationSnapshot().notice).toBe("Couldn’t get a location fix.");
  });

  it("says so when the device has no geolocation at all", () => {
    vi.stubGlobal("navigator", {});
    startTrackingDevice();
    expect(deviceLocationSnapshot()).toMatchObject({
      tracking: false,
      notice: "This device can’t share a location.",
    });
  });
});

describe("deviceLocationForChat", () => {
  const start = async (fix = AMSTERDAM) => {
    installBrowser({ permission: "granted", fix });
    startTrackingDevice();
    await settle();
  };

  it("hands the chat a rounded position while the map is tracking", async () => {
    await start({ latitude: 52.090712345678, longitude: 5.1214987, accuracy: 7.6 });
    expect(deviceLocationForChat()).toEqual({ lat: 52.09071, lng: 5.1215, accuracy: 8 });
  });

  it("is null before any fix has landed", async () => {
    installBrowser({ permission: "granted" });
    startTrackingDevice();
    await settle();
    expect(deviceLocationForChat()).toBeNull();
  });

  it("is null once tracking stops — a stopped session is not a location", async () => {
    await start();
    expect(deviceLocationForChat()).not.toBeNull();
    stopTrackingDevice();
    expect(deviceLocationForChat()).toBeNull();
  });

  it("is null for a stale fix (a suspended tab), never a silent guess", async () => {
    await start();
    expect(deviceLocationForChat(Date.now())).not.toBeNull();
    expect(deviceLocationForChat(Date.now() + FIX_FRESH_MS + 1)).toBeNull();
  });

  it("is null when only the permission was probed and nothing started", async () => {
    installBrowser({ permission: "prompt" });
    startTrackingDeviceIfPermitted();
    await settle();
    expect(deviceLocationForChat()).toBeNull();
  });
});
