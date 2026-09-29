import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { archiveReconcilePending, reconcileArchivedStage } from "./stage-reconcile";
import type { Trip } from "./types";

/**
 * The auto-archive write-back (#396) — the gate is the whole contract.
 *
 *  `archive` is the one stage transition `_validate_stage` restricts to the
 *  OWNER, so this decides who may cause a trip to be shelved. Everything here
 *  is about the gate: who, how often, in which direction, and what happens
 *  when the write fails.
 *
 *  `./api` is NOT module-mocked. `putTrip` is exercised through a stubbed
 *  global `fetch` (the real call path, headers and all), because two suites
 *  that both `vi.mock("./api")` share one mock registry per worker and the
 *  rejections leak across files as an unhandled rejection attributed to
 *  whichever test happens to run next.
 */

const ALBANY = { startDate: "2026-09-21", endDate: "2026-09-25" };

/** A finished trip as the server returns it: stored `live`, derived `archive`. */
function trip(over: Partial<Trip> = {}): Trip {
  return {
    id: "t1",
    title: "Albany",
    stage: "live",
    effectiveStage: "archive",
    myRole: "owner",
    days: [],
    sections: [],
    blocks: [],
    crew: [],
    ...ALBANY,
    ...over,
  } as Trip;
}

let sent: Array<{ url: string; method?: string; body?: unknown }> = [];
/** Status the stubbed PUT answers with; 200 unless a test says otherwise. */
let putStatus = 200;

function stubFetch(): void {
  sent = [];
  putStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "PUT") {
        sent.push({ url, method: "PUT", body: JSON.parse(init.body ?? "{}") });
        return {
          ok: putStatus < 400,
          status: putStatus,
          json: async () => (putStatus < 400 ? { ...trip(), stage: "archive" } : {}),
          text: async () => (putStatus < 400 ? "" : "forbidden"),
          headers: new Headers(),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => trip(), headers: new Headers() } as unknown as Response;
    }),
  );
}

beforeEach(stubFetch);
afterEach(() => vi.unstubAllGlobals());

describe("archiveReconcilePending", () => {
  it("is due for the owner on a finished, still-live trip", () => {
    expect(archiveReconcilePending(trip())).toBe(true);
  });

  it("is never due for a non-owner — a viewer must not shelve a trip", () => {
    // `archive` is owner-gated server-side (write.py `_validate_stage`), so a
    // follower opening a finished trip would 403; the gate turns that into a
    // no-op instead of a failed request on every page load.
    for (const role of ["editor", "viewer", "follower", undefined] as const) {
      expect(archiveReconcilePending(trip({ myRole: role as Trip["myRole"] }))).toBe(false);
    }
  });

  it("is due while the trip is still running or still ahead", () => {
    expect(archiveReconcilePending(trip({ effectiveStage: "live" }))).toBe(false);
    expect(archiveReconcilePending(trip({ endDate: "2027-03-02", effectiveStage: "live" }))).toBe(false);
  });

  it("is not due once the write has landed", () => {
    expect(archiveReconcilePending(trip({ stage: "archive" }))).toBe(false);
  });

  it("is not due for an early stage whose dates have passed", () => {
    // A stale `idea` is a plan being chosen between, not a finished trip.
    expect(archiveReconcilePending(trip({ stage: "idea", effectiveStage: "idea" }))).toBe(false);
  });

  it("is not due without an end date", () => {
    expect(archiveReconcilePending(trip({ endDate: undefined }))).toBe(false);
  });

  it("is not due when the server is not yet deriving auto-archive (#362 only)", () => {
    // Rolling the backend out first must not cause the frontend to write on a
    // verdict the server never gave: `effectiveStage: "live"` outranks the
    // local date check.
    expect(archiveReconcilePending(trip({ effectiveStage: "live" }))).toBe(false);
  });
});

describe("reconcileArchivedStage", () => {
  it("PUTs stage=archive once and returns the canonical document", async () => {
    const written = await reconcileArchivedStage(trip(), "tok");
    expect(written).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/trips/t1");
    expect(sent[0].body).toEqual({ stage: "archive" });
  });

  it("is idempotent — a second pass over the archived document sends nothing", async () => {
    await reconcileArchivedStage(trip(), "tok");
    sent = [];
    // The document the server returned, re-read on the next page load.
    await expect(reconcileArchivedStage({ ...trip(), stage: "archive" }, "tok")).resolves.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when the gate says no", async () => {
    await expect(reconcileArchivedStage(trip({ myRole: "viewer" }), "tok")).resolves.toBeNull();
    await expect(reconcileArchivedStage(trip({ effectiveStage: "live" }), "tok")).resolves.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("swallows a failed write — housekeeping must never break navigation", async () => {
    putStatus = 403;
    await expect(reconcileArchivedStage(trip(), "tok")).resolves.toBeNull();
  });
});
