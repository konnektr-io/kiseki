import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import type { User } from "@auth0/auth0-react";
import { Activity, ChevronDown, LogIn, LogOut, UserRound } from "lucide-react";
import { isAuthConfigured } from "../lib/auth";
import { resetIdentity } from "../lib/posthog";
import { Button } from "./ui";

/**
 * Sign in / sign out chip — the header's account surface. Renders nothing when
 * Auth0 is not configured (anonymous, secret-link mode) — the auth surface only
 * appears when the app can actually authenticate.
 *
 * Mobile-safe (#239): the three signed-in affordances (feed, profile, sign out)
 * were three separate targets in a `flex` row that was not `flex-nowrap`, which
 * is what wrapped the header at ~390px once the feed link joined the profile
 * chip (#199). Now:
 *
 * - pointer devices (`md:`): the same three affordances, one click deep, in a
 *   `flex-nowrap` row that can no longer wrap.
 * - phones: one account chip — avatar + chevron — holding profile, feed and
 *   sign out as menu rows, mirroring the trip actions menu's pattern.
 *
 * Both clusters are in the DOM; only one is displayed. Nothing queries these
 * labels in the tests, so no duplicate-match hazard.
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

/** The avatar as it appears in both clusters: photo, or initials fallback. */
function Avatar({ user, name }: { user?: User; name: string }) {
  if (user?.picture) {
    return (
      <img
        src={user.picture}
        alt={name}
        referrerPolicy="no-referrer"
        className="h-8 w-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
    >
      {initialsFor(user ?? {})}
    </span>
  );
}

/** One menu row — the trip actions menu's row geometry, reused. */
const MENU_ITEM =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:focus-ring";

function AuthButtonInner() {
  const { isLoading, isAuthenticated, user, loginWithRedirect, logout } =
    useAuth0();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape while open (the trip menu's pattern).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => loginWithRedirect()}
        className="shrink-0 bg-background/80"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </Button>
    );
  }

  const name = user?.name || user?.email || "Account";
  const signOut = () => {
    resetIdentity();
    logout({ logoutParams: { returnTo: window.location.origin } });
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* Signed-in user's feed entry point (#199) and profile entry (#196d),
          next to sign out — as before, now in a row that cannot wrap. */}
      <div className="hidden items-center gap-2 md:flex">
        <Link
          to="/feed"
          aria-label="Activity feed"
          title="Activity feed"
          className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
        >
          Feed
        </Link>
        <Link
          to="/me"
          aria-label="Your profile"
          title={name}
          className="shrink-0 rounded-full focus-visible:focus-ring"
        >
          <Avatar user={user} name={name} />
        </Link>
        <Button
          variant="outline"
          size="sm"
          onClick={signOut}
          className="bg-background/80"
          title={`Sign out (${name})`}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>

      {/* Phones: the whole account surface behind one chip. */}
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Account menu"
        title={name}
        className="flex h-11 items-center gap-1 rounded-full border border-border pl-1 pr-1.5 text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground focus-visible:focus-ring md:hidden"
      >
        <Avatar user={user} name={name} />
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-30 mt-1.5 w-56 rounded-xl border border-border bg-card p-1.5 shadow-lg"
        >
          <Link
            to="/me"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => setMenuOpen(false)}
          >
            <UserRound
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            Your profile
          </Link>
          <Link
            to="/feed"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => setMenuOpen(false)}
          >
            <Activity
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            Activity feed
          </Link>
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              setMenuOpen(false);
              signOut();
            }}
          >
            <LogOut
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
