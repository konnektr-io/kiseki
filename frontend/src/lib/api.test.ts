/**
 * Trip fetch + session cache (#64).
 *
 * The cache exists so navigating between a trip's pages doesn't re-read the
 * document. The subtlety it has to respect: an anonymously-read public trip
 * comes back WITHOUT `myRole`, so it is not interchangeable with the same
 * trip read with credentials.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TripAccessError, clearTripCache, fetchTrip } from "./api";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";

const anonDoc = { id: TRIP_ID, slug: "canada-2027", visibility: "public" };
const crewDoc = { ...anonDoc, myRole: "owner" };

/** Stub global fetch, returning `bodies` in order (last one repeats). */
function stubFetch(...bodies: Array<Record<string, unknown>>) {
  const sent: Array<string | undefined> = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      sent.push(init?.headers?.Authorization);
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return { ok: true, json: async () => body } as unknown as Response;
    }),
  );
  return sent;
}

afterEach(() => {
  clearTripCache();
  vi.unstubAllGlobals();
});

describe("fetchTrip", () => {
  it("sends the access token as a bearer header", async () => {
    const sent = stubFetch(crewDoc);
    await fetchTrip(TRIP_ID, "tok-123");
    expect(sent).toEqual(["Bearer tok-123"]);
  });

  it("sends no Authorization header when anonymous", async () => {
    const sent = stubFetch(anonDoc);
    await fetchTrip(TRIP_ID);
    expect(sent).toEqual([undefined]);
  });

  it("serves a repeat authenticated read from cache", async () => {
    const sent = stubFetch(crewDoc);
    await fetchTrip(TRIP_ID, "tok-123");
    const again = await fetchTrip(TRIP_ID, "tok-123");
    expect(sent).toHaveLength(1);
    expect(again.myRole).toBe("owner");
  });

  it("does not serve an anonymous document to an authenticated read", async () => {
    // Signing in on a public trip page: the anonymous document is already
    // cached, but it carries no myRole — reusing it would hide the owner's
    // join-link button for the rest of the session.
    const sent = stubFetch(anonDoc, crewDoc);
    const anon = await fetchTrip(TRIP_ID);
    expect(anon.myRole).toBeUndefined();

    const asCrew = await fetchTrip(TRIP_ID, "tok-123");
    expect(sent).toEqual([undefined, "Bearer tok-123"]);
    expect(asCrew.myRole).toBe("owner");
  });

  it("caches under the trip id too, so a later read by id hits", async () => {
    const sent = stubFetch(crewDoc);
    await fetchTrip(TRIP_ID, "tok-123");
    await fetchTrip(anonDoc.id, "tok-123");
    expect(sent).toHaveLength(1);
  });

  it("throws TripAccessError carrying the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ detail: "You don't have access to this trip" }),
      }) as unknown as Response),
    );
    await expect(fetchTrip(TRIP_ID, "tok-123")).rejects.toMatchObject({
      status: 403,
      message: "You don't have access to this trip",
    });
    await expect(fetchTrip(TRIP_ID, "tok-123")).rejects.toBeInstanceOf(TripAccessError);
  });
});
