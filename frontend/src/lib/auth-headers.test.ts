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
  delete window.__KISEKI_ACT_AS_SUB__;
});

describe("authHeaders", () => {
  it("uses the bearer token when no key is injected", () => {
    expect(authHeaders("tok123")).toEqual({ Authorization: "Bearer tok123" });
  });

  it("prefers an injected admin API key over the token", () => {
    window.__KISEKI_API_KEY__ = "ksk_probe";
    window.__KISEKI_ACT_AS_SUB__ = "google-oauth2|probe-user";
    expect(authHeaders("tok123")).toEqual({
      "X-API-Key": "ksk_probe",
      "X-Act-As-Sub": "google-oauth2|probe-user",
    });
  });

  it("never sends both credentials when a key is injected", () => {
    window.__KISEKI_API_KEY__ = "ksk_probe";
    window.__KISEKI_ACT_AS_SUB__ = "google-oauth2|probe-user";
    const headers = authHeaders("tok123");
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers).sort()).toEqual(["X-API-Key", "X-Act-As-Sub"]);
  });

  it("works with no token at all when a key is injected", () => {
    window.__KISEKI_API_KEY__ = "ksk_probe";
    window.__KISEKI_ACT_AS_SUB__ = "google-oauth2|probe-user";
    expect(authHeaders()).toEqual({
      "X-API-Key": "ksk_probe",
      "X-Act-As-Sub": "google-oauth2|probe-user",
    });
  });

  it("sends the key alone when no act-as sub is injected", () => {
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
