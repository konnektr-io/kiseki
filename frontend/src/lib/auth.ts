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
