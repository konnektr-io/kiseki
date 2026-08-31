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

/** True when both values are set — the app can actually authenticate. */
export const isAuthConfigured = () => Boolean(AUTH0_DOMAIN && AUTH0_CLIENT_ID);
