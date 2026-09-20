// @vitest-environment jsdom
/**
 * Thread-id storage isolation (2026-09-18 cross-user chat leak).
 *
 * localStorage is per BROWSER while logins are per user: thread ids stored
 * under a bare context key are reopened by whoever logs in next on the same
 * machine — a fresh test user inherited Niko's whole chat that way. Thread
 * slots are therefore keyed per (user, context).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { adoptThreadId, loadThreadId, newThreadId } from "./chat";

const NIKO = "google-oauth2|niko";
const NEWBIE = "auth0|new-user-1";

/** jsdom here ships no localStorage — stub a real one per test so the
 * production keying path (readThreads/write) is what gets exercised. */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    },
    configurable: true,
  });
  return store;
}

beforeEach(() => {
  stubStorage();
});

describe("per-user thread slots", () => {
  it("stores and loads a thread under the user's own slot", () => {
    const id = newThreadId("general", NIKO);
    expect(loadThreadId("general", NIKO)).toBe(id);
  });

  it("never hands one user's thread to another user on the same browser", () => {
    const nikoThread = newThreadId("general", NIKO);
    expect(nikoThread).toBeTruthy();
    // a second login on this machine sees NO thread, not Niko's
    expect(loadThreadId("general", NEWBIE)).toBeNull();
    const newbieThread = newThreadId("general", NEWBIE);
    expect(newbieThread).not.toBe(nikoThread);
    // and Niko's own slot still resolves to his thread
    expect(loadThreadId("general", NIKO)).toBe(nikoThread);
  });

  it("keeps trip contexts separate per user too", () => {
    const a = newThreadId("trip-1", NIKO);
    const b = newThreadId("trip-1", NEWBIE);
    expect(a).not.toBe(b);
    expect(loadThreadId("trip-1", NIKO)).toBe(a);
    expect(loadThreadId("trip-1", NEWBIE)).toBe(b);
  });

  it("falls back to the bare context key with no sub (signed-out/SSR)", () => {
    const id = newThreadId("general");
    expect(loadThreadId("general")).toBe(id);
    // …but that legacy slot is invisible to signed-in lookups
    expect(loadThreadId("general", NIKO)).toBeNull();
  });
});

describe("adoptThreadId (landing → trip handoff)", () => {
  it("carries the landing thread into the new trip's slot", () => {
    const landingThread = newThreadId("general", NIKO);
    adoptThreadId("trip-9", landingThread, NIKO);
    expect(loadThreadId("trip-9", NIKO)).toBe(landingThread);
    // the landing slot keeps pointing at the same thread
    expect(loadThreadId("general", NIKO)).toBe(landingThread);
  });

  it("never crosses users when adopting", () => {
    const landingThread = newThreadId("general", NIKO);
    adoptThreadId("trip-9", landingThread, NEWBIE);
    expect(loadThreadId("trip-9", NEWBIE)).toBe(landingThread);
    expect(loadThreadId("trip-9", NIKO)).toBeNull();
  });

  it("is a no-op without a thread id (SSR-safe, nothing stored)", () => {
    adoptThreadId("trip-9", "", NIKO);
    expect(loadThreadId("trip-9", NIKO)).toBeNull();
  });
});
