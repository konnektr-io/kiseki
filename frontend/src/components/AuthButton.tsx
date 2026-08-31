import { useAuth0 } from "@auth0/auth0-react";
import { LogIn, LogOut } from "lucide-react";
import { isAuthConfigured } from "../lib/auth";

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
      <button
        onClick={() => loginWithRedirect()}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/80 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </button>
    );
  }

  const name = user?.name || user?.email || "Account";

  return (
    <div className="flex items-center gap-2">
      {user?.picture ? (
        <img
          src={user.picture}
          alt={name}
          referrerPolicy="no-referrer"
          className="h-8 w-8 rounded-full object-cover"
        />
      ) : (
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
          title={name}
        >
          {initialsFor(user ?? {})}
        </span>
      )}
      <button
        onClick={() =>
          logout({ logoutParams: { returnTo: window.location.origin } })
        }
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/80 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
        title={`Sign out (${name})`}
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </button>
    </div>
  );
}
