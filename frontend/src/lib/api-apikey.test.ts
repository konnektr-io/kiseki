// @vitest-environment jsdom
/**
 * The admin API key drives real SPA API calls (issue #324).
 *
 * The helper test (`auth-headers.test.ts`) pins the header rule. This one
 * pins the SIDE EFFECT that makes browser probes work: with
 * `window.__KISEKI_API_KEY__` injected exactly as Playwright sets it, the app
 * reaches the read, write and identity surfaces over `X-API-Key` — with no
 * bearer anywhere — so a probe session is fully authorized without minting a
 * metered Auth0 M2M token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearTripCache, deleteTrip, fetchMyTrips, fetchTrip, putTrip } from "./api";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "ksk_probe_injected";

type Sent = { url: string; method?: string; headers: Record<string, string> };

function stubFetch(...bodies: Array<Record<string, unknown>>) {
  const sent: Sent[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      sent.push({ url, method: init?.method, headers: init?.headers ?? {} });
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Headers(),
      } as unknown as Response;
    }),
  );
  return sent;
}

afterEach(() => {
  delete window.__KISEKI_API_KEY__;
  clearTripCache();
  vi.unstubAllGlobals();
});

describe("API key injected like a Playwright probe", () => {
  it("reads a trip over X-API-Key with no bearer", async () => {
    window.__KISEKI_API_KEY__ = KEY;
    const sent = stubFetch({ id: TRIP_ID, myRole: "owner" });

    await fetchTrip(TRIP_ID); // e2e mode passes no token at all

    expect(sent[0].headers["X-API-Key"]).toBe(KEY);
    expect(sent[0].headers.Authorization).toBeUndefined();
  });

  it("writes with the key and a JSON content type", async () => {
    window.__KISEKI_API_KEY__ = KEY;
    const sent = stubFetch({ id: TRIP_ID, title: "Key Title" });

    await putTrip(TRIP_ID, { title: "Key Title" }, "");

    expect(sent[0].method).toBe("PUT");
    expect(sent[0].headers["X-API-Key"]).toBe(KEY);
    expect(sent[0].headers["Content-Type"]).toBe("application/json");
    expect(sent[0].headers.Authorization).toBeUndefined();
  });

  it("carries the key on identity-scoped reads (my trips)", async () => {
    window.__KISEKI_API_KEY__ = KEY;
    const sent = stubFetch({ trips: [] });

    await fetchMyTrips("");

    expect(sent[0].headers["X-API-Key"]).toBe(KEY);
    expect(sent[0].headers.Authorization).toBeUndefined();
  });

  it("carries the key on destructive calls (trip delete)", async () => {
    window.__KISEKI_API_KEY__ = KEY;
    const sent = stubFetch({});

    await deleteTrip(TRIP_ID, "");

    expect(sent[0].method).toBe("DELETE");
    expect(sent[0].headers["X-API-Key"]).toBe(KEY);
  });

  it("still uses the bearer when no key is injected (unchanged user path)", async () => {
    const sent = stubFetch({ id: TRIP_ID, myRole: "owner" });

    await fetchTrip(TRIP_ID, "user-token");

    expect(sent[0].headers.Authorization).toBe("Bearer user-token");
    expect(sent[0].headers["X-API-Key"]).toBeUndefined();
  });
});
