import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { ArrowLeft, UserCheck } from "lucide-react";
import { claimIdentity, fetchTripByClaim, followTrip, TripAccessError } from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { usePageTitle } from "../lib/seo";
import type { Trip } from "../lib/types";
import { TripProvider, tripStyle } from "../components/theme";
import { Button, StageBadge } from "../components/ui";

/**
 * Join page (issue #6): the destination of a trip's CLAIM token — the invite.
 * Shows the trip + crew and lets a signed-in user claim their crew identity
 * ("This is me"). The claim token is a separate secret from the read link:
 * the read link alone can never grant an identity.
 */
export function JoinPage() {
  const { claimToken = "" } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading, getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);

  usePageTitle(trip ? `${trip.title} — join` : null);

  useEffect(() => {
    let cancelled = false;
    setTrip(null);
    setError(null);
    fetchTripByClaim(claimToken)
      .then((t) => {
        if (!cancelled) setTrip(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load trip");
      });
    return () => {
      cancelled = true;
    };
  }, [claimToken]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-2xl font-bold">Kiseki</h1>
        <p className="text-muted-foreground">
          This join link is unknown or has been revoked.
        </p>
        <Link to="/" className="text-sm font-medium underline underline-offset-2">
          Home
        </Link>
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-muted-foreground" role="status">
          Loading…
        </p>
      </div>
    );
  }

  const crew = trip.crew ?? [];

  const handleClaim = async (personId: string) => {
    setClaiming(personId);
    setClaimError(null);
    try {
      const at = await getAccessTokenSilently();
      const claimed = await claimIdentity(claimToken, personId, at);
      // The protected id route now resolves (the User twin holds the role).
      navigate(`/t/${claimed.id}`, { replace: true });
    } catch (e) {
      // A session that can no longer be renewed (expired/revoked refresh
      // token — the #77 dead end) must not surface as raw SDK text: claiming
      // needs a live token, so send the user to sign in. returnTo puts them
      // back on this exact join link after the round trip.
      if (isSessionExpiredError(e)) {
        setClaiming(null);
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      if (e instanceof TripAccessError && e.status === 409) {
        setClaimError("That crew identity is already linked to another account.");
      } else {
        setClaimError(e instanceof Error ? e.message : "Claim failed");
      }
      setClaiming(null);
    }
  };

  const handleFollow = async () => {
    setFollowing(true);
    setClaimError(null);
    try {
      const at = await getAccessTokenSilently();
      const followed = await followTrip(claimToken, at);
      navigate(`/t/${followed.id}`, { replace: true });
    } catch (e) {
      // Same dead-session rule as claiming: sign in again, land back here.
      if (isSessionExpiredError(e)) {
        setFollowing(false);
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      setClaimError(e instanceof Error ? e.message : "Follow failed");
      setFollowing(false);
    }
  };

  return (
    <TripProvider trip={trip}>
      <div style={tripStyle(trip)} className="min-h-full">
        <header className="no-print sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
            <Link
              to="/"
              title="Home"
              aria-label="Home"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-lg font-bold leading-tight">{trip.title}</h1>
                <StageBadge stage={trip.stage} />
              </div>
              {trip.subtitle && (
                <p className="truncate text-xs text-muted-foreground">{trip.subtitle}</p>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-3xl px-4 py-8">
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="mb-1 flex items-center gap-2 text-primary">
              <UserCheck className="h-5 w-5" />
              <h2 className="font-heading text-xl font-semibold">You're invited</h2>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              This link is your crew invitation. Sign in and claim your identity to join the
              trip — the read-only share link can't do this.
            </p>

            {!isAuthenticated && !authLoading ? (
              <Button
                onClick={() =>
                  loginWithRedirect({
                    appState: { returnTo: window.location.pathname },
                  })
                }
              >
                Sign in to claim your identity
              </Button>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {crew.map((person) => (
                    <li
                      key={person.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{person.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {person.role}
                          {person.note ? ` — ${person.note}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleClaim(person.id)}
                        disabled={claiming !== null || following}
                        aria-label={`Claim the crew identity ${person.name}`}
                        className="shrink-0 bg-transparent"
                      >
                        {claiming === person.id ? "Claiming…" : "This is me"}
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 border-t border-border pt-6">
                  <p className="mb-3 text-sm text-muted-foreground">
                    Not on the crew list? Follow this trip instead — you'll get
                    read access as a follower.
                  </p>
                  <Button
                    variant="outline"
                    onClick={handleFollow}
                    disabled={claiming !== null || following}
                  >
                    {following ? "Following…" : "Follow this trip"}
                  </Button>
                </div>
              </>
            )}
            {claimError && (
              <p
                role="alert"
                className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
              >
                {claimError}
              </p>
            )}
          </div>
        </main>
      </div>
    </TripProvider>
  );
}
