import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accuracyRadiusPx,
  describeLocationError,
  deviceFixIfGranted,
  FIX_FRESH_MS,
  geolocationSupported,
  isFresh,
  isValidFix,
  locateControl,
  metersPerPixel,
  queryLocationPermission,
  START_FIX_TIMEOUT_MS,
  toChatLocation,
  toFix,
  watchDeviceFix,
  watchLocationPermission,
  type DeviceFix,
} from "./geolocation";

/**
 * #383: the browser edge of the device-location feature.
 *
 * The two rules worth a test are negative ones — Kiseki must never PROMPT by
 * accident, and must never present a position it cannot stand behind:
 *
 *  - an unqueryable permission reads `unknown` (ask on a tap), never
 *    `granted` (start silently),
 *  - `toChatLocation` refuses a fix that is not a real coordinate, and rounds
 *    what it does send.
 */

const fix = (patch: Partial<DeviceFix> = {}): DeviceFix => ({
  lat: 52.0907,
  lng: 5.1214,
  accuracy: 8,
  at: 1_000_000,
  ...patch,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geolocationSupported", () => {
  it("is false when there is no navigator at all (the prerender runs in node)", () => {
    vi.stubGlobal("navigator", undefined);
    expect(geolocationSupported()).toBe(false);
  });

  it("is false when the browser has no geolocation API", () => {
    vi.stubGlobal("navigator", {});
    expect(geolocationSupported()).toBe(false);
  });

  it("is true when the browser exposes the API", () => {
    vi.stubGlobal("navigator", { geolocation: {} });
    expect(geolocationSupported()).toBe(true);
  });
});

describe("queryLocationPermission", () => {
  it("reports the browser's own state", async () => {
    for (const state of ["granted", "prompt", "denied"] as const) {
      vi.stubGlobal("navigator", {
        permissions: { query: () => Promise.resolve({ state }) },
      });
      expect(await queryLocationPermission()).toBe(state);
    }
  });

  it("is `unknown` without a Permissions API — the ask-on-tap default", async () => {
    vi.stubGlobal("navigator", { geolocation: {} });
    expect(await queryLocationPermission()).toBe("unknown");
  });

  it("is `unknown` when the query is refused, never a throw", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: () => Promise.reject(new Error("unsupported descriptor")),
      },
    });
    expect(await queryLocationPermission()).toBe("unknown");
  });

  it("is `unknown` for a state the browser invents", async () => {
    vi.stubGlobal("navigator", {
      permissions: { query: () => Promise.resolve({ state: "maybe" }) },
    });
    expect(await queryLocationPermission()).toBe("unknown");
  });
});

describe("watchLocationPermission", () => {
  it("subscribes only after the query resolves, and unsubscribes on stop", async () => {
    const removeEventListener = vi.fn();
    let handler: (() => void) | null = null;
    const status = {
      state: "granted",
      addEventListener: (_: string, cb: () => void) => {
        handler = cb;
      },
      removeEventListener,
    };
    vi.stubGlobal("navigator", { permissions: { query: () => Promise.resolve(status) } });
    const seen: string[] = [];
    const stop = watchLocationPermission((p) => seen.push(p));
    await Promise.resolve();
    expect(handler).not.toBeNull();
    // The subscription is only useful once it can answer with a state.
    expect(seen).toEqual([]);
    stop();
    expect(removeEventListener).toHaveBeenCalledWith("change", handler);
  });

  it("is inert without the API", () => {
    vi.stubGlobal("navigator", { geolocation: {} });
    expect(() => watchLocationPermission(() => {})()).not.toThrow();
  });
});

describe("watchDeviceFix", () => {
  it("reports a normalized fix and stops with clearWatch", () => {
    let success: ((pos: GeolocationPosition) => void) | null = null;
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", {
      geolocation: {
        watchPosition: (ok: (pos: GeolocationPosition) => void) => {
          success = ok;
          return 7;
        },
        clearWatch,
      },
    });
    const fixes: DeviceFix[] = [];
    const stop = watchDeviceFix(
      (f) => fixes.push(f),
      () => {
        throw new Error("should not fail");
      },
    );
    success!({
      coords: { latitude: 52.1, longitude: 5.2, accuracy: 12 },
      timestamp: 42,
    } as GeolocationPosition);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ lat: 52.1, lng: 5.2, accuracy: 12 });
    stop();
    expect(clearWatch).toHaveBeenCalledWith(7);
  });

  it("answers a missing API with the error path, not a live watch", () => {
    vi.stubGlobal("navigator", {});
    const errors: string[] = [];
    const stop = watchDeviceFix(
      () => {
        throw new Error("should not fix");
      },
      (e) => errors.push(e.code),
    );
    expect(errors).toEqual(["unknown"]);
    expect(() => stop()).not.toThrow();
  });
});

describe("describeLocationError", () => {
  it("maps the three spec codes to traveler language", () => {
    expect(describeLocationError({ code: 1 })).toEqual({
      code: "denied",
      message: "Location is blocked for this site.",
    });
    expect(describeLocationError({ code: 2 }).code).toBe("unavailable");
    expect(describeLocationError({ code: 3 }).code).toBe("timeout");
    expect(describeLocationError({ code: 99 }).code).toBe("unknown");
  });

  it("reads the constants off the error when the engine exposes them", () => {
    expect(describeLocationError({ code: 73, PERMISSION_DENIED: 73 }).code).toBe("denied");
  });
});

describe("toFix / isValidFix / isFresh", () => {
  it("normalizes a browser position", () => {
    const out = toFix({
      coords: { latitude: 1, longitude: 2, accuracy: Number.NaN },
      timestamp: 5,
    } as GeolocationPosition);
    expect(out).toMatchObject({ lat: 1, lng: 2, accuracy: null });
    expect(out.at).toBeGreaterThan(0);
  });

  it("rejects anything that is not a real coordinate", () => {
    expect(isValidFix(fix())).toBe(true);
    expect(isValidFix(fix({ lat: 91 }))).toBe(false);
    expect(isValidFix(fix({ lng: -181 }))).toBe(false);
    expect(isValidFix(fix({ lat: Number.NaN }))).toBe(false);
    expect(isValidFix({ lat: 1, lng: 2 })).toBe(false); // no clock
    expect(isValidFix(null)).toBe(false);
    expect(isValidFix("52.1,5.2")).toBe(false);
  });

  it("treats a fix older than the window as stale", () => {
    const now = 10_000_000;
    expect(isFresh(fix({ at: now - FIX_FRESH_MS }), now)).toBe(true);
    expect(isFresh(fix({ at: now - FIX_FRESH_MS - 1 }), now)).toBe(false);
  });
});

describe("toChatLocation", () => {
  it("rounds to the sharing precision and never emits strings", () => {
    const out = toChatLocation(fix({ lat: 52.090712345678, lng: 5.121498765432, accuracy: 7.6 }));
    expect(out).toEqual({ lat: 52.09071, lng: 5.1215, accuracy: 8 });
    expect(typeof out!.lat).toBe("number");
  });

  it("passes a missing accuracy through as null, never as 0", () => {
    expect(toChatLocation(fix({ accuracy: null }))!.accuracy).toBeNull();
  });

  it("refuses a fix that is not a real coordinate", () => {
    expect(toChatLocation(fix({ lat: 123 }))).toBeNull();
  });
});

describe("metersPerPixel / accuracyRadiusPx", () => {
  it("halves per zoom level and shrinks away from the equator", () => {
    const equator = metersPerPixel(0, 12);
    expect(metersPerPixel(0, 13)).toBeCloseTo(equator / 2, 6);
    expect(metersPerPixel(60, 12)).toBeLessThan(equator);
  });

  it("draws ±100 m at the ground resolution of the view", () => {
    // z14 near Amsterdam ≈ 7 m/px → ±100 m is ~14px.
    expect(accuracyRadiusPx(100, 52.1, 14)).toBeCloseTo(100 / metersPerPixel(52.1, 14), 6);
  });

  it("clamps to something drawable and hides a useless accuracy", () => {
    expect(accuracyRadiusPx(null, 52.1, 14)).toBe(0);
    expect(accuracyRadiusPx(0, 52.1, 14)).toBe(0);
    expect(accuracyRadiusPx(50_000, 52.1, 18)).toBe(512);
    expect(accuracyRadiusPx(0.1, 52.1, 20)).toBe(3);
  });
});

describe("locateControl", () => {
  it("is `start` when nothing is being watched", () => {
    expect(locateControl({ tracking: false, following: false })).toEqual({
      action: "start",
      label: "Show my location",
      icon: "locate",
      following: false,
    });
  });

  it("is `stop` while following — the camera owns the view, so the tap stops", () => {
    expect(locateControl({ tracking: true, following: true }).action).toBe("stop");
  });

  it("is `recentre` when the traveler's own gesture paused following", () => {
    const control = locateControl({ tracking: true, following: false });
    expect(control.action).toBe("recentre");
    expect(control.icon).toBe("locate-fixed");
    expect(control.following).toBe(false);
  });
});

/**
 * #393: the one-shot starting fix the home globe asks for.
 *
 * The rule that matters here is a NEGATIVE one, the same one #383 is built on:
 * a caller wanting a starting point must never be the reason a traveler sees a
 * permission prompt. So everything but an already-`granted` permission answers
 * `null` without touching `navigator.geolocation` — and the read is a single
 * question, never a watch.
 */
describe("deviceFixIfGranted", () => {
  /** A navigator with a scripted permission, recording what was actually asked. */
  function stub(state: string | null, script: { pos?: unknown; fail?: unknown } = {}) {
    const getCurrentPosition = vi.fn(
      (
        ok: (pos: unknown) => void,
        fail: (err: unknown) => void,
        _options?: PositionOptions,
      ) => {
        if (script.fail !== undefined) fail(script.fail);
        else if (script.pos !== undefined) ok(script.pos);
        /* neither: the engine never calls back — the hang this must survive */
      },
    );
    const watchPosition = vi.fn();
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition, watchPosition, clearWatch },
      ...(state == null ? {} : { permissions: { query: () => Promise.resolve({ state }) } }),
    });
    return { getCurrentPosition, watchPosition, clearWatch };
  }

  const position = { coords: { latitude: 52.0907, longitude: 5.1214, accuracy: 120 } };

  it("asks the browser once for a granted permission, and normalizes the answer", async () => {
    const { getCurrentPosition, watchPosition } = stub("granted", { pos: position });
    const fix = await deviceFixIfGranted();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(fix).toMatchObject({ lat: 52.0907, lng: 5.1214, accuracy: 120 });
    // Not a session: nothing is watched, nothing is kept.
    expect(watchPosition).not.toHaveBeenCalled();
    // Coarse ON PURPOSE — a starting point, not a track.
    const options = getCurrentPosition.mock.calls[0][2] as PositionOptions;
    expect(options.enableHighAccuracy).toBe(false);
    expect(options.maximumAge).toBeGreaterThan(0);
  });

  it("asks nothing at all without an already-granted permission", async () => {
    for (const state of ["prompt", "denied", null] as const) {
      const { getCurrentPosition, watchPosition } = stub(state);
      expect(await deviceFixIfGranted()).toBeNull();
      expect(getCurrentPosition).not.toHaveBeenCalled();
      expect(watchPosition).not.toHaveBeenCalled();
    }
  });

  it("drops a refusal, a nonsense fix, and a device with no geolocation", async () => {
    const refused = stub("granted", { fail: { code: 1 } });
    expect(await deviceFixIfGranted()).toBeNull();
    expect(refused.getCurrentPosition).toHaveBeenCalledTimes(1);

    // A position that is not a real coordinate is never handed on.
    stub("granted", { pos: { coords: { latitude: Number.NaN, longitude: 5.1214 } } });
    expect(await deviceFixIfGranted()).toBeNull();

    vi.stubGlobal("navigator", {});
    expect(await deviceFixIfGranted()).toBeNull();
  });

  it("gives up at the deadline instead of holding a surface's first paint", async () => {
    vi.useFakeTimers();
    try {
      stub("granted"); // an engine that never calls back
      const pending = deviceFixIfGranted();
      // Let the permission query settle and arm the deadline…
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(START_FIX_TIMEOUT_MS + 1);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
