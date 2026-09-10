/**
 * Session-expired error classification (#session-expiry).
 *
 * The Auth0 SDK rejects token renewal with `GenericError` subclasses whose
 * code lives on `.error` (`missing_refresh_token`, `login_required`,
 * `invalid_grant`, …). Those mean the stored session can never be resumed
 * silently — no Retry will fix them, the user must sign in again. Everything
 * else (network errors, timeouts, API failures) is transient. The landing
 * page routes the former to its "Sign in again" CTA and the latter to a real
 * Retry, so the classifier has to get the boundary right.
 */

import { describe, expect, it } from "vitest";

import { isE2EQuery, isSessionExpiredError } from "./auth";

describe("isE2EQuery (browser-probe auth mode)", () => {
  it("is false without the kiseki_e2e param", () => {
    expect(isE2EQuery("")).toBe(false);
    expect(isE2EQuery("?trip=abc")).toBe(false);
    expect(isE2EQuery("?e2e=1")).toBe(false); // different param name
  });

  it("is true when kiseki_e2e is present (any value)", () => {
    expect(isE2EQuery("?kiseki_e2e")).toBe(true); // valueless counts as present
    expect(isE2EQuery("?kiseki_e2e=1")).toBe(true);
    expect(isE2EQuery("?trip=abc&kiseki_e2e=token&x=1")).toBe(true);
  });
});

describe("isSessionExpiredError", () => {
  it("classifies missing_refresh_token (expired refresh token)", () => {
    const err = new Error(
      "Missing Refresh Token (audience: 'https://kiseki.konnektr.io', scope: 'openid profile email offline_access')",
    ) as Error & { error?: string };
    err.error = "missing_refresh_token";
    expect(isSessionExpiredError(err)).toBe(true);
  });

  it("classifies login_required (silent iframe found no SSO session)", () => {
    expect(
      isSessionExpiredError({
        error: "login_required",
        error_description: "Login required",
      }),
    ).toBe(true);
  });

  it("classifies invalid_grant (refresh token rejected by the token endpoint)", () => {
    expect(
      isSessionExpiredError({
        error: "invalid_grant",
        error_description: "The refresh token is expired",
      }),
    ).toBe(true);
  });

  it("leaves transient failures alone", () => {
    // Plain network error: no `.error` code at all.
    expect(isSessionExpiredError(new TypeError("Failed to fetch"))).toBe(false);
    // SDK timeout carries a non-session code.
    expect(
      isSessionExpiredError({ error: "timeout", error_description: "Timeout" }),
    ).toBe(false);
    // Server-side API failures surfaced by fetchTrip are not auth errors.
    expect(isSessionExpiredError(null)).toBe(false);
    expect(isSessionExpiredError("login_required")).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
  });
});

describe("isE2EQuery (browser-probe auth mode)", () => {
  it("returns false when the e2e param is absent", () => {
    expect(isE2EQuery("")).toBe(false);
    expect(isE2EQuery("?trip=abc&kiseki=1")).toBe(false);
  });
  it("returns true only for kiseki_e2e=1 or a bare flag", () => {
    expect(isE2EQuery("?kiseki_e2e=1")).toBe(true);
    expect(isE2EQuery("?kiseki_e2e")).toBe(true);
    expect(isE2EQuery("/t/abc/itinerary?kiseki_e2e=1&draft=1")).toBe(true);
  });
  it("ignores other values of the param", () => {
    expect(isE2EQuery("?kiseki_e2e=0")).toBe(false);
    expect(isE2EQuery("?kiseki_e2e=anything-else")).toBe(true);
    expect(isE2EQuery("?not_kiseki_e2e=1")).toBe(false);
  });
});
