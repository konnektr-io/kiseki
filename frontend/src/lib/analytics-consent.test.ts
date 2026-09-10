import { describe, expect, it, vi } from "vitest";
import { CONSENT_COOKIE, consentCookieValue, parseConsent } from "./analytics-consent";

/**
 * Issue #21 + Niko's banner follow-up: analytics is OPT-IN. The banner writes
 * the visitor's choice here, and `lib/posthog.ts` initializes the SDK only on
 * "granted". These tests pin the storage contract; the rendered-browser probe
 * (`scripts/probe-analytics-privacy.py`) asserts the live consequence: zero
 * requests reach PostHog before a choice, full scrubbed events after.
 */
describe("analytics-consent", () => {
  it("reads the choice back from a cookie header", () => {
    expect(parseConsent("kiseki_consent=granted")).toBe("granted");
    expect(parseConsent("kiseki_consent=denied")).toBe("denied");
    expect(parseConsent("other=1; kiseki_consent=granted; x=2")).toBe("granted");
    expect(parseConsent("KISEKI_CONSENT=granted")).toBeNull(); // name is case-sensitive
  });

  it("treats garbage or missing values as undecided", () => {
    expect(parseConsent("")).toBeNull();
    expect(parseConsent("kiseki_consent=")).toBeNull();
    expect(parseConsent("kiseki_consent=yes")).toBeNull();
    expect(parseConsent("foo; bar")).toBeNull();
  });

  it("uses a dedicated cookie name (never the generic shared one)", () => {
    expect(CONSENT_COOKIE).toBe("kiseki_consent");
    expect(CONSENT_COOKIE).not.toBe("cookieConsent"); // graph-explorer's name
  });

  it("serializes a year-long, path-scoped, SameSite=Lax cookie", () => {
    const cookie = consentCookieValue("granted");
    expect(cookie).toContain("kiseki_consent=granted");
    expect(cookie).toContain("max-age=");
    expect(cookie).toContain("path=/");
    expect(cookie).toContain("SameSite=Lax");
    const maxAge = Number(cookie.match(/max-age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(60 * 60 * 24 * 300); // ~a year, not a session
  });

  describe("in-memory fallback", () => {
    // `initAnalytics` refuses to start without a granted choice, so if a
    // storage-blocked visitor's click were not remembered, "Allow analytics"
    // would silently do nothing. The repo runs vitest in the `node`
    // environment, where there is no `document` at all — which IS the
    // storage-blocked case, so no DOM stubbing is needed here.
    it("remembers this page load's choice when storage is unavailable", async () => {
      vi.resetModules(); // fresh module state, independent of test order
      const mod = await import("./analytics-consent");

      expect(mod.currentConsent()).toBeNull();
      expect(() => mod.storeConsent("granted")).not.toThrow();
      expect(mod.currentConsent()).toBe("granted");
    });
  });
});
