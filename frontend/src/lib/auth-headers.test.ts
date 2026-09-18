// @vitest-environment jsdom
/**
 * The credential header seam (issue #324).
 *
 * One helper builds the credential header for every API call, so an injected
 * admin API key (`window.__KISEKI_API_KEY__`) can drive a fully authorized
 * browser-probe session without minting an Auth0 M2M token. The rules that
 * matter: key wins, key alone (bearer-first on the server would 401 a
 * placeholder token), and no token → no Authorization header at all (a bare
 * "Bearer " is a malformed credential, not an anonymous request).
 */
import { describe, expect, it, afterEach } from "vitest";

import { authHeaders } from "./auth-headers";

afterEach(() => {
  delete window.__KISEKI_API_KEY__;
});

describe("authHeaders", () => {
  it("uses the bearer token when no key is injected", () => {
    expect(authHeaders("tok123")).toEqual({ Authorization: "Bearer tok123" });
  });

  it("prefers an injected admin API key over the token", () => {
    window.__KISEKI_API_KEY__ = "ksk_probe";
    expect(authHeaders("tok123")).toEqual({ "X-API-Key": "ksk_probe" });
  });

  it("never sends both credentials when a key is injected", () => {
    window.__KISEKI_API_KEY__ = "ksk_probe";
    const headers = authHeaders("tok123");
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).toEqual(["X-API-Key"]);
  });

  it("works with no token at all when a key is injected", () => {
    window.__KISEKI_API_KEY__ = "ksk_probe";
    expect(authHeaders()).toEqual({ "X-API-Key": "ksk_probe" });
  });

  it("sends nothing when neither credential exists", () => {
    expect(authHeaders()).toEqual({});
    expect(authHeaders("")).toEqual({});
  });

  it("treats an empty injected key as absent", () => {
    window.__KISEKI_API_KEY__ = "";
    expect(authHeaders("tok123")).toEqual({ Authorization: "Bearer tok123" });
  });
});
