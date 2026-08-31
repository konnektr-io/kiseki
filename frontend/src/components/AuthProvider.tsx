import { Auth0Provider } from "@auth0/auth0-react";
import type { ReactNode } from "react";
import {
  AUTH0_CLIENT_ID,
  AUTH0_DOMAIN,
  isAuthConfigured,
} from "../lib/auth";

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Root auth provider.
 *
 * - Configured: wraps the app in `Auth0Provider` (Authorization Code + PKCE,
 *   refresh-token rotation, session persisted in localStorage so reloads
 *   keep the session without silent-iframe renewal).
 * - Not configured: renders children as-is — the anonymous, secret-link
 *   experience keeps working with zero auth surface.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  if (!isAuthConfigured()) {
    return <>{children}</>;
  }

  const onRedirectCallback = (appState?: { returnTo?: string }) => {
    // Strip the ?code=&state= callback params from the URL after login.
    window.history.replaceState(
      {},
      document.title,
      appState?.returnTo || window.location.pathname,
    );
  };

  return (
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        scope: "openid profile email offline_access",
      }}
      useRefreshTokens
      cacheLocation="localstorage"
      onRedirectCallback={onRedirectCallback}
    >
      {children}
    </Auth0Provider>
  );
}
