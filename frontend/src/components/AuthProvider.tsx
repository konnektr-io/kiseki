import {
  Auth0Context,
  Auth0Provider,
  initialContext,
  useAuth0,
} from "@auth0/auth0-react";
import type { Auth0ContextInterface, User } from "@auth0/auth0-react";
import { createElement, useEffect, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  AUTH0_AUDIENCE,
  AUTH0_CLIENT_ID,
  AUTH0_DOMAIN,
  isAuthConfigured,
  isE2EQuery,
} from "../lib/auth";
import { identifyUser, isPostHogConfigured, posthog } from "../lib/posthog";

interface AuthProviderProps {
  children: ReactNode;
}

function PostHogIdentity({ children }: AuthProviderProps) {
  const { isAuthenticated, user } = useAuth0();
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    // Identity key is the Auth0 `sub` — never name/email (self-asserted claims
    // are not credentials, same rule as the backend ACL). Name is attached as a
    // person property for readability only.
    const distinctId = user?.sub;
    if (!isPostHogConfigured || !isAuthenticated || !distinctId) return;

    // A different user on the same browser must not be merged into the previous
    // one's profile — reset first, then identify.
    if (identifiedUserId.current && identifiedUserId.current !== distinctId) {
      posthog.reset();
    }

    identifyUser(distinctId, { name: user.name });
    identifiedUserId.current = distinctId;
  }, [isAuthenticated, user?.name, user?.sub]);

  return <>{children}</>;
}

/**
 * Root auth provider.
 *
 * - Configured: wraps the app in `Auth0Provider` (Authorization Code + PKCE,
 *   refresh-token rotation, session persisted in localStorage so reloads
 *   keep the session without silent-iframe renewal).
 * - `useRefreshTokensFallback`: when the cached refresh token is missing or
 *   has been rejected (expired / rotation chain revoked — a returning user
 *   after an idle gap), the SDK first tries the silent `prompt=none` iframe
 *   against the Auth0 session before failing. If that session is also gone
 *   the SDK clears the dead local session and reports `login_required`, so
 *   the app degrades to the signed-out state instead of dead-ending on
 *   "Missing Refresh Token" (callers still route that to a sign-in CTA).
 * - Not configured: renders children as-is — the anonymous, secret-link
 *   experience keeps working with zero auth surface.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const navigate = useNavigate();

  // E2E browser-probe mode (?kiseki_e2e=1 — automated tests only): stub the
  // Auth0 context as signed-in and hand the injected access token
  // (window.__KISEKI_ACCESS_TOKEN__, the same seam the PDF renderer uses) to
  // every API call. No Auth0 session, no cache seeding. The backend still
  // enforces each request against the presented token.
  if (typeof window !== "undefined" && isE2EQuery(window.location.search)) {
    const token = window.__KISEKI_ACCESS_TOKEN__ ?? "";
    const user: User = {
      sub: "e2e-probe",
      name: "E2E probe",
      email: "e2e@kiseki.invalid",
    };
    // Cast: the stub's getAccessTokenSilently is a plain (async () => token)
    // arrow; the SDK's overloaded signature (detailedResponse variant) can't
    // structurally match it, which is fine — no consumer uses verbose mode.
    const e2eContext = {
      ...initialContext,
      isAuthenticated: true,
      isLoading: false,
      error: undefined,
      user,
      getAccessTokenSilently: async () => token,
      getAccessTokenWithPopup: async () => token,
      loginWithRedirect: async () => {},
      loginWithPopup: async () => {},
      logout: async () => {},
    } as unknown as Auth0ContextInterface;
    return createElement(
      Auth0Context.Provider,
      { value: e2eContext },
      <PostHogIdentity>{children}</PostHogIdentity>,
    );
  }

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
      useRefreshTokensFallback
      cacheLocation="localstorage"
      onRedirectCallback={onRedirectCallback}
    >
      <PostHogIdentity>{children}</PostHogIdentity>
    </Auth0Provider>
  );
}
