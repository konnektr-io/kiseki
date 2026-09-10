import { describe, expect, it } from "vitest";
import {
  containsRawSecretPath,
  normalizeSecretPath,
  scrubSecretTokens,
  SECRET_URL_PROPERTIES,
} from "./analytics-privacy";

/**
 * Issue #21 acceptance criterion: "Share tokens and claim tokens never leave the
 * browser — paths normalized to `:token` before send, referrer suppressed on trip
 * pages, and an automated test asserting it."
 *
 * These tests are the asserting half of that guarantee. They exercise the exact
 * function wired into the SDK's `before_send` hook, in a plain node environment
 * (no SDK, no DOM) — so they cannot silently degrade into testing the vendor.
 */

// Shapes taken from the real app: /t/<trip $dtId> (id-based routes since #64)
// and /join/<claimToken>; plus a legacy 128-bit share-token path.
const TRIP_ID = "bf29a027-1f6c-4a3b-9d21-7c0e5a4b8f13";
const CLAIM_TOKEN = "c66b1f42f0e94d5c8a7b3e2d1c0f9a8b7e6d5c4b3a291807f6e5d4c3b2a1908";

describe("normalizeSecretPath", () => {
  it("collapses the trip uid in /t/<id> to :token", () => {
    const out = normalizeSecretPath(`https://kiseki.konnektr.io/t/${TRIP_ID}/itinerary`);
    expect(out).toBe("https://kiseki.konnektr.io/t/:token/itinerary");
    expect(out).not.toContain(TRIP_ID);
  });

  it("collapses the claim token in /join/<x>", () => {
    const out = normalizeSecretPath(`https://kiseki.konnektr.io/join/${CLAIM_TOKEN}`);
    expect(out).toBe("https://kiseki.konnektr.io/join/:token");
    expect(out).not.toContain(CLAIM_TOKEN);
  });

  it("keeps deeper trip sub-paths so page-level reporting still works", () => {
    expect(normalizeSecretPath(`https://kiseki.konnektr.io/t/${TRIP_ID}/day/3`)).toBe(
      "https://kiseki.konnektr.io/t/:token/day/3",
    );
    expect(normalizeSecretPath(`https://kiseki.konnektr.io/t/${TRIP_ID}/booklet`)).toBe(
      "https://kiseki.konnektr.io/t/:token/booklet",
    );
  });

  it("drops the query string and fragment (both can carry secrets)", () => {
    const out = normalizeSecretPath(
      `https://kiseki.konnektr.io/t/${TRIP_ID}?token=leak&kiseki_e2e=1#s-2`,
    );
    expect(out).toBe("https://kiseki.konnektr.io/t/:token");
    expect(out).not.toContain("leak");
    expect(out).not.toContain("kiseki_e2e");
  });

  it("leaves non-trip paths intact", () => {
    expect(normalizeSecretPath("https://kiseki.konnektr.io/")).toBe("https://kiseki.konnektr.io/");
    expect(normalizeSecretPath("https://kiseki.konnektr.io/api/health")).toBe(
      "https://kiseki.konnektr.io/api/health",
    );
  });

  it("does not mangle a string that cannot be parsed as a URL", () => {
    // `new URL` throws on this; the guard must pass the value through rather
    // than replace an unknown string with something fabricated.
    expect(normalizeSecretPath("http://[")).toBe("http://[");
  });

  it("resolves relative URLs against the app origin", () => {
    expect(normalizeSecretPath(`/t/${TRIP_ID}`, "https://kiseki.konnektr.io")).toBe(
      "https://kiseki.konnektr.io/t/:token",
    );
  });
});

describe("scrubSecretTokens (the before_send hook body)", () => {
  it("scrubs every URL-bearing default property", () => {
    const event = {
      uuid: "e-1",
      event: "$pageview",
      properties: {
        $current_url: `https://kiseki.konnektr.io/t/${TRIP_ID}/itinerary`,
        $referrer: `https://kiseki.konnektr.io/join/${CLAIM_TOKEN}`,
        $entry_url: `https://kiseki.konnektr.io/t/${TRIP_ID}`,
        $exit_url: `https://kiseki.konnektr.io/t/${TRIP_ID}/practical`,
      },
    };

    const out = scrubSecretTokens(event);

    for (const key of SECRET_URL_PROPERTIES) {
      const value = (out.properties as Record<string, unknown>)[key];
      expect(containsRawSecretPath(value), `${key} still carries a raw secret`).toBe(false);
    }
    expect(JSON.stringify(out)).not.toContain(TRIP_ID);
    expect(JSON.stringify(out)).not.toContain(CLAIM_TOKEN);
  });

  it("returns null/undefined untouched (the SDK passes null through)", () => {
    expect(scrubSecretTokens(null as never)).toBeNull();
    expect(scrubSecretTokens(undefined as never)).toBeUndefined();
  });

  it("tolerates an event without usable properties", () => {
    const noProps = { uuid: "e-2", event: "$pageview", properties: undefined };
    expect(scrubSecretTokens(noProps)).toBe(noProps);
    const nullProps = { uuid: "e-2b", event: "$pageview", properties: null };
    expect(scrubSecretTokens(nullProps)).toBe(nullProps);
    const nonObject = { uuid: "e-2c", event: "$pageview", properties: "nope" };
    expect(scrubSecretTokens(nonObject)).toBe(nonObject);
  });

  it("does not add, drop or rename the SDK's own fields", () => {
    const event = {
      uuid: "e-3",
      event: "trip_todo_item_toggled",
      properties: { $current_url: `https://kiseki.konnektr.io/t/${TRIP_ID}`, completed: true },
      $set: { plan: "pro" },
    };
    const out = scrubSecretTokens(event);
    expect(out.uuid).toBe("e-3");
    expect(out.event).toBe("trip_todo_item_toggled");
    expect(out.$set).toEqual({ plan: "pro" });
    expect((out.properties as Record<string, unknown>).completed).toBe(true);
  });

  it("preserves the trip id when it is sent as a property, not a path (#21)", () => {
    // Per-trip metrics are keyed on the opaque trip id property — that is the
    // sanctioned way to segment by trip, and it must survive scrubbing.
    const event = {
      uuid: "e-4",
      event: "$pageview",
      properties: {
        $current_url: `https://kiseki.konnektr.io/t/${TRIP_ID}/itinerary`,
        trip_id: TRIP_ID,
      },
    };
    const out = scrubSecretTokens(event);
    const props = out.properties as Record<string, unknown>;
    expect(props.trip_id).toBe(TRIP_ID);
    // ...while the same id in the PATH is still collapsed.
    expect(props.$current_url).toBe("https://kiseki.konnektr.io/t/:token/itinerary");
  });
});

describe("containsRawSecretPath (the test's own tripwire, sanity-checked)", () => {
  it("detects a raw secret path", () => {
    expect(containsRawSecretPath(`https://kiseki.konnektr.io/t/${TRIP_ID}`)).toBe(true);
    expect(containsRawSecretPath(`/join/${CLAIM_TOKEN}`)).toBe(true);
  });

  it("accepts a normalized path and unrelated values", () => {
    expect(containsRawSecretPath("https://kiseki.konnektr.io/t/:token")).toBe(false);
    expect(containsRawSecretPath("https://kiseki.konnektr.io/join/:token")).toBe(false);
    expect(containsRawSecretPath("https://kiseki.konnektr.io/itinerary")).toBe(false);
    expect(containsRawSecretPath(42)).toBe(false);
    expect(containsRawSecretPath(null)).toBe(false);
  });
});
