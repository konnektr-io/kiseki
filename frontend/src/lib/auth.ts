/**
 * Auth0 SPA configuration.
 *
 * Domain and client ID are public by nature (they ship in the browser bundle),
 * so they are baked in as defaults — the single source of truth for the Kiseki
 * Auth0 app. `VITE_AUTH0_*` overrides exist for local dev against another
 * tenant. No secrets live here (SPA apps authenticate with PKCE, no secret).
 */
export const AUTH0_DOMAIN =
  import.meta.env.VITE_AUTH0_DOMAIN ?? "dev-zv5urb33g0msy7bc.eu.auth0.com";

export const AUTH0_CLIENT_ID =
  import.meta.env.VITE_AUTH0_CLIENT_ID ?? "jbMyX3scNHkECOF1lNJTOovXe8fOBmiq";

/**
 * Audience (Auth0 API identifier). REQUIRED, and it must match an API created
 * in the tenant: Auth0 issues JWE-ENCRYPTED access tokens (alg: dir) to SPA
 * clients when no audience is requested — such tokens cannot be verified by
 * the backend. With an audience, tokens come back as plain RS256 JWTs.
 * Keep in sync with the API identifier in the Auth0 dashboard AND with
 * AUTH0_AUDIENCE in backend/app/config.py.
 */
export const AUTH0_AUDIENCE =
  import.meta.env.VITE_AUTH0_AUDIENCE ?? "https://kiseki.konnektr.io";

/** True when both values are set — the app can actually authenticate. */
export const isAuthConfigured = () => Boolean(AUTH0_DOMAIN && AUTH0_CLIENT_ID);

/**
 * OAuth error codes (auth0-spa-js throws these as `GenericError` subclasses,
 * with the code on the `.error` property) that mean the STORED session can no
 * longer be resumed silently — the user must sign in again interactively:
 *
 * - `missing_refresh_token` — no usable refresh token in the cache (expired
 *   tokens are pruned from the localstorage cache; rotation chains can also be
 *   revoked server-side after reuse detection).
 * - `login_required` / `consent_required` / `interaction_required` — the
 *   silent `prompt=none` iframe found no Auth0 session to resume.
 * - `invalid_grant` — the token endpoint rejected the presented refresh token
 *   (expired, or revoked by rotation reuse detection).
 *
 * Anything else (network failures, timeouts, 5xx) is transient and worth a
 * manual retry; these are not — retrying loops forever until the user
 * re-authenticates. Distinguished here so pages can route them to a
 * "sign in again" CTA instead of showing the raw SDK message.
 */
const SESSION_EXPIRED_CODES = new Set([
  "missing_refresh_token",
  "login_required",
  "consent_required",
  "interaction_required",
  "invalid_grant",
]);

interface AuthErrorLike {
  error?: string;
}

export function isSessionExpiredError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { error } = e as AuthErrorLike;
  return typeof error === "string" && SESSION_EXPIRED_CODES.has(error);
}

/* ------------------------------------------------------------------ E2E auth
 * Browser-probe mode (issue #9 / M4 test rig): ``?kiseki_e2e=<access-token>``
 * makes the SPA behave as signed-in WITHOUT an Auth0 session — the Auth0
 * context is stubbed to report isAuthenticated and hand the token straight
 * to every API call. Same philosophy as the PDF-render bypass
 * (__KISEKI_PDF_RENDER__, backend/app/pdf.py): bypass the SDK, never seed
 * its localstorage cache (that failed for the PDF; the cache shape is
 * internal and breaks on SDK upgrades). The backend still enforces every
 * request against the presented token, so this grants nothing by itself —
 * the token must be a real access token (an M2M act-as token works: the
 * backend maps a sanctioned M2M bearer to the KISEKI_AGENT_ACT_AS pin when
 * no X-Act-As-Sub header rides along).
 */

/** True when ``window.location`` carries a ``kiseki_e2e`` query param. */
export function isE2EQuery(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("kiseki_e2e");
}
