import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { UserCheck } from "lucide-react";
import { claimIdentity, fetchTripByClaim, fetchTripByFollow, followTrip, TripAccessError } from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { usePageTitle } from "../lib/seo";
import type { Trip } from "../lib/types";
import { AppHeader } from "../components/AppHeader";
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
  // #197: the URL param is a link credential of either kind. The crew invite
  // (claim token) wins when it resolves; a follow link is the fallback. The
  // two are separate secrets server-side, so which one we hold decides what
  // this page may offer — a follow link can NEVER claim.
  const [linkKind, setLinkKind] = useState<"claim" | "follow">("claim");

  usePageTitle(trip ? `${trip.title} — ${linkKind === "follow" ? "follow" : "join"}` : null);

  useEffect(() => {
    let cancelled = false;
    setTrip(null);
    setError(null);
    setLinkKind("claim");
    fetchTripByClaim(claimToken)
      .then((t) => {
        if (!cancelled) setTrip(t);
      })
      .catch(() =>
        // Not a join link — try the follow link (#197): same page, but
        // nothing here is claimable, so no crew list and no "This is me".
        fetchTripByFollow(claimToken)
          .then((t) => {
            if (!cancelled) {
              setLinkKind("follow");
              setTrip(t);
            }
          })
          .catch((e: unknown) => {
            if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load trip");
          }),
      );
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
      const followed = await followTrip(claimToken, at, linkKind);
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
    <TripProvider trip={trip} apply={() => undefined}>
      <div style={tripStyle(trip)} className="min-h-full">
        <AppHeader
          home={{ to: "/", label: "Home" }}
          title={trip.title}
          badge={<StageBadge stage={trip.stage} />}
          subtitle={trip.subtitle}
        />

        <main className="mx-auto max-w-3xl px-4 py-8">
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="mb-1 flex items-center gap-2 text-primary">
              <UserCheck className="h-5 w-5" />
              <h2 className="font-heading text-xl font-semibold">
                {linkKind === "follow" ? "Follow this trip" : "You're invited"}
              </h2>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {linkKind === "follow"
                ? "This link lets you follow the trip — you'll get read access to it. It is not a crew invitation, so there is no identity to claim here."
                : "This link is your crew invitation. Sign in and claim your identity to join the trip — the read-only share link can't do this."}
            </p>

            {linkKind === "follow" ? (
              !isAuthenticated && !authLoading ? (
                <Button
                  onClick={() =>
                    loginWithRedirect({
                      appState: { returnTo: window.location.pathname },
                    })
                  }
                >
                  Sign in to follow
                </Button>
              ) : (
                <Button onClick={handleFollow} disabled={following}>
                  {following ? "Following…" : "Follow this trip"}
                </Button>
              )
            ) : !isAuthenticated && !authLoading ? (
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
                      {person.claimed === true ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled
                          aria-label={`Already joined — ${person.name} is linked to an account`}
                          className="shrink-0 bg-transparent"
                        >
                          Already joined
                        </Button>
                      ) : (
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
                      )}
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
