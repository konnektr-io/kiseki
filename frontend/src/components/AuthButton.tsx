import { useAuth0 } from "@auth0/auth0-react";
import { Link } from "react-router-dom";
import { LogIn, LogOut } from "lucide-react";
import { isAuthConfigured } from "../lib/auth";
import { resetIdentity } from "../lib/posthog";
import { Button } from "./ui";

/**
 * Sign in / sign out chip. Renders nothing when Auth0 is not configured
 * (anonymous, secret-link mode) — the auth surface only appears when the
 * app can actually authenticate.
 */
export function AuthButton() {
  if (!isAuthConfigured()) return null;
  return <AuthButtonInner />;
}

/** "Niko Raes" → "NR"; falls back to the first two characters of the name. */
function initialsFor(user: {
  given_name?: string;
  family_name?: string;
  name?: string;
}): string {
  const given = user.given_name || user.name?.split(/\s+/)[0] || "";
  const family =
    user.family_name || user.name?.split(/\s+/).slice(1).join(" ") || "";
  if (given && family) {
    return (given[0] + family[0]).toUpperCase();
  }
  const name = user.name || given || "";
  return name.slice(0, 2).toUpperCase();
}

function AuthButtonInner() {
  const { isLoading, isAuthenticated, user, loginWithRedirect, logout } =
    useAuth0();

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => loginWithRedirect()}
        className="bg-background/80"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </Button>
    );
  }

  const name = user?.name || user?.email || "Account";

  return (
    <div className="flex items-center gap-2">
      {/* The signed-in user's entry point to their own profile (#196d). */}
      <Link
        to="/me"
        aria-label="Your profile"
        title={name}
        className="shrink-0 rounded-full focus-visible:focus-ring"
      >
        {user?.picture ? (
          <img
            src={user.picture}
            alt={name}
            referrerPolicy="no-referrer"
            className="h-8 w-8 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
          >
            {initialsFor(user ?? {})}
          </span>
        )}
      </Link>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          resetIdentity();
          logout({ logoutParams: { returnTo: window.location.origin } });
        }}
        className="bg-background/80"
        title={`Sign out (${name})`}
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </Button>
    </div>
  );
}
