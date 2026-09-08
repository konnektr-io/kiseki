import { afterEach, describe, expect, it, vi } from "vitest";

/* Live drive-time data layer (card polish): URL building, body parsing and
 * the cached fetch — all plain functions, no DOM needed (vitest runs in the
 * NODE env). The hook itself (`useLiveDirections`) is exercised implicitly:
 * SSR renders the static values (pinned in blocks.test.tsx) because effects
 * never run server-side — same reason the booklet PDF keeps static values.
 */

import {
  buildDirectionsUrl,
  clearDirectionsCache,
  fetchDirections,
  parseDirectionsBody,
} from "./directions";

const A = { lat: 43.27, lng: 140.92 }; // Kiroro-ish
const B = { lat: 43.08, lng: 141.19 }; // Teine-ish

afterEach(() => {
  clearDirectionsCache();
  vi.unstubAllGlobals();
});

describe("buildDirectionsUrl", () => {
  it("encodes the lat/lng pair as query params", () => {
    const url = buildDirectionsUrl(A, B);
    expect(url).toBe(
      "/api/maps/directions?fromLat=43.27&fromLng=140.92&toLat=43.08&toLng=141.19",
    );
  });
});

describe("parseDirectionsBody", () => {
  it("passes through a full happy-path body", () => {
    expect(
      parseDirectionsBody({
        available: true,
        durationText: "1 hour 35 mins",
        distanceText: "143 km",
      }),
    ).toEqual({ available: true, durationText: "1 hour 35 mins", distanceText: "143 km" });
  });

  it("treats available:false and garbage as unavailable (never throws)", () => {
    expect(parseDirectionsBody({ available: false })).toEqual({ available: false });
    expect(parseDirectionsBody(null)).toEqual({ available: false });
    expect(parseDirectionsBody("oops")).toEqual({ available: false });
    expect(parseDirectionsBody({ available: true })).toEqual({ available: true });
  });
});

function mockFetchOnce(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => ({ ok, json: async () => body }) as Response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("fetchDirections", () => {
  it("returns the parsed body on success and caches per (from,to)", async () => {
    const fetch = mockFetchOnce({ available: true, durationText: "1 hour 35 mins" });
    const first = await fetchDirections(A, B);
    expect(first).toEqual({ available: true, durationText: "1 hour 35 mins" });
    const second = await fetchDirections(A, B);
    expect(second).toEqual(first);
    // Scrolling days remounts cards — one coordinate pair pays once.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps static values on failure (available:false, HTTP error, throw, bad JSON)", async () => {
    // Explicit unavailable …
    mockFetchOnce({ available: false });
    expect(await fetchDirections(A, B)).toEqual({ available: false });

    // … HTTP error …
    clearDirectionsCache();
    mockFetchOnce({}, false);
    expect(await fetchDirections(A, B)).toEqual({ available: false });

    // … network throw …
    clearDirectionsCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    expect(await fetchDirections(A, B)).toEqual({ available: false });

    // … and unparseable JSON — all quiet, the card keeps its static values.
    clearDirectionsCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      }) as unknown as Response),
    );
    expect(await fetchDirections(A, B)).toEqual({ available: false });
  });
});
