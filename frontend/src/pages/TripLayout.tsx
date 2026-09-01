import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { ArrowLeft, CalendarCheck, CalendarDays, FileDown, Home, Link2, ListChecks, Map } from "lucide-react";
import { fetchTrip, downloadBooklet, isTripId, fetchJoinLink, TripAccessError } from "../lib/api";
import { formatDate, dayCount, shouldShowToday } from "../lib/dates";
import { usePageTitle } from "../lib/seo";
import type { Trip } from "../lib/types";
import { TripProvider, tripStyle } from "../components/theme";
import { Button, StageBadge } from "../components/ui";

const NAV_BASE: { to: string; label: string; icon: typeof Home; end?: boolean }[] = [
  { to: "", label: "Overview", icon: Home, end: true },
  { to: "itinerary", label: "Itinerary", icon: Map },
  { to: "practical", label: "Practical", icon: ListChecks },
];

function navForTrip(trip: Trip | null) {
  if (trip && shouldShowToday(trip)) {
    return [{ to: "today", label: "Today", icon: CalendarCheck }, ...NAV_BASE.slice(1)] as typeof NAV_BASE;
  }
  return NAV_BASE;
}

/** Nav highlight rule (desktop + mobile): day pages belong to the Itinerary
 *  surface — the scan view is their parent. Section links (/s/<n>) redirect
 *  to /itinerary#s-<n> (replace), so they never render long enough to matter. */
function isNavActive(pathname: string, base: string, to: string, end?: boolean): boolean {
  if (to === "today") return pathname === `${base}/today`;
  if (end) return pathname === base;
  if (to === "itinerary") {
    return pathname === `${base}/itinerary` || pathname.startsWith(`${base}/day`);
  }
  return pathname === `${base}/${to}`;
}

function NavLinks({ token, trip }: { token: string; trip: Trip | null }) {
  const { pathname } = useLocation();
  const base = `/t/${token}`;
  const NAV = navForTrip(trip);
  return (
    <nav className="flex items-center gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => {
        const isActive = isNavActive(pathname, base, to, end);
        return (
          <Link
            key={to}
            to={to}
            aria-current={isActive ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
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
  const [pdfBusy, setPdfBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
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

  // Expose the app header's live height as --kiseki-header-h so sticky
  // section headers (itinerary) can dock exactly below it. Re-measured on
  // trip change (title/dates row) and on any header resize.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    if (!root || !header) return;
    const update = () => root.style.setProperty("--kiseki-header-h", `${header.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(header);
    return () => ro.disconnect();
  }, [trip]);

  if (authLoading && idMode && !error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-muted-foreground" role="status">
          Loading trip…
        </p>
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
            <Button
              variant="outline"
              onClick={() =>
                loginWithRedirect({
                  appState: { returnTo: window.location.pathname },
                })
              }
            >
              Sign in
            </Button>
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
        <p className="animate-pulse text-muted-foreground" role="status">
          Loading trip…
        </p>
      </div>
    );
  }

  const days = dayCount(trip.startDate, trip.endDate);
  const onDayPage = pathname.includes(`/t/${token}/day/`);
  const isOwner = trip.myRole === "owner";

  const handleDownloadPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const at = await getAccessTokenSilently();
      await downloadBooklet(trip.id, at, `${trip.slug}-booklet.pdf`);
    } catch {
      // ignore — the backend 401/403/500 path is rare; keep the UI quiet
    } finally {
      setPdfBusy(false);
    }
  };

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
      <div ref={rootRef} style={tripStyle(trip)} className="min-h-full">
        {/* Header — content focus: just a back button, no brand chrome */}
        <header ref={headerRef} className="no-print sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
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
              <p className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                <CalendarDays className="h-3 w-3" />
                {trip.startDate && trip.endDate
                  ? `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}${days ? ` · ${days} days` : ""}`
                  : "Dates TBD"}
              </p>
            </div>
            {/* Both header actions collapse to icon-only below `sm`, so the
                label has to live in aria-label, not only in the span. */}
            {isOwner && (
              <Button
                variant="outline"
                size="sm"
                onClick={copyJoinLink}
                title="Copy the crew join link"
                aria-label={joinCopied ? "Join link copied" : "Copy the crew join link"}
              >
                <Link2 className="h-4 w-4" />
                <span className="hidden sm:inline">{joinCopied ? "Join link copied" : "Join link"}</span>
              </Button>
            )}
            {idMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadPdf}
                disabled={pdfBusy}
                title="Download the booklet PDF (crew only)"
                aria-label={pdfBusy ? "Preparing the booklet PDF" : "Download the booklet PDF"}
                className="disabled:opacity-60"
              >
                <FileDown className="h-4 w-4" />
                <span className="hidden sm:inline" aria-live="polite">
                  {pdfBusy ? "Preparing…" : "PDF"}
                </span>
              </Button>
            )}
          </div>
          {/* Desktop nav */}
          <div className="mx-auto hidden max-w-3xl px-4 pb-2 md:block">
            <NavLinks token={token} trip={trip} />
          </div>
        </header>

        {/* Content */}
        <main className="mx-auto max-w-3xl px-4 py-5 pb-24 md:pb-10">
          <Outlet />
        </main>

        {/* Mobile bottom nav (hidden on day pages — DayPage has its own bar) */}
        {!onDayPage && (() => {
          const NAV = navForTrip(trip);
          return (
          <nav className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur md:hidden">
            <div className="grid grid-cols-3">
              {NAV.map(({ to, label, icon: Icon, end }) => {
                const isActive = isNavActive(pathname, `/t/${token}`, to, end);
                return (
                  <Link
                    key={to}
                    to={to}
                    aria-current={isActive ? "page" : undefined}
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
          );
        })()}
      </div>
    </TripProvider>
  );
}
