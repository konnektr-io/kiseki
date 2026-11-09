/**
 * The Strava API client (#449) — endpoint shapes and the cache contract.
 *
 * Two things here are easy to get subtly wrong and invisible in the UI:
 *
 *  * every call must go to `/api/integrations/strava…` with
 *    `credentials: "same-origin"`, because the refresh token is an HttpOnly
 *    cookie scoped to that path — a call that omits credentials is simply
 *    "not connected";
 *  * the import answers with the trip document PLUS its own report, and that
 *    report must be stripped before the document is cached. A cached
 *    `written: true` would ride along into every later read of the trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("strava api client", () => {
  it("reads the status from the integrations path with the bearer token", async () => {
    const { fetchStravaStatus } = await import("./api");
    fetchMock.mockResolvedValue(
      jsonResponse({ configured: true, connected: true, athlete: { id: 1, name: "N" }, scopes: "read" }),
    );
    await fetchStravaStatus("tok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/integrations/strava/status");
    expect((init as RequestInit).credentials).toBe("same-origin");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("lists a trip's activities under the cookie's own path prefix", async () => {
    const { fetchStravaActivities } = await import("./api");
    fetchMock.mockResolvedValue(jsonResponse({ activities: [], scopes: "" }));
    await fetchStravaActivities("trip-1", "tok");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/integrations/strava/trips/trip-1/activities");
  });

  it("POSTs an import and keeps the report out of the cached document", async () => {
    const { importStravaActivity } = await import("./api");
    const doc = {
      id: "trip-1",
      slug: "trip-1",
      title: "Trip",
      days: [],
      // the report, exactly as the backend flattens it onto the document:
      written: true,
      conflict: null,
      day_id: "day-1",
      block_id: "block-1",
      track: "abc.gpx",
      photos: { written: 1, failed: 0, total: 1 },
      consent: true,
      activity: { id: 1, name: "Ride" },
    };
    fetchMock.mockResolvedValue(jsonResponse(doc));

    const { doc: returned, result } = await importStravaActivity("trip-1", "tok", {
      activity_id: 11,
      day_id: "day-1",
      include_photos: true,
      consent: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/integrations/strava/trips/trip-1/import");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      activity_id: 11,
      day_id: "day-1",
      include_photos: true,
      consent: true,
    });

    expect(result.written).toBe(true);
    expect(result.photos).toEqual({ written: 1, failed: 0, total: 1 });
    for (const key of ["written", "conflict", "day_id", "block_id", "track", "photos", "consent", "activity"]) {
      expect(returned, key).not.toHaveProperty(key);
    }
    expect(returned.id).toBe("trip-1");
  });

  it("surfaces an API refusal as a TripAccessError with the status", async () => {
    const { disconnectStrava, TripAccessError } = await import("./api");
    fetchMock.mockResolvedValue(jsonResponse({ detail: "nope" }, 403));
    await expect(disconnectStrava("tok")).rejects.toBeInstanceOf(TripAccessError);
    await expect(disconnectStrava("tok")).rejects.toMatchObject({ status: 403, message: "nope" });
  });
});
