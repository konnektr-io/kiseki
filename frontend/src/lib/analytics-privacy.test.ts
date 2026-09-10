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
 * (no SDK, no DOM), so they cannot silently degrade into testing the vendor.
 *
 * The `$pathname` / `$initial_*` cases are not hypothetical: a rendered-browser
 * probe against the real SDK found the RAW trip id and claim token surviving in
 * exactly those properties while `$current_url` looked clean. They are the
 * regression guard for the leak that motivated walking every property.
 */

const TRIP_ID = "bf29a027-1f6c-4a3b-9d21-7c0e5a4b8f13";
const CLAIM_TOKEN = "c66b1f42f0e94d5c8a7b3e2d1c0f9a8b7e6d5c4b3a291807f6e5d4c3b2a1908";
const HOST = "https://kiseki.konnektr.io";

describe("normalizeSecretPath", () => {
  it("collapses the trip uid in /t/<id>", () => {
    const out = normalizeSecretPath(`${HOST}/t/${TRIP_ID}/itinerary`);
    expect(out).toBe(`${HOST}/t/:token/itinerary`);
    expect(out).not.toContain(TRIP_ID);
  });

  it("collapses the claim token in /join/<x>", () => {
    const out = normalizeSecretPath(`${HOST}/join/${CLAIM_TOKEN}`);
    expect(out).toBe(`${HOST}/join/:token`);
    expect(out).not.toContain(CLAIM_TOKEN);
  });

  it("keeps deeper trip sub-paths so page-level reporting still works", () => {
    expect(normalizeSecretPath(`${HOST}/t/${TRIP_ID}/day/3`)).toBe(`${HOST}/t/:token/day/3`);
    expect(normalizeSecretPath(`${HOST}/t/${TRIP_ID}/booklet`)).toBe(`${HOST}/t/:token/booklet`);
  });

  it("drops the query string and fragment (both can carry secrets)", () => {
    const out = normalizeSecretPath(`${HOST}/t/${TRIP_ID}?token=leak&kiseki_e2e=1#s-2`);
    expect(out).toBe(`${HOST}/t/:token`);
    expect(out).not.toContain("leak");
    expect(out).not.toContain("kiseki_e2e");
  });

  it("PRESERVES the input shape — a bare path stays a bare path", () => {
    // $pathname is a path to PostHog; an absolute URL there corrupts its
    // path breakdown, so the normalizer must not upgrade a path to a URL.
    expect(normalizeSecretPath(`/t/${TRIP_ID}/itinerary`)).toBe("/t/:token/itinerary");
    expect(normalizeSecretPath(`/join/${CLAIM_TOKEN}`)).toBe("/join/:token");
  });

  it("leaves non-trip paths intact", () => {
    expect(normalizeSecretPath(`${HOST}/`)).toBe(`${HOST}/`);
    expect(normalizeSecretPath(`${HOST}/api/health`)).toBe(`${HOST}/api/health`);
    expect(normalizeSecretPath("/itinerary")).toBe("/itinerary");
  });

  it("does not mangle a string that cannot be parsed as a URL", () => {
    expect(normalizeSecretPath("http://[")).toBe("http://[");
  });

  it("resolves relative URLs against the supplied origin", () => {
    expect(normalizeSecretPath(`/t/${TRIP_ID}`, HOST)).toBe("/t/:token");
  });
});

describe("scrubSecretTokens (the before_send hook body)", () => {
  it("scrubs every URL-bearing default property", () => {
    const event = {
      uuid: "e-1",
      event: "$pageview",
      properties: {
        $current_url: `${HOST}/t/${TRIP_ID}/itinerary`,
        $referrer: `${HOST}/join/${CLAIM_TOKEN}`,
        $entry_url: `${HOST}/t/${TRIP_ID}`,
        $exit_url: `${HOST}/t/${TRIP_ID}/practical`,
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

  it("scrubs $pathname — the property a key-list guard misses (regression)", () => {
    const event = {
      uuid: "e-path",
      event: "$pageview",
      properties: {
        $current_url: `${HOST}/t/:token/itinerary`,
        $pathname: `/t/${TRIP_ID}/itinerary`,
      },
    };
    const out = scrubSecretTokens(event);
    const props = out.properties as Record<string, unknown>;
    expect(props.$pathname).toBe("/t/:token/itinerary");
    expect(JSON.stringify(out)).not.toContain(TRIP_ID);
  });

  it("scrubs $set_once initial_* values (regression)", () => {
    const event = {
      uuid: "e-init",
      event: "$pageview",
      properties: { $current_url: `${HOST}/join/:token` },
      $set_once: {
        $initial_current_url: `${HOST}/join/${CLAIM_TOKEN}`,
        $initial_pathname: `/join/${CLAIM_TOKEN}`,
        $initial_referrer: `${HOST}/t/${TRIP_ID}`,
        $initial_host: "kiseki.konnektr.io",
      },
    };
    const out = scrubSecretTokens(event);
    const setOnce = out.$set_once as Record<string, unknown>;
    expect(setOnce.$initial_current_url).toBe(`${HOST}/join/:token`);
    expect(setOnce.$initial_pathname).toBe("/join/:token");
    expect(setOnce.$initial_referrer).toBe(`${HOST}/t/:token`);
    expect(setOnce.$initial_host).toBe("kiseki.konnektr.io");
    expect(JSON.stringify(out)).not.toContain(CLAIM_TOKEN);
    expect(JSON.stringify(out)).not.toContain(TRIP_ID);
  });

  it("scrubs $set person properties too", () => {
    const event = {
      uuid: "e-set",
      event: "$set",
      properties: {},
      $set: { $current_url: `${HOST}/t/${TRIP_ID}`, plan: "pro" },
    };
    const out = scrubSecretTokens(event);
    expect((out.$set as Record<string, unknown>).$current_url).toBe(`${HOST}/t/:token`);
    expect((out.$set as Record<string, unknown>).plan).toBe("pro");
  });

  it("scrubs an UNKNOWN url-bearing key — no key list to fall behind", () => {
    const event = {
      uuid: "e-unknown",
      event: "custom",
      properties: { some_future_url_prop: `${HOST}/t/${TRIP_ID}/day/2` },
    };
    const out = scrubSecretTokens(event);
    expect((out.properties as Record<string, unknown>).some_future_url_prop).toBe(
      `${HOST}/t/:token/day/2`,
    );
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
      properties: { $current_url: `${HOST}/t/${TRIP_ID}`, completed: true },
      $set: { plan: "pro" },
    };
    const out = scrubSecretTokens(event);
    expect(out.uuid).toBe("e-3");
    expect(out.event).toBe("trip_todo_item_toggled");
    expect(out.$set).toEqual({ plan: "pro" });
    expect((out.properties as Record<string, unknown>).completed).toBe(true);
  });

  it("leaves the project token and non-URL fields alone", () => {
    const event = {
      uuid: "e-token",
      event: "$pageview",
      properties: {
        token: "phc_o83DzE5ak6qkeJiz7DqrstuZHtMvoVZ82px5fiDPfrKx",
        $host: "kiseki.konnektr.io",
        $device_type: "Desktop",
      },
    };
    const out = scrubSecretTokens(event);
    const props = out.properties as Record<string, unknown>;
    expect(props.token).toBe("phc_o83DzE5ak6qkeJiz7DqrstuZHtMvoVZ82px5fiDPfrKx");
    expect(props.$host).toBe("kiseki.konnektr.io");
    expect(props.$device_type).toBe("Desktop");
  });

  it("preserves the trip id when it is sent as a property, not a path (#21)", () => {
    // Per-trip metrics are keyed on the opaque trip id property — that is the
    // sanctioned way to segment by trip, and it must survive scrubbing.
    const event = {
      uuid: "e-4",
      event: "$pageview",
      properties: {
        $current_url: `${HOST}/t/${TRIP_ID}/itinerary`,
        $pathname: `/t/${TRIP_ID}/itinerary`,
        trip_id: TRIP_ID,
      },
    };
    const out = scrubSecretTokens(event);
    const props = out.properties as Record<string, unknown>;
    expect(props.trip_id).toBe(TRIP_ID);
    expect(props.$current_url).toBe(`${HOST}/t/:token/itinerary`);
    expect(props.$pathname).toBe("/t/:token/itinerary");
  });
});

describe("containsRawSecretPath (the test's own tripwire, sanity-checked)", () => {
  it("detects a raw secret path", () => {
    expect(containsRawSecretPath(`${HOST}/t/${TRIP_ID}`)).toBe(true);
    expect(containsRawSecretPath(`/join/${CLAIM_TOKEN}`)).toBe(true);
    expect(containsRawSecretPath(`/t/${TRIP_ID}/day/0`)).toBe(true);
  });

  it("accepts a normalized path and unrelated values", () => {
    expect(containsRawSecretPath(`${HOST}/t/:token`)).toBe(false);
    expect(containsRawSecretPath("/join/:token")).toBe(false);
    expect(containsRawSecretPath(`${HOST}/itinerary`)).toBe(false);
    expect(containsRawSecretPath("phc_o83DzE5ak6qkeJiz7DqrstuZHtMvoVZ82px5fiDPfrKx")).toBe(false);
    expect(containsRawSecretPath(42)).toBe(false);
    expect(containsRawSecretPath(null)).toBe(false);
  });
});
