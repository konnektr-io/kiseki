import { Auth0Provider } from "@auth0/auth0-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  AUTH0_AUDIENCE,
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
  const navigate = useNavigate();

  if (!isAuthConfigured()) {
    return <>{children}</>;
  }

  const onRedirectCallback = (appState?: { returnTo?: string }) => {
    // Actually NAVIGATE to the pre-login page: replaceState alone changes the
    // URL bar but not the router, so the user would see the landing page
    // until a refresh re-reads the URL.
    navigate(appState?.returnTo || window.location.pathname, { replace: true });
  };

  return (
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        scope: "openid profile email offline_access",
        audience: AUTH0_AUDIENCE,
      }}
      useRefreshTokens
      cacheLocation="localstorage"
      onRedirectCallback={onRedirectCallback}
    >
      {children}
    </Auth0Provider>
  );
}
