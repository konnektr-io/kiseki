import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { ArrowLeft, CalendarDays, FileDown, Home, Link2, ListChecks, Map } from "lucide-react";
import { fetchTrip, bookletUrl, isTripId, fetchJoinLink, TripAccessError } from "../lib/api";
import { formatDate, dayCount } from "../lib/dates";
import { usePageTitle } from "../lib/seo";
import type { Trip } from "../lib/types";
import { TripProvider, tripStyle } from "../components/theme";
import { StageBadge } from "../components/ui";

const NAV = [
  { to: "", label: "Overview", icon: Home, end: true },
  { to: "itinerary", label: "Itinerary", icon: Map },
  { to: "practical", label: "Practical", icon: ListChecks },
];

function NavLinks({ token }: { token: string }) {
  const { pathname } = useLocation();
  const base = `/t/${token}`;
  const active = (to: string, end?: boolean) =>
    end ? pathname === base : pathname === `${base}/${to}` || (to === "itinerary" && pathname.startsWith(`${base}/day`));
  return (
    <nav className="flex items-center gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <Link
          key={to}
          to={to}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            active(to, end) ? "bg-primary text-primary-foreground" : "hover:bg-muted"
          }`}
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

type LoadError = "auth-required" | "no-access" | string;

export function TripLayout() {
  const { token = "" } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading, getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [joinCopied, setJoinCopied] = useState(false);
  // Latest pathname, read lazily inside the fetch effect — deliberately NOT a
  // dependency: child-route navigation (/t/<id>/itinerary → /day/3) would
  // otherwise re-run the effect and refetch the whole trip on every page
  // change (slow + hammering the graph).
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const idMode = isTripId(token);
  usePageTitle(trip?.title ?? null);

  useEffect(() => {
    let cancelled = false;
    setTrip(null);
    setError(null);

    (async () => {
      try {
        if (idMode) {
          // Protected route: valid token + ACL role required.
          if (!isAuthenticated) {
            if (!cancelled) setError("auth-required");
            return;
          }
          const at = await getAccessTokenSilently();
          const t = await fetchTrip(token, at);
          if (!cancelled) setTrip(t);
          return;
        }
        // Public share-link route — works for anyone with the link.
        const t = await fetchTrip(token);
        if (isAuthenticated) {
          // Signed in (in the background): canonicalize to the id route when
          // the user also has id-access; otherwise stay on the share link
          // (link access only — the id route would 403).
          try {
            const at = await getAccessTokenSilently();
            await fetchTrip(t.id, at);
            if (!cancelled) {
              navigate(pathnameRef.current.replace(`/t/${token}`, `/t/${t.id}`), { replace: true });
            }
            return;
          } catch {
            // no id access → fall through to the share-link render
          }
        }
        if (!cancelled) setTrip(t);
      } catch (e) {
        if (!cancelled) {
          if (e instanceof TripAccessError && e.status === 401) setError("auth-required");
          else if (e instanceof TripAccessError && e.status === 403) setError("no-access");
          else setError(e instanceof Error ? e.message : "Failed to load trip");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, idMode, isAuthenticated, getAccessTokenSilently, navigate]);

  if (authLoading && idMode && !error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-muted-foreground">Loading trip…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-2xl font-bold">Kiseki</h1>
        {error === "auth-required" ? (
          <>
            <p className="text-muted-foreground">Sign in to view this trip.</p>
            <button
              onClick={() =>
                loginWithRedirect({
                  appState: { returnTo: window.location.pathname },
                })
              }
              className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
            >
              Sign in
            </button>
          </>
        ) : error === "no-access" ? (
          <>
            <p className="text-muted-foreground">You don't have access to this trip.</p>
            <p className="text-sm text-muted-foreground">
              If you were given a share link, use that instead.
            </p>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">{error}</p>
            <p className="text-sm text-muted-foreground">
              Check the link you were given — trip links are private.
            </p>
          </>
        )}
        <Link to="/" className="text-sm font-medium underline underline-offset-2">
          Home
        </Link>
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-muted-foreground">Loading trip…</p>
      </div>
    );
  }

  const days = dayCount(trip.startDate, trip.endDate);
  const onDayPage = pathname.includes(`/t/${token}/day/`);
  const isOwner = trip.myRole === "owner";

  const copyJoinLink = async () => {
    try {
      const at = await getAccessTokenSilently();
      const joinUrl = await fetchJoinLink(trip.id, at);
      await navigator.clipboard.writeText(window.location.origin + joinUrl);
      setJoinCopied(true);
      setTimeout(() => setJoinCopied(false), 2000);
    } catch (e) {
      if (e instanceof TripAccessError && e.status === 403) setJoinCopied(false);
    }
  };

  return (
    <TripProvider trip={trip}>
      <div style={tripStyle(trip)} className="min-h-full">
        {/* Header — content focus: just a back button, no brand chrome */}
        <header className="no-print sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
            <Link
              to="/"
              title="All trips"
              aria-label="Back to all trips"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-lg font-bold leading-tight">{trip.title}</h1>
                <StageBadge stage={trip.stage} />
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarDays className="h-3 w-3" />
                {trip.startDate && trip.endDate
                  ? `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}${days ? ` · ${days} days` : ""}`
                  : "Dates TBD"}
              </p>
            </div>
            {isOwner && (
              <button
                onClick={copyJoinLink}
                title="Copy the crew join link"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
              >
                <Link2 className="h-4 w-4" />
                <span className="hidden sm:inline">{joinCopied ? "Join link copied" : "Join link"}</span>
              </button>
            )}
            {idMode && trip.token && (
              <a
                href={bookletUrl(trip.token)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                <FileDown className="h-4 w-4" />
                <span className="hidden sm:inline">PDF</span>
              </a>
            )}
          </div>
          {/* Desktop nav */}
          <div className="mx-auto hidden max-w-3xl px-4 pb-2 md:block">
            <NavLinks token={token} />
          </div>
        </header>

        {/* Content */}
        <main className="mx-auto max-w-3xl px-4 py-5 pb-24 md:pb-10">
          <Outlet />
        </main>

        {/* Mobile bottom nav (hidden on day pages — DayPage has its own bar) */}
        {!onDayPage && (
          <nav className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur md:hidden">
            <div className="grid grid-cols-3">
              {NAV.map(({ to, label, icon: Icon, end }) => {
                const isActive = end
                  ? pathname === `/t/${token}`
                  : pathname === `/t/${token}/${to}` ||
                    (to === "itinerary" && pathname.startsWith(`/t/${token}/day`));
                return (
                  <Link
                    key={to}
                    to={to}
                    className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
                      isActive ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </Link>
                );
              })}
            </div>
          </nav>
        )}
      </div>
    </TripProvider>
  );
}
