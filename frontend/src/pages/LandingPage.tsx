import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { ArrowRight, MapPin, MessageCircle, Search, Ticket } from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { ChatPopup } from "../components/chat-panel";
import { FeedRow } from "../components/FeedRow";
import { HomeMap } from "../components/HomeMap";
import { SplitView } from "../components/SplitView";
import type { Detent } from "../components/Sheet";
import { Button, Card, StageBadge } from "../components/ui";
import { fetchFeed, fetchMyTrips, fetchShowcase, fetchTripGeo } from "../lib/api";
import { formatDate, tripTodayIso } from "../lib/dates";
import { isAuthConfigured, isSessionExpiredError } from "../lib/auth";
import { filterTrips, nextUpTrip, presentStages, upNextLabel, SEASON_MONTHS, type Season, type TripFilter, type TripOrigin } from "../lib/home";
import { homePinsFromGeo, homeRowId } from "../lib/home-geo";
import { sortShowcaseTrips } from "../lib/marketing";
import { prefersReducedMotion } from "../lib/maps";
import { usePageTitle } from "../lib/seo";
import { MarketingLanding } from "./LandingMarketing";
import type { FeedEntry, ShowcaseTrip, Stage, TripGeo, TripSummary, Visibility } from "../lib/types";

/**
 * Landing page (issue #7; discovery home #249 slice 2, map canvas slice 3).
 *
 * - Signed out: the marketing landing (#249).
 * - Signed in: the discovery home on the §2.2 map canvas — the map fills the
 *   remainder (desktop: fixed left rail 380–420px; phone: full-bleed behind a
 *   three-detent sheet) and the four bands live in the rail/sheet furniture:
 *
 *   1. **Up next** — the live trip, else the soonest-starting one (`lib/home`).
 *   2. **Your trips** — every trip you have a crew role on, furthest-along first.
 *   3. **Following** — the newest writes on trips of people you follow (the same
 *      `FeedRow` `/feed` renders; the home shows the first page, `/feed` keeps
 *      the archive). Never re-sorted: the server owns feed order (#199).
 *   4. **Discover** — public, discoverable trips as cards, minus your own.
 *
 * Pins come from the E2 geo read (`GET /api/trips/geo` — one anchor per
 * listable trip), coloured by stage via `pinClassForStage`. Band↔pin linkage
 * is the chip↔card idiom from #104, not a new interaction: hovering or
 * focusing a band row raises its pin, tapping a pin scrolls its row into view
 * with the shared `place-pill-flash`. With no geo the map collapses and the
 * bands render as-is — a home with trips is still a home.
 *
 * One comparator inside the trip bands (`sortShowcaseTrips`), one filter
 * (`filterTrips`: free text + stage chips), both pure and tested. An empty band
 * collapses to one line of copy — never an empty frame. Feed, showcase and geo
 * load soft: if any fails its band collapses instead of erroring the page,
 * because a home with your trips is still a home.
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

/** The minimum TripCard reads: TripSummary and ShowcaseTrip both qualify.
 *  `cover` admits `null` because the showcase shape does — a missing cover
 *  renders the map-pin fallback either way. */
type CardTrip = {
  dtId: string;
  cover?: string | null;
  title: string;
  startDate?: string | null;
  endDate?: string | null;
  subtitle?: string | null;
  stage: Stage;
  role?: string;
};

function TripCard({ trip }: { trip: CardTrip }) {
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

function Band({
  title,
  blurb,
  action,
  children,
}: {
  title: string;
  blurb?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-10">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-heading text-xl font-semibold tracking-wide">{title}</h2>
          {blurb ? <p className="mt-0.5 text-sm text-muted-foreground">{blurb}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** An empty band collapses to one line — never an empty frame. */
function Collapsed({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * One band row that answers a map pin — the pin↔row tie in one direction.
 *
 * The wrapper owns the row's `id` (a pin tap scrolls here) and the
 * `data-dtid` the delegated hover/focus handler resolves. A raised row draws
 * the accent outline; a pin tap adds the shared `place-pill-flash` (#104) so
 * the eye lands on it.
 */
function BandRow({
  dtId,
  selected,
  flash,
  children,
}: {
  dtId: string;
  selected: boolean;
  flash: boolean;
  children: ReactNode;
}) {
  const hot = selected || flash;
  return (
    <div
      id={homeRowId(dtId)}
      data-dtid={dtId}
      className={
        hot
          ? `rounded-xl outline outline-2 outline-offset-2 outline-accent${flash ? " place-pill-flash" : ""}`
          : undefined
      }
    >
      {children}
    </div>
  );
}

/**
 * The four bands + the search row, shared verbatim by both home layouts.
 *
 * The collapsed layout (no geo) renders this inside a reading column; the map
 * canvas renders it inside the rail/sheet furniture — same components, same
 * comparator, same collapse-to-one-line empty states. It owns no data fetch:
 * everything arrives as props.
 */
function HomeBands({
  trips,
  error,
  nextUp,
  gridTrips,
  followed,
  discoverTrips,
  stageChips,
  todayIso,
  query,
  onQueryChange,
  stages,
  onToggleStage,
  place,
  onPlaceChange,
  months,
  onToggleSeason,
  originSel,
  onOriginSel,
  vis,
  onToggleVisibility,
  filtering,
  selectedDtId,
  flashDtId,
  chatOpen,
  onOpenChat,
  onRetry,
  onSignInAgain,
}: {
  trips: TripSummary[] | null;
  error: TripsError | null;
  nextUp: TripSummary | null;
  gridTrips: TripSummary[] | null;
  followed: FeedEntry[] | null;
  discoverTrips: ShowcaseTrip[] | null;
  stageChips: Stage[];
  todayIso: string;
  query: string;
  onQueryChange: (q: string) => void;
  stages: readonly Stage[];
  onToggleStage: (stage: Stage) => void;
  place: string;
  onPlaceChange: (q: string) => void;
  months: readonly number[];
  onToggleSeason: (season: Season) => void;
  originSel: "all" | "mine" | "following";
  onOriginSel: (sel: "all" | "mine" | "following") => void;
  vis: readonly Visibility[];
  onToggleVisibility: (v: Visibility) => void;
  filtering: boolean;
  selectedDtId: string | null;
  flashDtId: string | null;
  chatOpen: boolean;
  onOpenChat: () => void;
  onRetry: () => void;
  onSignInAgain: () => void;
}) {
  return (
    <>
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-heading text-2xl font-semibold tracking-wide">Home</h2>
          <p className="text-sm text-muted-foreground">
            Your trips, the people you follow, and trips worth discovering.
          </p>
        </div>
        {/* Landing chat launcher — top-right of the home (only when the user
            has trips; the empty state gets a center button below, so a
            brand-new user still finds the assistant). Opens the same floating
            popup as the in-trip chat (#9 / M4 v2). */}
        {trips && trips.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenChat}
            aria-haspopup="dialog"
            aria-expanded={chatOpen}
            className="shrink-0"
          >
            <MessageCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Ask Kiseki
          </Button>
        )}
      </div>

      {/* Search + facets sit above the bands and filter the trip bands (feed
          rows carry no stage, month, origin or visibility, so the chips skip
          them — the text applies). Stage chips stay as-is. */}
      {trips && trips.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="relative min-w-52 flex-1 sm:max-w-xs">
            <span className="sr-only">Search trips</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search trips"
              className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:focus-ring"
            />
          </label>
          <label className="relative min-w-40 flex-1 sm:max-w-[12rem]">
            <span className="sr-only">Place or region</span>
            <MapPin
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={place}
              onChange={(e) => onPlaceChange(e.target.value)}
              placeholder="Place or region"
              className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:focus-ring"
            />
          </label>
          {stageChips.map((stage) => {
            const active = stages.includes(stage);
            return (
              <button
                key={stage}
                type="button"
                onClick={() => onToggleStage(stage)}
                aria-pressed={active}
                className={`h-9 rounded-full border px-3 text-xs font-medium capitalize transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {stage}
              </button>
            );
          })}
          {(["spring", "summer", "autumn", "winter"] as const).map((season) => {
            const want = SEASON_MONTHS[season];
            const active = want.every((m) => months.includes(m));
            return (
              <button
                key={season}
                type="button"
                onClick={() => onToggleSeason(season)}
                aria-pressed={active}
                title="Trips starting in this season"
                className={`h-9 rounded-full border px-3 text-xs font-medium capitalize transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {season}
              </button>
            );
          })}
          <span role="group" aria-label="Whose trips" className="inline-flex overflow-hidden rounded-full border border-border">
            {(["all", "mine", "following"] as const).map((sel) => {
              const active = originSel === sel;
              return (
                <button
                  key={sel}
                  type="button"
                  onClick={() => onOriginSel(sel)}
                  aria-pressed={active}
                  className={`h-9 px-3 text-xs font-medium capitalize transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {sel === "all" ? "All" : sel === "mine" ? "Mine" : "Following"}
                </button>
              );
            })}
          </span>
          {(["public", "private"] as const).map((v) => {
            const active = vis.includes(v);
            return (
              <button
                key={v}
                type="button"
                onClick={() => onToggleVisibility(v)}
                aria-pressed={active}
                className={`h-9 rounded-full border px-3 text-xs font-medium capitalize transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {v}
              </button>
            );
          })}
        </div>
      )}

      {error ? (
        error.kind === "expired" ? (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center"
          >
            <p className="text-sm font-medium text-destructive">Your session expired.</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Sign in again to reload your trips — this usually takes one click.
            </p>
            <Button variant="outline" size="sm" onClick={onSignInAgain} className="mt-3 text-xs">
              Sign in again
            </Button>
          </div>
        ) : (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center"
          >
            <p className="text-sm font-medium text-destructive">{error.message}</p>
            <Button variant="outline" size="sm" onClick={onRetry} className="mt-3 text-xs">
              Retry
            </Button>
          </div>
        )
      ) : trips === null ? (
        <TripGridSkeleton />
      ) : trips.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border bg-card p-10 text-center">
          <Ticket className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" strokeWidth={1.5} />
          <h3 className="font-heading text-lg font-semibold">No trips yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Plan your first journey with the Kiseki assistant — describe the trip you have in
            mind and it will build the booklet for you. Or ask a trip owner for their join link
            to hop onto an existing one.
          </p>
          <Button
            onClick={onOpenChat}
            aria-haspopup="dialog"
            aria-expanded={chatOpen}
            className="mt-5"
          >
            <MessageCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Plan a trip
          </Button>
        </div>
      ) : (
        <>
          {nextUp && !filtering && (
            <Band title="Up next" blurb={upNextLabel(nextUp, todayIso)}>
              <div className="max-w-xl">
                <BandRow
                  dtId={nextUp.dtId}
                  selected={selectedDtId === nextUp.dtId}
                  flash={flashDtId === nextUp.dtId}
                >
                  <TripCard trip={nextUp} />
                </BandRow>
              </div>
            </Band>
          )}

          <Band
            title="Your trips"
            blurb={
              gridTrips?.length
                ? "Every journey you're part of — pick one to open the booklet."
                : undefined
            }
          >
            {gridTrips && gridTrips.length > 0 ? (
              <div className="grid gap-5 sm:grid-cols-2">
                {gridTrips.map((trip) => (
                  <BandRow
                    key={trip.dtId}
                    dtId={trip.dtId}
                    selected={selectedDtId === trip.dtId}
                    flash={flashDtId === trip.dtId}
                  >
                    <TripCard trip={trip} />
                  </BandRow>
                ))}
              </div>
            ) : (
              <Collapsed>
                {filtering
                  ? "No trips match this search."
                  : "Every journey you're part of will land here."}
              </Collapsed>
            )}
          </Band>

          <Band
            title="Following"
            blurb="The newest writes on trips of people you follow."
            action={
              <Link
                to="/feed"
                className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Open the feed
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            }
          >
            {followed === null ? (
              <Collapsed>Loading what the people you follow are writing…</Collapsed>
            ) : followed.length > 0 ? (
              <Card className="overflow-hidden">
                <ul className="divide-y divide-border">
                  {followed.map((entry, i) => (
                    <FeedRow
                      key={`${entry.kind}-${entry.at ?? "?"}-${entry.href}-${i}`}
                      entry={entry}
                      now={Date.now()}
                    />
                  ))}
                </ul>
              </Card>
            ) : (
              <Collapsed>
                Nothing here yet — follow people to see their public trips as they write them.
              </Collapsed>
            )}
          </Band>

          <Band title="Discover" blurb="Public trips worth a look.">
            {discoverTrips === null ? (
              <Collapsed>Looking for public trips…</Collapsed>
            ) : discoverTrips && discoverTrips.length > 0 ? (
              <div className="grid gap-5 sm:grid-cols-2">
                {discoverTrips.map((trip) => (
                  <BandRow
                    key={trip.dtId}
                    dtId={trip.dtId}
                    selected={selectedDtId === trip.dtId}
                    flash={flashDtId === trip.dtId}
                  >
                    <TripCard trip={trip} />
                  </BandRow>
                ))}
              </div>
            ) : (
              <Collapsed>
                {filtering
                  ? "No public trips match this search."
                  : "No public trips to discover right now."}
              </Collapsed>
            )}
          </Band>
        </>
      )}
    </>
  );
}

function AuthenticatedLanding() {
  const {
    isLoading: authLoading,
    isAuthenticated,
    getAccessTokenSilently,
    loginWithRedirect,
  } = useAuth0();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [feed, setFeed] = useState<FeedEntry[] | null>(null);
  const [discover, setDiscover] = useState<ShowcaseTrip[] | null>(null);
  // Trip anchors for the map canvas (E2). `null` = the read failed — the map
  // collapses, the bands still render. `[]` (including graph-disabled) also
  // collapses: same soft-load discipline as feed/showcase.
  const [geo, setGeo] = useState<TripGeo[] | null>(null);
  // Band↔pin linkage: the raised trip on both surfaces.
  const [selectedDtId, setSelectedDtId] = useState<string | null>(null);
  // The row a pin tap just raised — flashes once via `place-pill-flash` (#104).
  const [flashDtId, setFlashDtId] = useState<string | null>(null);
  // Phone sheet detent (`SplitView` owns the ladder; desktop ignores this).
  const [detent, setDetent] = useState<Detent>("half");
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
  const [query, setQuery] = useState("");
  const [stages, setStages] = useState<readonly Stage[]>([]);
  // Rich facets (#249 slice 4): month/season from startDate, place/region over
  // the E2 anchors, mine⇄following provenance, visibility. All optional, all
  // empty by default — the bands answer the unfiltered home first.
  const [place, setPlace] = useState("");
  const [months, setMonths] = useState<readonly number[]>([]);
  const [originSel, setOriginSel] = useState<"all" | "mine" | "following">("all");
  const [vis, setVis] = useState<readonly Visibility[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!isAuthenticated) {
      setTrips(null);
      setFeed(null);
      setDiscover(null);
      setGeo(null);
      setError(null);
      return;
    }
    setTrips(null);
    setFeed(null);
    setDiscover(null);
    setGeo(null);
    setError(null);
    void (async () => {
      try {
        const token = await getAccessTokenSilently();
        // Trips are the page; feed, showcase and geo are bands. The three load
        // soft (a failure collapses the band) so a hiccup in any never
        // blanks the home.
        const [tripsRes, feedRes, discoverRes, geoRes] = await Promise.allSettled([
          fetchMyTrips(token),
          fetchFeed(token),
          fetchShowcase(),
          fetchTripGeo(token),
        ]);
        if (cancelled) return;
        if (tripsRes.status === "rejected") {
          const e = tripsRes.reason;
          setError(
            isSessionExpiredError(e)
              ? { kind: "expired" }
              : { kind: "load", message: e instanceof Error ? e.message : "Failed to load trips" },
          );
          return;
        }
        setTrips(tripsRes.value);
        setFeed(feedRes.status === "fulfilled" ? feedRes.value.items : null);
        setDiscover(discoverRes.status === "fulfilled" ? discoverRes.value : null);
        setGeo(geoRes.status === "fulfilled" ? geoRes.value : null);
      } catch (e: unknown) {
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getAccessTokenSilently, attempt]);

  const filter: TripFilter = useMemo(
    () => ({
      q: query,
      stages,
      months,
      place,
      origins:
        originSel === "all" ? [] : originSel === "mine" ? ["mine"] : (["following", "discover"] as TripOrigin[]),
      visibility: vis,
    }),
    [query, stages, months, place, originSel, vis],
  );

  // Anchor names by trip, from the E2 read — the place/region facet's index.
  const anchorByTrip = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of geo ?? []) map.set(row.dtId, row.anchor.name);
    return map;
  }, [geo]);

  const orderedTrips = useMemo(
    () =>
      trips
        ? filterTrips(
            sortShowcaseTrips(trips).map((t) => ({
              ...t,
              origin: "mine" as const,
              anchorName: anchorByTrip.get(t.dtId) ?? null,
            })),
            filter,
          )
        : null,
    [trips, filter, anchorByTrip],
  );
  const nextUp = useMemo(() => (trips ? nextUpTrip(trips) : null), [trips]);
  const gridTrips = useMemo(
    () => orderedTrips?.filter((t) => t.dtId !== nextUp?.dtId) ?? null,
    [orderedTrips, nextUp],
  );
  const followed = useMemo(() => {
    if (!feed) return null;
    // Feed rows carry no stage, month, origin or visibility — the chips skip
    // them; the text (search or place) applies, over the same fields as today.
    const q = `${query} ${place}`.trim().toLowerCase();
    return feed
      .filter((e) => e.source === "followed-user")
      .filter(
        (e) =>
          !q ||
          e.tripTitle.toLowerCase().includes(q) ||
          (e.blockTitle ?? "").toLowerCase().includes(q) ||
          (e.label ?? "").toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [feed, query, place]);
  const discoverTrips = useMemo(() => {
    if (!discover) return null;
    const mine = new Set((trips ?? []).map((t) => t.dtId));
    return filterTrips(
      sortShowcaseTrips(discover.filter((t) => !mine.has(t.dtId))).map((t) => ({
        ...t,
        origin: "discover" as const,
        anchorName: anchorByTrip.get(t.dtId) ?? null,
      })),
      filter,
    );
  }, [discover, trips, filter, anchorByTrip]);
  const stageChips = useMemo(
    () => presentStages([...(trips ?? []), ...(discover ?? [])]),
    [trips, discover],
  );
  // Any active facet steps Up next aside and rewords the empty bands.
  const filtering = useMemo(
    () =>
      query.trim() !== "" ||
      place.trim() !== "" ||
      stages.length > 0 ||
      months.length > 0 ||
      originSel !== "all" ||
      vis.length > 0,
    [query, place, stages, months, originSel, vis],
  );
  const todayIso = useMemo(() => tripTodayIso({}), []);
  // Pins from the E2 read, verbatim — a trip the read did not list gets no
  // pin, and an unlisted pin must never render (the read is the list).
  const pins = useMemo(() => homePinsFromGeo(geo ?? []), [geo]);
  const hasMap = pins.length > 0;

  // A pin tap raises its band row: highlight + scroll into view with the
  // shared pill flash (#104). The camera stays put — selection is a focus
  // story, never a camera move.
  const selectPin = useCallback((dtId: string) => {
    setSelectedDtId(dtId);
    if (!prefersReducedMotion()) setFlashDtId(dtId);
    requestAnimationFrame(() => {
      document
        .getElementById(homeRowId(dtId))
        ?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
  }, []);

  // A band row hover/focus raises its pin — one delegated handler per surface.
  // Card rows resolve through their own `data-dtid`; feed rows carry no
  // wrapper (a div inside a ul is invalid HTML), so their trip links resolve
  // to the pin through the href instead.
  const selectFromRow = useCallback((e: React.SyntheticEvent) => {
    const target = e.target as HTMLElement;
    const row = target.closest?.("[data-dtid]");
    let dtId = row?.getAttribute("data-dtid");
    if (!dtId) {
      const href = target.closest?.("a[href^='/t/']")?.getAttribute("href");
      const m = href?.match(/^\/t\/([^/]+)/);
      if (m) dtId = m[1];
    }
    if (dtId) setSelectedDtId(dtId);
  }, []);

  // The flash runs once per tap; clear it so the next tap re-fires it.
  useEffect(() => {
    if (!flashDtId) return;
    const t = window.setTimeout(() => setFlashDtId(null), 1300);
    return () => window.clearTimeout(t);
  }, [flashDtId]);

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

  const toggleStage = (stage: Stage) =>
    setStages((prev) => (prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]));

  // A season chip toggles its three months as a set.
  const toggleSeason = (season: Season) =>
    setMonths((prev) => {
      const want = SEASON_MONTHS[season];
      const hasAll = want.every((m) => prev.includes(m));
      return hasAll
        ? prev.filter((m) => !want.includes(m))
        : [...new Set([...prev, ...want])].sort((a, b) => a - b);
    });

  const toggleVis = (v: Visibility) =>
    setVis((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  const bands = (
    <HomeBands
      trips={trips}
      error={error}
      nextUp={nextUp}
      gridTrips={gridTrips}
      followed={followed}
      discoverTrips={discoverTrips}
      stageChips={stageChips}
      todayIso={todayIso}
      query={query}
      onQueryChange={setQuery}
      stages={stages}
      onToggleStage={toggleStage}
      place={place}
      onPlaceChange={setPlace}
      months={months}
      onToggleSeason={toggleSeason}
      originSel={originSel}
      onOriginSel={setOriginSel}
      vis={vis}
      onToggleVisibility={toggleVis}
      filtering={filtering}
      selectedDtId={selectedDtId}
      flashDtId={flashDtId}
      chatOpen={chatOpen}
      onOpenChat={() => setChatOpen(true)}
      onRetry={() => setAttempt((n) => n + 1)}
      onSignInAgain={() =>
        loginWithRedirect({ appState: { returnTo: window.location.pathname } })
      }
    />
  );

  // Landing chat popup (issue #9 / M4 v2): the same floating drawer as the
  // in-trip chat, opened by the header / empty-state launchers above. No
  // tripId — the assistant answers questions about the user's trips or creates
  // a new one; uploads stage in the user's inbox until the agent promotes them
  // into the new trip. A fresh trip surfaces as an "Open trip" banner while the
  // grid refetches.
  const chat = chatOpen && (
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
  );

  // Peek line for the phone sheet: one line of "what's next".
  const peek =
    nextUp && !filtering ? (
      <>
        Up next: <span className="font-medium text-foreground">{nextUp.title}</span>
        {" — "}
        {upNextLabel(nextUp, todayIso)}
      </>
    ) : (
      <>
        {trips?.length ?? 0} {trips?.length === 1 ? "trip" : "trips"} · {pins.length} on the map
      </>
    );

  // Map canvas (§2.2): the map fills the remainder and the bands move as-is
  // into the rail/sheet furniture. Desktop ≥1280px gets the fixed left rail,
  // phones the full-bleed map behind the three-detent sheet — the ladder owns
  // that, this branch only decides canvas vs. collapsed.
  if (hasMap && trips && trips.length > 0 && !error) {
    return (
      <div
        className="flex h-dvh flex-col overflow-hidden"
        onMouseOver={selectFromRow}
        onFocus={selectFromRow}
      >
        <div className="shrink-0">
          <AppHeader actions={<AuthButton />} />
        </div>
        <div className="min-h-0 flex-1">
          <SplitView
            label="Your trips on the map"
            header={<p className="truncate text-sm text-muted-foreground">{peek}</p>}
            content={bands}
            detent={detent}
            onDetentChange={setDetent}
            map={(padding) => (
              <HomeMap
                pins={pins}
                selectedDtId={selectedDtId}
                onSelect={selectPin}
                padding={padding}
              />
            )}
          />
        </div>
        {chat}
      </div>
    );
  }

  // Collapsed map (no geo, an error, or no trips yet): the bands as-is in a
  // reading column — a home with trips is still a home.
  return (
    <div className="min-h-screen" onMouseOver={selectFromRow} onFocus={selectFromRow}>
      <AppHeader actions={<AuthButton />} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        {bands}
        {chat}
      </main>
    </div>
  );
}
