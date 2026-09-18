/**
 * Credential headers for one API call — the SINGLE source of truth (#324).
 *
 * An injected admin API key (`window.__KISEKI_API_KEY__`) wins over the
 * bearer token, and when it does the request carries ONLY the key: the
 * backend validates a present `Authorization` header first (bearer-first is
 * deliberate — it is the end-user path), so sending a placeholder bearer
 * alongside a key would 401 instead of authenticating. An API key MUST
 * always impersonate a user, so an injected act-as sub
 * (`window.__KISEKI_ACT_AS_SUB__`) rides as `X-Act-As-Sub` with it; that is
 * the identity the backend forwards to the graph as `x-user-id`.
 *
 * The seam exists for browser probes: Playwright sets the globals with
 * `add_init_script` (see `backend/scripts/probe_trip_page.py`), which drives a
 * fully authorized, signed-in session without minting an Auth0 M2M token —
 * Auth0 meters every client_credentials grant against a monthly quota. The
 * app itself never sets these globals.
 */
export function authHeaders(accessToken?: string): Record<string, string> {
  const key = typeof window === "undefined" ? undefined : window.__KISEKI_API_KEY__;
  if (key) {
    const actAs = typeof window === "undefined" ? undefined : window.__KISEKI_ACT_AS_SUB__;
    return actAs ? { "X-API-Key": key, "X-Act-As-Sub": actAs } : { "X-API-Key": key };
  }
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

/**
 * Whether this session presents ANY credential (a bearer token or an injected
 * admin key). The trip cache keys its copies on this rather than on the token
 * alone, so a key-authenticated read is never served as the anonymous copy
 * (nor the reverse): an anonymous `GET /api/trips/{id}` comes back WITHOUT
 * `myRole`, and handing that to a credentialled view hides the editor chrome.
 */
export function hasCredential(accessToken?: string): boolean {
  const key = typeof window === "undefined" ? undefined : window.__KISEKI_API_KEY__;
  return Boolean(accessToken) || Boolean(key);
}
