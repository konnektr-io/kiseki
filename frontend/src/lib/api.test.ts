/**
 * Trip fetch + session cache (#64).
 *
 * The cache exists so navigating between a trip's pages doesn't re-read the
 * document. The subtlety it has to respect: an anonymously-read public trip
 * comes back WITHOUT `myRole`, so it is not interchangeable with the same
 * trip read with credentials.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TripAccessError,
  addCrewMember,
  clearTripCache,
  fetchTrip,
  refetchTrip,
  removeCrewMember,
} from "./api";

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

describe("refetchTrip (agent edits must reach the UI)", () => {
  it("bypasses the session cache and re-reads the document", async () => {
    // The chat drawer refetches after every completed turn: a cached copy
    // would serve the PRE-agent document and the edit would stay invisible.
    const sent = stubFetch(crewDoc, { ...crewDoc, title: "Agent just edited this" });
    await fetchTrip(TRIP_ID, "tok-123");
    const fresh = (await refetchTrip(TRIP_ID, "tok-123")) as unknown as { title?: string };
    expect(sent.length).toBe(2); // the second read really hit the network
    expect(fresh.title).toBe("Agent just edited this");
  });

  it("drops the anonymous copy too — one cache key is not the other", async () => {
    const sent = stubFetch(anonDoc, crewDoc);
    await fetchTrip(TRIP_ID); // anonymous read cached under `<id>|anon`
    await refetchTrip(TRIP_ID, "tok-123");
    expect(sent).toEqual([undefined, "Bearer tok-123"]);
  });
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

describe("crew writes (#198)", () => {
  /** Stub fetch capturing method + url + body + bearer for write assertions. */
  function stubWrite(doc: Record<string, unknown>) {
    const sent: Array<{
      method?: string;
      url: string;
      body?: string;
      auth?: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        sent.push({ method: init?.method, url, body: init?.body, auth: init?.headers?.Authorization });
        return { ok: true, json: async () => doc } as unknown as Response;
      }),
    );
    return sent;
  }

  it("addCrewMember POSTs the body to /api/trips/<id>/crew with the bearer token", async () => {
    const sent = stubWrite(crewDoc);
    await addCrewMember(TRIP_ID, { name: "Stefan De Pauw", role: "editor", note: "gear" }, "tok-123");
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("POST");
    expect(sent[0].url).toBe(`/api/trips/${TRIP_ID}/crew`);
    expect(sent[0].auth).toBe("Bearer tok-123");
    expect(JSON.parse(sent[0].body ?? "{}")).toEqual({
      name: "Stefan De Pauw",
      role: "editor",
      note: "gear",
    });
  });

  it("removeCrewMember DELETEs /api/trips/<id>/crew/<personId> with the bearer token", async () => {
    const sent = stubWrite(crewDoc);
    await removeCrewMember(TRIP_ID, "person-1", "tok-123");
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("DELETE");
    expect(sent[0].url).toBe(`/api/trips/${TRIP_ID}/crew/person-1`);
    expect(sent[0].auth).toBe("Bearer tok-123");
  });
});
