import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { ArrowRight, MapPin, MessageCircle, Ticket } from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { ChatPopup } from "../components/chat-panel";
import { Button, StageBadge } from "../components/ui";
import { fetchMyTrips } from "../lib/api";
import { formatDate } from "../lib/dates";
import { isAuthConfigured, isSessionExpiredError } from "../lib/auth";
import { usePageTitle } from "../lib/seo";
import { MarketingLanding } from "./LandingMarketing";
import type { TripSummary } from "../lib/types";

/**
 * Landing page (issue #7).
 *
 * - Signed in: "My trips" — a card grid of every trip the user has a crew
 *   role on (link straight to the protected /t/<id> routes).
 * - Signed out: the marketing landing (#249) — what Kiseki is, real public
 *   trips you can open, and the way in. It replaced a four-line centred hero
 *   ("Open your trip link to continue, or sign in") that told a stranger
 *   nothing about the product.
 *
 * The old landing logo image is gone (it drifted from the app icon); the
 * wordmark lives in `AppHeader`'s brand, where every route gets it.
 */
export function LandingPage() {
  usePageTitle(null);

  if (!isAuthConfigured()) {
    return <MarketingLanding />;
  }
  return <AuthenticatedLanding />;
}

/**
 * The landing's sign-in CTA.
 *
 * Lives here rather than in `LandingMarketing` because it is the only part of
 * that page that touches the SDK: the page takes its CTA as a node, so it
 * renders (and is tested) without an Auth0 context. Only mounted where auth is
 * actually configured — with no Auth0 app there is nothing to sign in to, and
 * `MarketingLanding` simply renders no CTA.
 */
function SignInButton() {
  const { loginWithRedirect } = useAuth0();
  return (
    <Button onClick={() => loginWithRedirect()} className="px-5">
      Sign in
    </Button>
  );
}

function TripCard({ trip }: { trip: TripSummary }) {
  const dates =
    trip.startDate && trip.endDate
      ? `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}`
      : "Dates TBD";
  return (
    <Link
      to={`/t/${trip.dtId}`}
      className="group relative block overflow-hidden rounded-xl border border-border bg-card transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-lg hover:shadow-black/30"
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        {trip.cover ? (
          <img
            src={trip.cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted">
            <MapPin className="h-8 w-8 text-muted-foreground/50" strokeWidth={1.5} />
          </div>
        )}
        <div className="scrim absolute inset-0" />
        <div className="absolute left-3 top-3">
          <StageBadge stage={trip.stage} />
        </div>
        <div className="absolute inset-x-0 bottom-0 p-4">
          <h3 className="font-heading text-xl font-semibold tracking-wide text-white drop-shadow">
            {trip.title}
          </h3>
          <p className="mt-0.5 line-clamp-1 text-xs text-white/70">{dates}</p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        {trip.subtitle ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">{trip.subtitle}</p>
        ) : (
          <span />
        )}
        {trip.role && (
          <span className="shrink-0 rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
            {trip.role}
          </span>
        )}
      </div>
    </Link>
  );
}

function TripGridSkeleton() {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="aspect-[16/10] animate-pulse rounded-xl border border-border bg-muted"
        />
      ))}
    </div>
  );
}

/**
 * A trip-list load failure. `expired` = the Auth0 session can't be resumed
 * silently (refresh token expired/revoked and no SSO session behind it) — a
 * dead end that no Retry fixes; the user must sign in again. `load` = any
 * other (usually transient) failure, worth a manual retry.
 */
type TripsError = { kind: "expired" } | { kind: "load"; message: string };

function AuthenticatedLanding() {
  const {
    isLoading: authLoading,
    isAuthenticated,
    getAccessTokenSilently,
    loginWithRedirect,
  } = useAuth0();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<TripsError | null>(null);
  // Bumped by the Retry button — the fetch effect depends on it, so a retry
  // genuinely re-runs the load (previously Retry only cleared the error and
  // the grid fell back to a skeleton that never resolved).
  const [attempt, setAttempt] = useState(0);
  // The newest trip the assistant created in this session (detected from its
  // /t/<id> links) — offered as an "Open trip" button in the chat popup while
  // the refetched grid below catches up.
  const [createdTripId, setCreatedTripId] = useState<string | null>(null);
  // Landing chat lives in the same floating popup as the in-trip chat (#9 /
  // M4 v2): a header button when the user has trips, a center button in the
  // empty state when they don't. Attachments attach to the user's inbox
  // (there is no trip yet); the agent promotes them once it creates one.
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isAuthenticated) {
      setTrips(null);
      setError(null);
      return;
    }
    setTrips(null);
    setError(null);
    getAccessTokenSilently()
      .then((at) => fetchMyTrips(at))
      .then((rows) => {
        if (!cancelled) setTrips(rows);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A stored session that can no longer be renewed is not a load
        // failure — showing "Missing Refresh Token (audience: …)" with a
        // Retry that can never succeed is the bug. Route it to the sign-in
        // CTA (sign-out + sign-in is what "fixed" it manually before).
        setError(
          isSessionExpiredError(e)
            ? { kind: "expired" }
            : { kind: "load", message: e instanceof Error ? e.message : "Failed to load trips" },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getAccessTokenSilently, attempt]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-muted-foreground" role="status">
          Loading…
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <MarketingLanding signIn={<SignInButton />} />;
  }

  return (
    <div className="min-h-screen">
      <AppHeader actions={<AuthButton />} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h2 className="font-heading text-2xl font-semibold tracking-wide">
              My trips
            </h2>
            <p className="text-sm text-muted-foreground">
              Every journey you're part of — pick one to open the booklet.
            </p>
          </div>
          {/* Landing chat launcher — top-right of the trips list (only when
              the user has trips; the empty state gets a center button below,
              so a brand-new user still finds the assistant). Opens the same
              floating popup as the in-trip chat (#9 / M4 v2). */}
          {trips && trips.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChatOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={chatOpen}
              className="shrink-0"
            >
              <MessageCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Ask Kiseki
            </Button>
          )}
        </div>

        {error ? (
          error.kind === "expired" ? (
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center"
            >
              <p className="text-sm font-medium text-destructive">
                Your session expired.
              </p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                Sign in again to reload your trips — this usually takes one
                click.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  loginWithRedirect({
                    appState: { returnTo: window.location.pathname },
                  })
                }
                className="mt-3 text-xs"
              >
                Sign in again
              </Button>
            </div>
          ) : (
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center"
            >
              <p className="text-sm font-medium text-destructive">
                {error.message}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAttempt((n) => n + 1)}
                className="mt-3 text-xs"
              >
                Retry
              </Button>
            </div>
          )
        ) : trips === null ? (
          <TripGridSkeleton />
        ) : trips.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <Ticket className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" strokeWidth={1.5} />
            <h3 className="font-heading text-lg font-semibold">No trips yet</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Plan your first journey with the Kiseki assistant — describe the
              trip you have in mind and it will build the booklet for you. Or
              ask a trip owner for their join link to hop onto an existing one.
            </p>
            <Button
              onClick={() => setChatOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={chatOpen}
              className="mt-5"
            >
              <MessageCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Plan a trip
            </Button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {trips.map((trip) => (
              <TripCard key={trip.dtId} trip={trip} />
            ))}
          </div>
        )}

        {/* Landing chat popup (issue #9 / M4 v2): the same floating drawer as
            the in-trip chat, opened by the header / empty-state launchers
            above. No tripId — the assistant answers questions about the
            user's trips or creates a new one; uploads stage in the user's
            inbox until the agent promotes them into the new trip. A fresh
            trip surfaces as an "Open trip" banner while the grid refetches. */}
        {chatOpen && (
          <ChatPopup
            onClose={() => setChatOpen(false)}
            onTripCreated={(id) => {
              setCreatedTripId(id);
              // The new trip exists now — refetch so its card appears above.
              setAttempt((n) => n + 1);
            }}
            label="Kiseki assistant"
            banner={
              createdTripId ? (
                <Link
                  to={`/t/${createdTripId}`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
                >
                  Open your new trip
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              ) : undefined
            }
          />
        )}
      </main>
    </div>
  );
}
