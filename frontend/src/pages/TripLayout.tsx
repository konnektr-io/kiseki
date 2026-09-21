import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useParams } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { CalendarCheck, CalendarDays, Home, ListChecks, MessageCircle } from "lucide-react";
import { fetchTrip, refetchTrip, downloadBooklet, TripAccessError } from "../lib/api";
import { isAuthConfigured } from "../lib/auth";
import type { ChatFocus } from "../lib/chat";
import { capture } from "../lib/posthog";
import { formatDate, dayCount, shouldShowToday, todayDayIdx } from "../lib/dates";
import { usePageTitle } from "../lib/seo";
import type { Trip } from "../lib/types";
import { TripProvider, tripStyle } from "../components/theme";
import { EditModeProvider } from "../components/edit-mode";
import { AppHeader, HEADER_CONTROL, HEADER_CONTROL_ACTIVE } from "../components/AppHeader";
import { ChatPopup } from "../components/chat-panel";
import { TripActionsMenu } from "../components/trip-controls";
import { Button, StageBadge } from "../components/ui";

/** Under the §7.5 mobile cap of four: Overview always stays, and on a live
 *  trip a Today shortcut jumps straight to the current day page
 *  (`day/<idx>` — the same surface as any other day, not a separate page).
 *  The standalone Map item is retired (#93): the itinerary IS the map surface
 *  now (DESIGN.md §7.6), so the day level lives one tap deeper on the same
 *  nav item. */
const NAV_BASE: { to: string; label: string; icon: typeof Home; end?: boolean }[] = [
  { to: "", label: "Overview", icon: Home, end: true },
  { to: "itinerary", label: "Itinerary", icon: CalendarDays },
  { to: "practical", label: "Practical", icon: ListChecks },
];

/** Today shortcut target for a live trip, or null when today has no day page
 *  (before / after / dateless / section-without-days — resolveToday's honest
 *  degradations, which have nothing to open). Exported for the unit tests. */
export function todayNavTo(trip: Trip | null): string | null {
  if (!trip || !shouldShowToday(trip)) return null;
  const idx = todayDayIdx(trip);
  return idx != null ? `day/${idx}` : null;
}

function navForTrip(trip: Trip | null) {
  const today = todayNavTo(trip);
  if (today) {
    return [
      // While live the index jumps to today, so Overview needs its own
      // address — pointing it at "" would bounce straight back to the day.
      { to: "overview", label: "Overview", icon: Home },
      { to: today, label: "Today", icon: CalendarCheck },
      ...NAV_BASE.slice(1),
    ] as typeof NAV_BASE;
  }
  return NAV_BASE;
}

/** Nav highlight rule (desktop + mobile): day pages belong to the Itinerary
 *  surface — the scan view is their parent — EXCEPT today's own day, which
 *  the Today shortcut owns while it is the shortcut's target. Section links
 *  (/s/<n>) redirect to /itinerary#s-<n> (replace), so they never render long
 *  enough to matter. */
function isNavActive(pathname: string, base: string, to: string, end?: boolean): boolean {
  if (to.startsWith("day/")) return pathname === `${base}/${to}`;
  if (end) return pathname === base;
  if (to === "itinerary") {
    return pathname === `${base}/itinerary` || pathname.startsWith(`${base}/day`);
  }
  return pathname === `${base}/${to}`;
}

/** Single-active-item rule shared by the desktop and bottom navs: today's
 *  day is both a day page (the Itinerary surface) and the Today shortcut's
 *  target — the shortcut owns the highlight there. */
function isItemActive(
  nav: typeof NAV_BASE,
  pathname: string,
  base: string,
  item: { to: string; label: string; end?: boolean },
): boolean {
  let active = isNavActive(pathname, base, item.to, item.end);
  if (item.label === "Itinerary") {
    const todayHref = nav.find((n) => n.label === "Today")?.to;
    if (todayHref && pathname === `${base}/${todayHref}`) active = false;
  }
  return active;
}

function NavLinks({ tripId, trip }: { tripId: string; trip: Trip | null }) {
  const { pathname } = useLocation();
  const base = `/t/${tripId}`;
  const NAV = navForTrip(trip);
  return (
    <nav className="flex items-center gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => {
        const isActive = isItemActive(NAV, pathname, base, { to, label, end });
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

  // The chat drawer's agent writes trip content server-side, while the SPA
  // keeps the document it read at load (`api.ts` memoizes it for the session)
  // and the chat's activity row unmounts the moment the turn ends — so without
  // this, a turn's own edits are invisible until a manual reload ("I updated
  // it but you still don't see the result"). Refetch when a turn completes.
  // Failures stay silent: the current view keeps working and the next
  // navigation refetches anyway.
  //
  // ⚠️ HOOK PLACEMENT: this must stay ABOVE the loading/error early returns
  // below. Every hook in this component has to run on EVERY render — the
  // mount render bails at `if (!trip)` with a shorter hook list, so a hook
  // declared after that guard makes the next render (trip arrives) call one
  // MORE hook than the previous one, and React throws "Rendered more hooks
  // than during the previous render" (#310) for the whole app. That shipped
  // once in v0.25.8 and blanked every trip page. TripLayout.test.tsx pins it.
  const reloadTrip = useCallback(async () => {
    let at: string | undefined;
    if (isAuthenticated) {
      try {
        at = window.__KISEKI_ACCESS_TOKEN__ ?? (await getTokenRef.current());
      } catch {
        // Renewal blocked (third-party cookies) — a public trip still reads
        // anonymously; a private one just keeps the view it already has.
      }
    }
    try {
      setTrip(await refetchTrip(tripId, at));
    } catch {
      // Keep what is on screen; the agent's answer is still in the drawer.
    }
  }, [tripId, isAuthenticated]);

  // Route-derived agent scope (replaces the #296 per-surface "ask the agent
  // about this" buttons): on a day page the drawer opens already knowing
  // which day it is about — the invisible `focus` request anchor (#330), sent
  // with every turn, never as visible chat text. Off-day routes are the
  // whole-trip chat. A second navigation while the drawer is open re-scopes
  // the next turn, because `focus` is pushed per turn, not per thread.
  const routeDayIdx = (() => {
    const m = pathname.match(new RegExp(`^/t/${tripId}/day/(\\d+)$`));
    if (!m) return null;
    const i = parseInt(m[1], 10);
    return Number.isNaN(i) ? null : i;
  })();

  // Today's own day page: same day surface as any other day, but it keeps
  // the TOP-LEVEL chrome (header + bottom nav) instead of the day-level
  // DayNav bar, and the phone sheet opens all the way up. Gated on the
  // shortcut existing (live + today has a day to open) — a date-matching day
  // on a non-live trip is just a day.
  const isTodayPage =
    todayNavTo(trip) != null &&
    routeDayIdx != null &&
    trip != null &&
    routeDayIdx === todayDayIdx(trip);

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

  // The drawer scope for THIS route: the day the URL names (clamped into
  // range — a stale /day/99 keeps the whole-trip chat, never a wrong day).
  // Section/block granularity went away with the per-surface buttons; the day
  // is what the route can prove, and the agent reads the day itself.
  const routeDay =
    routeDayIdx !== null && routeDayIdx >= 0 && routeDayIdx < trip.days.length
      ? trip.days[routeDayIdx]
      : undefined;
  const routeFocus: ChatFocus | null = routeDay ? { entity: "day", id: routeDay.id } : null;
  const routeScopeLabel = routeDay
    ? `Day ${routeDayIdx! + 1} — ${routeDay.title || routeDay.date}`
    : null;

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
      // #21 metric: booklet downloads per trip (an explicitly listed goal).
      // Only on success — a failed render is not a download.
      capture("booklet_downloaded", {
        authenticated: isAuthenticated,
      });
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

  // The owner-only link/invite actions and the terminal delete moved to the
  // trip settings page (#248, `/t/<id>/settings`): they are trip-level
  // settings, not per-visit header actions, and the header menu that used to
  // hold them now points there. What stays here is the booklet PDF — the one
  // item every role may want on any visit.

  return (
    <TripProvider trip={trip} apply={setTrip}>
      <EditModeProvider tripId={trip.id}>
      <div ref={rootRef} style={tripStyle(trip)} className="min-h-full">
        {/* The shared bar (#239): same geometry, same back affordance and the
            brand on every route. The trip keeps its own action cluster (chat +
            one overflow menu, #231) passed in as `actions`, and its desktop nav
            as the bar's second row. The mobile bottom nav is a separate bar.
            On a phone the brand yields to the trip name (`hideBrandOnPhone`):
            the title is user content the traveler came to read, and with the
            badge + controls beside it the app name squeezed it to an ellipsis
            at 360–430px. The round control already covers the way home.
            Two levels only (DESIGN.md §7.5): on a day page the round control
            goes UP one level to the itinerary, not all the way home — the
            day's parent is the scan view, and the inner surface back button
            already points there. */}
        <AppHeader
          ref={headerRef}
          home={
            onDayPage
              ? { to: `/t/${tripId}/itinerary`, label: "Back to the itinerary" }
              : { to: "/", label: "Back to all trips" }
          }
          hideBrandOnPhone
          title={trip.title}
          badge={<StageBadge stage={trip.stage} />}
          subtitle={
            <>
              <CalendarDays className="h-3 w-3 shrink-0" />
              {trip.startDate && trip.endDate
                ? `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}${days ? ` · ${days} days` : ""}`
                : "Dates TBD"}
            </>
          }
          actions={
            <>
            {/* Chat with the trip-content agent (signed in only — there is no
                anonymous chat). Opens the drawer below; the trip stays mounted. */}
            {isAuthenticated && (
              <button
                type="button"
                onClick={() => setChatOpen((open) => !open)}
                aria-expanded={chatOpen}
                aria-label={chatOpen ? "Close chat" : "Open chat"}
              title="Chat with the Kiseki assistant"
              // The same round control as the back affordance (#239); the open
              // state borrows its geometry and flips the colours.
              className={chatOpen ? HEADER_CONTROL_ACTIVE : HEADER_CONTROL}
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
            {/* One overflow menu keeps the header to a single row (#239): the
                booklet PDF for everyone, and — since #248 — a link to the trip
                settings page for editor+. The trip-level actions it used to
                carry (stage, theme, sharing, the invite links, TriCount,
                delete) live on that page now. */}
            <TripActionsMenu
              pdfBusy={pdfBusy}
              onDownloadPdf={handleDownloadPdf}
            />
            </>
          }
          nav={<NavLinks tripId={tripId} trip={trip} />}
        />

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
          <ChatPopup
            tripId={trip.id}
            onClose={() => setChatOpen(false)}
            onTurnComplete={() => {
              void reloadTrip();
            }}
            label="Trip chat"
            focus={routeFocus}
            banner={
              routeScopeLabel && (
                <p className="text-xs text-muted-foreground">
                  About <span className="font-medium text-foreground">{routeScopeLabel}</span> — the
                  agent already has this day&apos;s context.
                </p>
              )
            }
          />
        )}

        {/* Mobile bottom nav: hidden on day pages — the day level has its own
            bar — EXCEPT today's own day, which keeps the top-level nav
            instead of the DayNav bar. */}
        {(!onDayPage || isTodayPage) && (() => {
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
                const isActive = isItemActive(NAV, pathname, `/t/${tripId}`, { to, label, end });
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
      </EditModeProvider>
    </TripProvider>
  );
}
