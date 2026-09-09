import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useParams } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { ArrowLeft, CalendarCheck, CalendarDays, Home, ListChecks, MessageCircle, X } from "lucide-react";
import { fetchTrip, downloadBooklet, fetchJoinLink, TripAccessError } from "../lib/api";
import { isAuthConfigured, isSessionExpiredError } from "../lib/auth";
import { formatDate, dayCount, shouldShowToday } from "../lib/dates";
import { usePageTitle } from "../lib/seo";
import type { Trip } from "../lib/types";
import { TripProvider, tripStyle } from "../components/theme";
import { ChatPanel } from "../components/chat-panel";
import { TripActionsMenu } from "../components/trip-controls";
import { Button, StageBadge } from "../components/ui";

/** Under the §7.5 mobile cap of four — three base items, Today swaps in for
 *  Overview on live trips. The standalone Map item is retired (#93): the
 *  itinerary IS the map surface now (DESIGN.md §7.6), so the day level lives
 *  one tap deeper on the same nav item. */
const NAV_BASE: { to: string; label: string; icon: typeof Home; end?: boolean }[] = [
  { to: "", label: "Overview", icon: Home, end: true },
  { to: "itinerary", label: "Itinerary", icon: CalendarDays },
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

function ChatDrawer({ tripId, onClose }: { tripId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Trip chat"
      className="no-print fixed inset-x-3 bottom-3 z-30 md:inset-x-auto md:bottom-6 md:right-6 md:top-20 md:w-[400px]"
    >
      <div className="floating relative flex max-h-[70dvh] flex-col overflow-hidden rounded-2xl md:max-h-none md:h-full">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="absolute right-2.5 top-2.5 z-10 flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <ChatPanel tripId={tripId} className="h-[60dvh] border-0 md:h-full" />
      </div>
    </div>
  );
}

function NavLinks({ tripId, trip }: { tripId: string; trip: Trip | null }) {
  const { pathname } = useLocation();
  const base = `/t/${tripId}`;
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

type LoadError = "auth-required" | "no-access" | "not-found" | string;

/**
 * PDF-render mode: the backend's Playwright booklet renderer sets this flag
 * before the SPA loads (#58). The `/api/trips/{id}/booklet.pdf` endpoint has
 * ALREADY enforced JWT + crew role, so the SPA skips its `isAuthenticated`
 * UI gate here and fetches the trip with the seeded access token. Without
 * this, a subtle auth0 cache-shape mismatch makes `isAuthenticated` stay
 * false in the headless browser and the PDF captures the sign-in screen.
 */
const PDF_RENDER = typeof window !== "undefined" && window.__KISEKI_PDF_RENDER__ === true;

export function TripLayout() {
  const { tripId = "" } = useParams();
  const { pathname } = useLocation();
  const { isAuthenticated, isLoading: authLoading, getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [joinCopied, setJoinCopied] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  // In-trip chat (issue #9 / M4): a floating drawer, NOT a route — the map
  // surface stays mounted underneath so edits land visibly live.
  const [chatOpen, setChatOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // Latest pathname, read lazily inside the fetch effect — deliberately NOT a
  // dependency: child-route navigation (/t/<id>/itinerary → /day/3) would
  // otherwise re-run the effect and refetch the whole trip on every page
  // change (slow + hammering the graph).
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // Same latest-ref trick for the two callbacks the fetch effect reads:
  // `getAccessTokenSilently` and `useNavigate` can both receive a fresh
  // identity on route transitions (auth0-react re-creates the context value;
  // the router hands out a new navigate fn per location), and keeping them in
  // the dep array re-ran the WHOLE trip fetch on every day→day navigation.
  // setTrip(null) mid-navigation then swapped the route subtree for the
  // loading screen and back — remounting TripMapSurface, rebuilding the map,
  // and resetting the sheet detent (full → half) on every day change (v0.23.x
  // mobile regression: the sheet collapsed while walking day nav).
  const getTokenRef = useRef(getAccessTokenSilently);
  getTokenRef.current = getAccessTokenSilently;

  usePageTitle(trip?.title ?? null);

  // Auth0 reports isLoading=true until it has restored the session — and when
  // auth is NOT configured `useAuth0` has no provider, so it returns the
  // library's default context, where isLoading is true FOREVER. Both states
  // have to be distinguished from "signed out", or a private trip decides the
  // viewer has no access before Auth0 has answered, and an unconfigured
  // deployment never leaves the loading screen at all.
  const authReady = !isAuthConfigured() || !authLoading;

  useEffect(() => {
    let cancelled = false;
    setTrip(null);
    setError(null);
    // Wait for auth: fetching now would 403 a private trip and render the
    // access-denied screen for crew who are about to be signed in.
    if (!authReady && !PDF_RENDER) return;

    (async () => {
      try {
        // PDF-render mode: the backend's booklet.pdf endpoint already enforced
        // the visibility/ACL gate before launching the headless browser (#58).
        // The injected token is the ONLY path — never fall through to
        // getAccessTokenSilently(): its Auth0 iframe flow cannot complete in
        // the headless browser, and the render would hang until the backend's
        // booklet-content timeout (seen live after #37: first click broken,
        // second click mapless).
        if (PDF_RENDER) {
          // An EMPTY injected token is not "no access" — it means the caller
          // was anonymous, which the backend only allows for PUBLIC trips
          // (#64). Fetch anonymously so the booklet renders; erroring to the
          // no-access screen made the renderer's booklet-content wait time
          // out and the endpoint 500 for every anonymous public download.
          const t = await fetchTrip(tripId, window.__KISEKI_ACCESS_TOKEN__ || undefined);
          if (!cancelled) setTrip(t);
          return;
        }
        // Signed in → send the token on the FIRST request. Trying anonymously
        // first costs a 401 on every private-trip load before the retry, and
        // on a PUBLIC trip it is worse than cosmetic: the anonymous read
        // succeeds without `myRole`, so the owner-only affordances (the join
        // link) never appear. A public trip ignores an unusable token, so
        // there is no downside to always sending one we have.
        let at: string | undefined;
        if (isAuthenticated) {
          try {
            at = window.__KISEKI_ACCESS_TOKEN__ ?? (await getTokenRef.current());
          } catch {
            // Session expired or renewal blocked (third-party cookies). A
            // public trip still reads anonymously; a private one falls through
            // to the sign-in gate below, which is the right answer anyway.
          }
        }
        const t = await fetchTrip(tripId, at);
        if (!cancelled) setTrip(t);
      } catch (e) {
        if (cancelled) return;
        if (!(e instanceof TripAccessError)) {
          setError(e instanceof Error ? e.message : "Failed to load trip");
          return;
        }
        // 401: no usable token (signed out, or renewal failed) → sign-in gate.
        // 403: authenticated but not on this private trip's crew.
        if (e.status === 404) setError("not-found");
        else if (e.status === 403) setError("no-access");
        else setError("auth-required");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tripId, authReady, isAuthenticated]);

  // Expose the app chrome's live heights as --kiseki-header-h /
  // --kiseki-nav-h. The sticky itinerary chapter headers dock below the
  // header, and the map surface (#39) sizes itself to the viewport MINUS both:
  // a map surface has no page scroll, so it has to know exactly how much of
  // the viewport the chrome takes. Re-measured on trip change (the title/dates
  // row wraps) and on any resize; the nav is absent on day pages and hidden on
  // desktop, and 0 is the right answer in both cases.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    if (!root) return;
    const update = () => {
      root.style.setProperty("--kiseki-header-h", `${header?.offsetHeight ?? 0}px`);
      const nav = navRef.current;
      root.style.setProperty("--kiseki-nav-h", `${nav?.offsetHeight ?? 0}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    if (header) ro.observe(header);
    if (navRef.current) ro.observe(navRef.current);
    return () => ro.disconnect();
  }, [trip, pathname]);

  if (!authReady && !PDF_RENDER && !error) {
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
              If you were given a join link for this trip, sign in and follow it
              to request access.
            </p>
          </>
        ) : error === "not-found" ? (
          <>
            <p className="text-muted-foreground">This trip doesn't exist or is no longer shared.</p>
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
  const onDayPage = pathname.includes(`/t/${tripId}/day/`);
  // A MAP surface is viewport-shaped, a document surface is column-shaped, and
  // they cannot share a wrapper (DESIGN.md §2): the reading column would crop
  // the map to 768px and `pb-24` would leave a dead strip under the sheet. So
  // the shell drops the column for the map surface — the itinerary and day
  // routes both render TripMapSurface (#92/#90); /map is a redirect (#93).
  const onMapSurface =
    pathname === `/t/${tripId}/itinerary` || Boolean(pathname.match(new RegExp(`^/t/${tripId}/day/\\d+$`)));
  const isOwner = trip.myRole === "owner";

  const handleDownloadPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      // Public trips allow anonymous PDF download (#64); crew/followers send
      // their token for private trips. getAccessTokenSilently only when signed
      // in — an anonymous public viewer must not trip the Auth0 iframe flow.
      // Token acquisition is best-effort: when the session renewal fails
      // (expired refresh token — the #77 dead end), fall through to the
      // anonymous path instead of a silent dead click; a public trip ignores
      // an unusable token anyway.
      let at: string | undefined;
      if (isAuthenticated) {
        try {
          at = await getAccessTokenSilently();
        } catch {
          // renewal failed — try the anonymous path below
        }
      }
      await downloadBooklet(trip.id, at, `${trip.slug}-booklet.pdf`);
    } catch (e) {
      // A 401 on a trip that is ON SCREEN means the session died mid-visit
      // (private trip — the anonymous fallback above cannot succeed): send
      // the user to sign in rather than failing silently. 403/5xx stay quiet
      // (rare; signing in again would not change them).
      if (e instanceof TripAccessError && e.status === 401) {
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
      }
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
      // Owner-only action: a session that can no longer be renewed must not
      // fail silently — the button is the only way to reach the join link.
      if (isSessionExpiredError(e)) {
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      if (e instanceof TripAccessError && e.status === 403) setJoinCopied(false);
    }
  };

  return (
    <TripProvider trip={trip} apply={setTrip}>
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
            {/* Chat with the trip-content agent (signed in only — there is no
                anonymous chat). Opens the drawer below; the trip stays mounted. */}
            {isAuthenticated && (
              <button
                type="button"
                onClick={() => setChatOpen((open) => !open)}
                aria-expanded={chatOpen}
                aria-label={chatOpen ? "Close chat" : "Open chat"}
                title="Chat with the Kiseki assistant"
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  chatOpen
                    ? "border-primary/60 bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/40 hover:bg-muted hover:text-foreground"
                }`}
              >
                <MessageCircle className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            {/* One overflow menu holds every trip action (PDF for everyone,
                join link for the owner, stage + sharing for editor+/owner) so
                the header stays a single row. */}
            <TripActionsMenu
              pdfBusy={pdfBusy}
              onDownloadPdf={handleDownloadPdf}
              joinCopied={joinCopied}
              onCopyJoinLink={isOwner ? copyJoinLink : undefined}
            />
          </div>
          {/* Desktop nav */}
          <div className="mx-auto hidden max-w-3xl px-4 pb-2 md:block">
            <NavLinks tripId={tripId} trip={trip} />
          </div>
        </header>

        {/* Content — the reading column, except on a map surface, which takes
            the viewport minus the chrome and owns its own scrolling. */}
        {onMapSurface ? (
          <main
            className="no-print overflow-hidden"
            style={{
              height:
                "calc(100dvh - var(--kiseki-header-h, 3.5rem) - var(--kiseki-nav-h, 0px))",
            }}
          >
            <Outlet />
          </main>
        ) : (
          <main className="mx-auto max-w-3xl px-4 py-5 pb-24 md:pb-10">
            <Outlet />
          </main>
        )}

        {/* In-trip chat drawer (issue #9 / M4) — Chrome, `no-print` (via the
            panel), floating over the trip so the map surface and its content
            stay mounted underneath. Bottom sheet on mobile, right rail on
            desktop. */}
        {chatOpen && (
          <ChatDrawer tripId={trip.id} onClose={() => setChatOpen(false)} />
        )}

        {/* Mobile bottom nav (hidden on day pages — the day level has its own bar) */}
        {!onDayPage && (() => {
          const NAV = navForTrip(trip);
          return (
          <nav
            ref={navRef}
            // The home-indicator zone is real estate the OS owns — without the
            // inset the last row of icons sits under it (§7.2).
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur md:hidden"
          >
            <div className="grid" style={{ gridTemplateColumns: `repeat(${NAV.length}, minmax(0, 1fr))` }}>
              {NAV.map(({ to, label, icon: Icon, end }) => {
                const isActive = isNavActive(pathname, `/t/${tripId}`, to, end);
                return (
                  <Link
                    key={to}
                    to={to}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex min-h-11 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${
                      isActive ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
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
