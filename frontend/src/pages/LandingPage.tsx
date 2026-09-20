import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { ArrowRight, Check, Layers, MapPin, MessageCircle, Plus, Ticket } from "lucide-react";
import { AppHeader, HEADER_CONTROL, HEADER_CONTROL_ACTIVE } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { ChatPopup } from "../components/chat-panel";
import { FeedRow } from "../components/FeedRow";
import { HomeFilters } from "../components/HomeFilters";
import { HomeMap } from "../components/HomeMap";
import { SplitView } from "../components/SplitView";
import { TripPinCard, type PinCardTrip } from "../components/TripPinCard";
import type { Detent } from "../components/Sheet";
import { Button, Card, StageBadge } from "../components/ui";
import {
  fetchFeed,
  fetchMyTrips,
  fetchShowcase,
  fetchTripGeo,
  followPublicTrip,
} from "../lib/api";
import { formatDate, tripTodayIso } from "../lib/dates";
import { isAuthConfigured, isSessionExpiredError } from "../lib/auth";
import {
  activeFacetCount,
  filterTrips,
  nextUpTrip,
  presentSeasons,
  presentStages,
  presentVisibilities,
  upNextLabel,
  SEASON_MONTHS,
  type Season,
  type TripFilter,
  type TripOrigin,
} from "../lib/home";
import { homePinsFromGeo, homeRowId } from "../lib/home-geo";
import { adoptThreadId, chatContextKey, loadThreadId, newThreadId } from "../lib/chat";
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
 *   2. **Your trips** — trips you are crew on (owner/editor/viewer),
 *      furthest-along first. A trip you merely follow is NOT yours: it lives
 *      in the next band, with its `follower` role badge on the card.
 *   3. **Trips you follow** — role=`follower` only. Rendered only while it has
 *      rows, or while a filter is hiding them — so a home with no followed
 *      trips never sprouts the band, filtering or not.
 *   4. **Updates** — the newest writes on trips of people you follow (the same
 *      `FeedRow` `/feed` renders; the home shows the first page, `/feed` keeps
 *      the archive). Never re-sorted: the server owns feed order (#199). Named
 *      for what it holds (writes), so it cannot be confused with the trips band
 *      above it.
 *   5. **Discover** — public, discoverable trips as cards, minus your own.
 *
 * The canvas shows whenever there are pins to stand on — including a brand-new
 * account whose only pins are discoverable trips. A home with no pins (geo
 * down, or nothing listable at all) collapses to the bands in a reading
 * column. Either way the agent stays one tap away: the header carries the
 * round chat toggle (the in-trip control in the same slot), and Your trips
 * keeps a permanent Plan-a-trip action — so creation stays visible on
 * populated homes, including follow-only ones where the empty state's own
 * Plan-a-trip button never renders (#347).
 *
 * Pins come from the E2 geo read (`GET /api/trips/geo` — one anchor per
 * listable trip), coloured by stage via `pinClassForStage`. Band↔pin linkage
 * is the chip↔card idiom from #104, not a new interaction: hovering or
 * focusing a band row raises its pin, tapping a pin scrolls its row into view
 * with the shared `place-pill-flash`. With no geo the map collapses and the
 * bands render as-is — a home with trips is still a home.
 *
 * The global trip map (slice 5) is a layer on the SAME canvas, not a page: a
 * floating toggle (default ON with the bands) shows one pin per discoverable
 * trip at its anchor, and a pin tap opens the trip card — never the trip, and
 * never a pin the geo read did not list.
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

/**
 * Follow a public trip, straight from its discovery card.
 *
 * The endpoint has existed since #197 (`followPublicTrip`) with no caller in
 * the UI at all — so a public trip could only be followed by opening it and
 * finding the follow link. This is its first home: the front door, where a
 * visitor with no trips of their own is looking at someone else's.
 *
 * A sibling of the card's link, never nested inside it: a `<button>` inside an
 * `<a>` is invalid HTML and the click would fight the navigation. It floats
 * over the photo's top-right corner — the stage badge owns the left.
 */
function FollowChip({
  busy,
  following,
  title,
  onFollow,
}: {
  busy: boolean;
  following: boolean;
  title: string;
  onFollow: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFollow}
      disabled={busy || following}
      aria-label={following ? `Following ${title}` : `Follow ${title}`}
      className="floating flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-foreground transition-colors focus-visible:focus-ring disabled:cursor-default"
    >
      {following ? (
        <>
          <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          Following
        </>
      ) : busy ? (
        "Following…"
      ) : (
        <>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Follow
        </>
      )}
    </button>
  );
}

/**
 * A discovery card: the trip card plus the one action a stranger may take on a
 * public trip they do not have a role on.
 */
function DiscoverCard({
  trip,
  following,
  busy,
  onFollow,
}: {
  trip: CardTrip;
  following: boolean;
  busy: boolean;
  onFollow: () => void;
}) {
  return (
    <div className="relative">
      <TripCard trip={trip} />
      <div className="absolute right-2.5 top-2.5 z-10">
        <FollowChip
          busy={busy}
          following={following}
          title={trip.title}
          onFollow={onFollow}
        />
      </div>
    </div>
  );
}

/**
 * The discovery shelf — public, discoverable trips worth a look, with the
 * follow action on every card.
 *
 * Rendered by BOTH homes: the populated one (bands) and the brand-new account,
 * where it is the difference between "No trips yet" and something to look at.
 * One component so the two can never drift apart.
 */
function DiscoverBand({
  trips,
  filtering,
  followedIds,
  busyId,
  error,
  onFollow,
  selectedDtId,
  flashDtId,
  title = "Discover",
  blurb = "Public trips worth a look.",
  emptyLine = "No public trips to discover right now.",
}: {
  trips: ShowcaseTrip[] | null;
  filtering: boolean;
  followedIds: readonly string[];
  busyId: string | null;
  error: string | null;
  onFollow: (dtId: string) => void;
  selectedDtId: string | null;
  flashDtId: string | null;
  title?: string;
  blurb?: string;
  emptyLine?: string;
}) {
  return (
    <Band title={title} blurb={blurb}>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {trips === null ? (
        <Collapsed>Looking for public trips…</Collapsed>
      ) : trips.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2">
          {trips.map((trip) => (
            <BandRow
              key={trip.dtId}
              dtId={trip.dtId}
              selected={selectedDtId === trip.dtId}
              flash={flashDtId === trip.dtId}
            >
              <DiscoverCard
                trip={trip}
                following={followedIds.includes(trip.dtId)}
                busy={busyId === trip.dtId}
                onFollow={() => onFollow(trip.dtId)}
              />
            </BandRow>
          ))}
        </div>
      ) : (
        <Collapsed>{filtering ? "No public trips match this search." : emptyLine}</Collapsed>
      )}
    </Band>
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
  ownGrid,
  followedGrid,
  hasFollowed,
  followed,
  discoverTrips,
  filters,
  todayIso,
  filtering,
  selectedDtId,
  flashDtId,
  chatOpen,
  onPlanTrip,
  onRetry,
  onSignInAgain,
  followedIds,
  followBusyId,
  followError,
  onFollow,
}: {
  trips: TripSummary[] | null;
  error: TripsError | null;
  nextUp: TripSummary | null;
  /** Crew-only grid (owner/editor/viewer) — what "Your trips" renders. */
  ownGrid: TripSummary[] | null;
  /** Role=`follower` rows, split out of the grid — someone else's trips. */
  followedGrid: TripSummary[] | null;
  /** Whether the unfiltered trip list holds a followed trip — the band's
   *  "a filter is hiding them" leg. Derived from `trips`, never from the
   *  filtered grid, so a filter that empties the band still shows it. */
  hasFollowed: boolean;
  followed: FeedEntry[] | null;
  discoverTrips: ShowcaseTrip[] | null;
  /** Search + the Filters door (#249 slice 4, reviewed) — built by the page,
   *  which owns the filter state and the facet counts. */
  filters?: ReactNode;
  todayIso: string;
  filtering: boolean;
  selectedDtId: string | null;
  flashDtId: string | null;
  chatOpen: boolean;
  /** Plan-a-trip: rotate to a fresh landing thread, then open (#351). */
  onPlanTrip: () => void;
  onRetry: () => void;
  onSignInAgain: () => void;
  /** Trips followed in THIS session — the chip's optimistic "Following". */
  followedIds: readonly string[];
  /** The trip whose follow request is in flight, if any. */
  followBusyId: string | null;
  /** A refused follow (a private trip, a network hiccup) — one line, in place. */
  followError: string | null;
  onFollow: (dtId: string) => void;
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
      {/* The agent's generic door lives in the header (the round chat toggle
          beside the account chip, same slot as the in-trip chat), so this
          row stays a plain heading — one generic door plus the Plan-a-trip
          action on Your trips, never two labelled buttons to the same chat. */}
      </div>

      {/* Search + the Filters door sit above the bands and narrow the trip
          bands (feed rows carry no stage, month, origin or visibility, so the
          chips skip them — the text applies). The page owns the state and the
          facet counts; `HomeFilters` owns the two visible controls. */}
      {filters}

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
        // A brand-new account: the invitation to plan stays, but it is no longer
        // the ONLY thing on the page — the discovery shelf below shows what a
        // Kiseki trip looks like, and every public one can be followed on the
        // spot (2026-09-16 review). "No trips yet" with a single button asked a
        // stranger to take the product on faith.
        <>
          <div className="mt-6 rounded-xl border border-border bg-card p-8 text-center">
            <Ticket className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" strokeWidth={1.5} />
            <h3 className="font-heading text-lg font-semibold">No trips yet</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Plan your first journey with the Kiseki assistant — describe the trip you have in
              mind and it will build the booklet for you. Or follow one of the public trips
              below, and its owner's updates land in your feed.
            </p>
            <Button
              onClick={onPlanTrip}
              aria-haspopup="dialog"
              aria-expanded={chatOpen}
              className="mt-5"
            >
              <MessageCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Plan a trip
            </Button>
          </div>
          <DiscoverBand
            trips={discoverTrips}
            filtering={filtering}
            followedIds={followedIds}
            busyId={followBusyId}
            error={followError}
            onFollow={onFollow}
            selectedDtId={selectedDtId}
            flashDtId={flashDtId}
            title="Trips worth a look"
            blurb="Public trips you can follow — their updates land in your feed."
            emptyLine="No public trips to show yet — the shelf fills up as owners publish theirs."
          />
        </>
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
              ownGrid?.length
                ? "Trips you're planning or joining — pick one to open the booklet."
                : undefined
            }
            action={
              /* Creating a trip IS this chat: the agent builds the empty trip
                 and fills it. A permanent action here (not just the empty
                 card's button) keeps creation visible on populated homes —
                 including follow-only ones, where the empty card never renders
                 but this band does (#347). Same link-style action slot the
                 Updates band uses for "Open the feed". */
              <button
                type="button"
                onClick={onPlanTrip}
                aria-haspopup="dialog"
                aria-expanded={chatOpen}
                title="Plan a new trip with the Kiseki assistant"
                className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:focus-ring"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Plan a trip
              </button>
            }
          >
            {ownGrid && ownGrid.length > 0 ? (
              <div className="grid gap-5 sm:grid-cols-2">
                {ownGrid.map((trip) => (
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
                  : "Trips you plan or join will land here."}
              </Collapsed>
            )}
          </Band>

          {/* Someone else's trips you follow (role=`follower`) — never mixed
              into Your trips. Only rendered while it has rows, or while a
              filter is hiding them — so a home with no followed trips never
              sprouts the band, filtering or not. */}
          {followedGrid && (followedGrid.length > 0 || (filtering && hasFollowed)) && (
            <Band
              title="Trips you follow"
              blurb={
                followedGrid.length
                  ? "Trips other people are planning — you read along, they do the work."
                  : undefined
              }
            >
              {followedGrid.length > 0 ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  {followedGrid.map((trip) => (
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
                <Collapsed>No followed trips match this search.</Collapsed>
              )}
            </Band>
          )}

          <Band
            title="Updates"
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

          <DiscoverBand
            trips={discoverTrips}
            filtering={filtering}
            followedIds={followedIds}
            busyId={followBusyId}
            error={followError}
            onFollow={onFollow}
            selectedDtId={selectedDtId}
            flashDtId={flashDtId}
          />
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
    user,
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
  //
  // `half`, on Niko's call (2026-09-16 review): opening on the bands gives more
  // context than the bare map, and he would rather swipe DOWN for the map than
  // UP for his trips. An earlier revision of this branch opened at `peek` to
  // keep every pin clear of the sheet (a −33° pin cannot clear a `half` sheet at
  // any zoom the transform permits — see DESIGN.md §2.2); that trade is his to
  // make and he made it the other way, so the camera stays honest and the sheet
  // opens on the content.
  const [detent, setDetent] = useState<Detent>("half");
  // Global trip map (slice 5): the discoverable layer, default ON with the
  // bands. Mine always shows — another person's trips are what toggles.
  const [showDiscoverPins, setShowDiscoverPins] = useState(true);
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
  // Bumped by every Plan-a-trip open (#351): the popup below is keyed on it,
  // so opening while it is already open still remounts onto the fresh thread.
  const [chatFresh, setChatFresh] = useState(0);
  const [query, setQuery] = useState("");
  const [stages, setStages] = useState<readonly Stage[]>([]);
  // Rich facets (#249 slice 4, reviewed): month/season from startDate,
  // mine⇄following provenance and visibility, all behind the Filters door.
  // "Place" is not a facet of its own — the search box matches the E2 anchor
  // too. Everything is optional and empty by default, so the bands answer the
  // unfiltered home first.
  const [months, setMonths] = useState<readonly number[]>([]);
  const [originSel, setOriginSel] = useState<"all" | "mine" | "following">("all");
  const [vis, setVis] = useState<readonly Visibility[]>([]);

  const userSub = user?.sub ?? null;
  // Fresh-trip detection for the landing chat: the agent creates the empty
  // trip first and fills it over a long turn, but the turn's final text does
  // not always carry the /t/<id> link the popup watches for — so the grid
  // below never refetched and the trip stayed invisible until a hard
  // refresh. A cheap trips-only re-read after every completed landing turn
  // (plus a slow poll while the chat is open, so the skeleton card appears
  // mid-build) closes that gap: any id the grid did not know yet becomes
  // the "Open trip" banner.
  const tripsRef = useRef<TripSummary[] | null>(null);
  tripsRef.current = trips;
  // Set once the landing chat has been opened this visit — a novel trip id
  // is then the agent's doing, not a share landing from elsewhere.
  const chatUsedRef = useRef(false);
  const refreshTrips = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const token = await getAccessTokenSilently();
      const fresh = await fetchMyTrips(token);
      const known = new Set((tripsRef.current ?? []).map((t) => t.dtId));
      const novel = fresh.filter((t) => !known.has(t.dtId));
      setTrips(fresh);
      if (novel.length > 0 && chatUsedRef.current) {
        setCreatedTripId(novel[novel.length - 1].dtId);
      }
    } catch {
      // soft: the grid keeps what it has; the next refresh retries
    }
  }, [isAuthenticated, getAccessTokenSilently]);
  const handleLandingTurnComplete = useCallback(() => {
    chatUsedRef.current = true;
    void refreshTrips();
  }, [refreshTrips]);
  // Plan-a-trip CTAs always start a NEW chat (#351): rotate the landing
  // thread first — the same mechanism as the popup's own New-chat button
  // (persist a fresh id, remount onto it) — then open on it. A second trip
  // idea must never land in the previous planning conversation. The header
  // toggle below keeps the current reopen/continue behaviour.
  const handlePlanTrip = useCallback(() => {
    newThreadId(chatContextKey(), userSub);
    setChatFresh((n) => n + 1);
    chatUsedRef.current = true;
    setChatOpen(true);
  }, [userSub]);
  // Header chat toggle — the trip's chat control in the same slot (round
  // control beside the account chip): the agent's generic door on the
  // signed-in home, so it survives the bands scrolling away (#347). A
  // toggle like its in-trip sibling, not open-only.
  const handleToggleChat = useCallback(() => {
    chatUsedRef.current = true;
    setChatOpen((open) => !open);
  }, []);
  // While the landing chat is open the agent may be building for many
  // minutes: poll the cheap trip list so the new card surfaces mid-build.
  useEffect(() => {
    if (!chatOpen || !isAuthenticated) return;
    const timer = window.setInterval(() => {
      void refreshTrips();
    }, 20000);
    return () => window.clearInterval(timer);
  }, [chatOpen, isAuthenticated, refreshTrips]);
  /** Opening the fresh trip carries the landing thread into its slot, so the
   *  trip drawer continues the planning conversation (same Hermes session:
   *  history intact, a still-running turn attachable) instead of starting a
   *  blank thread that has never heard of the trip. */
  const handleOpenCreatedTrip = useCallback(() => {
    if (!createdTripId) return;
    const landingThread = loadThreadId(chatContextKey(), userSub);
    if (landingThread) adoptThreadId(chatContextKey(createdTripId), landingThread, userSub);
  }, [createdTripId, userSub]);

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
      origins:
        originSel === "all" ? [] : originSel === "mine" ? ["mine"] : (["following", "discover"] as TripOrigin[]),
      visibility: vis,
    }),
    [query, stages, months, originSel, vis],
  );

  // Anchor names by trip, from the E2 read — what the search box matches by
  // place, and what a band card shows as the trip's anchor.
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
              // A followed trip is someone else's: it filters (and bands) as
              // "following", never as one of your own.
              origin: (t.role === "follower" ? "following" : "mine") as TripOrigin,
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
  // "Your trips" is crew only (owner/editor/viewer). Followed trips get their
  // own band below — a trip you follow is not your trip.
  const ownGrid = useMemo(
    () => gridTrips?.filter((t) => t.origin !== "following") ?? null,
    [gridTrips],
  );
  const followedGrid = useMemo(
    () => gridTrips?.filter((t) => t.origin === "following") ?? null,
    [gridTrips],
  );
  // The band's "a filter is hiding them" leg — from the UNFILTERED list, so a
  // filter that empties the band still shows its one-line collapse.
  const hasFollowed = useMemo(
    () => trips?.some((t) => t.role === "follower") ?? false,
    [trips],
  );
  const followed = useMemo(() => {
    if (!feed) return null;
    // Feed rows carry no stage, month, origin or visibility — the facets skip
    // them; the text search applies, over the same fields as before.
    const q = query.trim().toLowerCase();
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
  }, [feed, query]);
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
  // The facet sets the panel offers — only values something can match, so the
  // Filters door never shows a chip that returns an empty list.
  const seasonChips = useMemo(
    () => presentSeasons([...(trips ?? []), ...(discover ?? [])]),
    [trips, discover],
  );
  const visibilityChips = useMemo(
    () =>
      presentVisibilities([
        ...(trips ?? []),
        // Everything on the discover shelf is `public` by construction — the
        // showcase read requires public AND discoverable — so the shelf can
        // only ever contribute that one value.
        ...(discover ?? []).map(() => ({ visibility: "public" as const })),
      ]),
    [trips, discover],
  );
  const facetCount = useMemo(() => activeFacetCount(filter), [filter]);
  // Any active facet steps Up next aside and rewords the empty bands.
  const filtering = useMemo(
    () =>
      query.trim() !== "" ||
      stages.length > 0 ||
      months.length > 0 ||
      originSel !== "all" ||
      vis.length > 0,
    [query, stages, months, originSel, vis],
  );
  const todayIso = useMemo(() => tripTodayIso({}), []);
  // Pins from the E2 read, verbatim — a trip the read did not list gets no
  // pin, and an unlisted pin must never render (the read is the list).
  const pins = useMemo(() => homePinsFromGeo(geo ?? []), [geo]);
  const hasMap = pins.length > 0;
  // The discover layer filters the CANVAS only — the bands keep every trip.
  const mapPins = useMemo(
    () => (showDiscoverPins ? pins : pins.filter((p) => p.origin === "mine")),
    [pins, showDiscoverPins],
  );
  const discoverCount = useMemo(() => pins.filter((p) => p.origin === "discover").length, [pins]);
  const mineCount = pins.length - discoverCount;

  // The selected trip's card: band data when the bands carry it (cover
  // included), the geo row otherwise — pins beyond the showcase cap still
  // open an honest card.
  const selectedTrip: PinCardTrip | null = useMemo(() => {
    if (!selectedDtId) return null;
    const mine = trips?.find((t) => t.dtId === selectedDtId);
    if (mine)
      return {
        dtId: mine.dtId,
        title: mine.title,
        stage: mine.stage,
        cover: mine.cover,
        anchorName: anchorByTrip.get(mine.dtId) ?? null,
      };
    const disc = discover?.find((t) => t.dtId === selectedDtId);
    if (disc)
      return {
        dtId: disc.dtId,
        title: disc.title,
        stage: disc.stage,
        cover: disc.cover,
        anchorName: anchorByTrip.get(disc.dtId) ?? null,
      };
    const pin = pins.find((p) => p.dtId === selectedDtId);
    if (pin) return { dtId: pin.dtId, title: pin.title, stage: pin.stage, anchorName: pin.name };
    return null;
  }, [selectedDtId, trips, discover, pins, anchorByTrip]);

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

  // Follow a public trip from a discovery card (2026-09-16 review). The
  // endpoint shipped with #197 and had NO caller in the UI — a public trip
  // could only be followed by opening it and hunting for the affordance. This
  // is its first home, and the empty home is exactly where it belongs: a
  // visitor with no trips is looking at someone else's.
  const [followedIds, setFollowedIds] = useState<readonly string[]>([]);
  const [followBusyId, setFollowBusyId] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);
  const onFollow = useCallback(
    async (dtId: string) => {
      setFollowBusyId(dtId);
      setFollowError(null);
      try {
        const token = await getAccessTokenSilently();
        await followPublicTrip(dtId, token);
        setFollowedIds((prev) => (prev.includes(dtId) ? prev : [...prev, dtId]));
        // It is one of "your" trips in the API sense now (role=follower), so
        // re-read: the trip leaves the shelf and appears under "Trips you
        // follow" — the feedback IS the move. Same refetch the Retry button
        // uses.
        setAttempt((n) => n + 1);
      } catch (e) {
        // A private trip 403s ("can only be followed with an invite link") —
        // say so where the button is, never swallow it.
        setFollowError(e instanceof Error ? e.message : "Could not follow that trip.");
      } finally {
        setFollowBusyId(null);
      }
    },
    [getAccessTokenSilently],
  );

  // ---------------------------------------------------------------------------
  // EVERY hook in this component lives ABOVE these two returns. The first paint
  // is `authLoading`, and an anonymous visit returns the marketing page — so a
  // hook placed after them renders on the second pass but not the first, and
  // React throws #310 ("Rendered more hooks than during the previous render")
  // the instant auth resolves. That is exactly what v0.58.0 shipped: the four
  // follow hooks sat below this line and the signed-in home crashed for real
  // users while every test passed (the suite starts authenticated, and the
  // `?kiseki_e2e=1` probe seam stubs auth as already resolved — neither ever
  // renders the transition). `LandingPage.test.tsx` → "the auth transition"
  // now pins it.
  // ---------------------------------------------------------------------------
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

  // "Clear all filters" empties the FACETS and deliberately leaves the search
  // text: what you typed is visible, so wiping it silently would surprise.
  const clearFacets = () => {
    setStages([]);
    setMonths([]);
    setOriginSel("all");
    setVis([]);
  };

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
      ownGrid={ownGrid}
      followedGrid={followedGrid}
      hasFollowed={hasFollowed}
      followed={followed}
      discoverTrips={discoverTrips}
      filters={
        <HomeFilters
          query={query}
          onQueryChange={setQuery}
          stageChips={stageChips}
          stages={stages}
          onToggleStage={toggleStage}
          seasonChips={seasonChips}
          months={months}
          onToggleSeason={toggleSeason}
          originSel={originSel}
          onOriginSel={setOriginSel}
          visibilityChips={visibilityChips}
          vis={vis}
          onToggleVisibility={toggleVis}
          activeCount={facetCount}
          onClearAll={clearFacets}
        />
      }
      todayIso={todayIso}
      filtering={filtering}
      selectedDtId={selectedDtId}
      flashDtId={flashDtId}
      chatOpen={chatOpen}
      onPlanTrip={handlePlanTrip}
      onRetry={() => setAttempt((n) => n + 1)}
      onSignInAgain={() =>
        loginWithRedirect({ appState: { returnTo: window.location.pathname } })
      }
      followedIds={followedIds}
      followBusyId={followBusyId}
      followError={followError}
      onFollow={onFollow}
    />
  );

  // Landing header actions: the agent's generic door (round chat toggle, the
  // trip's control in the same slot) beside the account chip. Shared verbatim
  // by both layouts below — the map canvas and the collapsed reading column.
  // Phone arithmetic at 360px: brand ~150 + toggle 44 + account chip ~60 +
  // row gaps/padding ~48 ≈ 302 — the bar keeps its one-line, never-wrapped
  // contract with room to spare.
  const headerActions = (
    <>
      <button
        type="button"
        onClick={handleToggleChat}
        aria-expanded={chatOpen}
        aria-label={chatOpen ? "Close chat" : "Open chat"}
        title="Chat with the Kiseki assistant"
        // The same round control as the back affordance (#239); the open
        // state borrows its geometry and flips the colours — verbatim the
        // in-trip toggle, so the two doors read as one.
        className={chatOpen ? HEADER_CONTROL_ACTIVE : HEADER_CONTROL}
      >
        <MessageCircle className="h-4 w-4" aria-hidden="true" />
      </button>
      <AuthButton />
    </>
  );

  // Landing chat popup (issue #9 / M4 v2): the same floating drawer as the
  // in-trip chat, opened by the header toggle and the Plan-a-trip actions
  // above. No tripId — the assistant answers questions about the user's trips or creates
  // a new one; uploads stage in the user's inbox until the agent promotes them
  // into the new trip. A fresh trip surfaces as an "Open trip" banner while the
  // grid refetches.
  const chat = chatOpen && (
    <ChatPopup
      key={chatFresh}
      onClose={() => setChatOpen(false)}
      onTripCreated={(id) => {
        setCreatedTripId(id);
        // The new trip exists now — refetch so its card appears above.
        setAttempt((n) => n + 1);
      }}
      onTurnComplete={handleLandingTurnComplete}
      label="Kiseki assistant"
      banner={
        createdTripId ? (
          <Link
            to={`/t/${createdTripId}`}
            onClick={handleOpenCreatedTrip}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            Open your new trip
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        ) : undefined
      }
    />
  );

  // Peek line for the phone sheet: one line of "what's next" — and it is a
  // DOOR, not a label (2026-09-16 review): the trip's title opens the trip, so
  // "what's next" costs one tap instead of a trip through the bands below.
  // With no trips of your own there is no "next" — the line points at the
  // discovery pins instead, which is what the canvas is showing.
  const peek =
    nextUp && !filtering ? (
      <>
        Up next:{" "}
        <Link
          to={`/t/${nextUp.dtId}`}
          title={nextUp.title}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:focus-ring"
        >
          {nextUp.title}
        </Link>
        {" — "}
        {upNextLabel(nextUp, todayIso)}
        {/* A live trip's useful destination is TODAY, not its overview — the
            day it is on right now. Same rule as the trip nav's live swap
            (§7.5): while it is happening, "today" is the surface you want. */}
        {nextUp.stage === "live" && (
          <>
            {" · "}
            <Link
              to={`/t/${nextUp.dtId}/today`}
              className="font-medium text-primary underline-offset-2 hover:underline focus-visible:focus-ring"
            >
              Today →
            </Link>
          </>
        )}
      </>
    ) : trips && trips.length === 0 ? (
      <>{pins.length} {pins.length === 1 ? "trip" : "trips"} to discover on the map</>
    ) : (
      <>
        {trips?.length ?? 0} {trips?.length === 1 ? "trip" : "trips"} · {pins.length} on the map
      </>
    );

  // Map canvas (§2.2): the map fills the remainder and the bands move as-is
  // into the rail/sheet furniture. Desktop ≥1280px gets the fixed left rail,
  // phones the full-bleed map behind the three-detent sheet — the ladder owns
  // that, this branch only decides canvas vs. collapsed.
  //
  // The canvas shows whenever there are pins — NOT only when the viewer has
  // trips of their own. A brand-new account whose pins are all discoverable
  // trips gets the map as its discovery surface, with the "No trips yet" card
  // and its Plan-a-trip button in the sheet above it.
  if (hasMap && trips && !error) {
    return (
      <div
        className="flex h-dvh flex-col overflow-hidden"
        onMouseOver={selectFromRow}
        onFocus={selectFromRow}
      >
        <div className="shrink-0">
          <AppHeader actions={headerActions} />
        </div>
        <div className="min-h-0 flex-1">
          <SplitView
            label="Trips on the map"
            header={<p className="truncate text-sm text-muted-foreground">{peek}</p>}
            content={bands}
            detent={detent}
            onDetentChange={setDetent}
            map={(padding) => (
              <div className="relative h-full w-full">
                <HomeMap
                  pins={mapPins}
                  selectedDtId={selectedDtId}
                  onSelect={selectPin}
                  padding={padding}
                />
                {/* Global trip map (slice 5): one pin per discoverable trip, on
                    the SAME canvas — a layer, not a page, so no route changes.
                    Default ON with the bands. Only rendered when both layers
                    are non-empty, so the toggle can never strand the map. */}
                {mineCount > 0 && discoverCount > 0 && (
                  <div className="absolute right-3 top-3 z-10">
                    <button
                      type="button"
                      onClick={() => setShowDiscoverPins((v) => !v)}
                      aria-pressed={showDiscoverPins}
                      aria-label={`Discoverable trips on the map (${discoverCount})`}
                      className="floating flex h-11 items-center gap-2 rounded-full px-4 text-xs font-medium text-foreground transition-colors focus-visible:focus-ring"
                    >
                      <Layers className="h-4 w-4" aria-hidden="true" />
                      Discover · {discoverCount}
                      <span
                        aria-hidden="true"
                        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
                          showDiscoverPins ? "bg-primary" : "bg-muted-foreground/40"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                            showDiscoverPins ? "left-3.5" : "left-0.5"
                          }`}
                        />
                      </span>
                    </button>
                  </div>
                )}
                {/* A pin tap opens the trip card — the preview, never the trip. */}
                {selectedTrip && (
                  <div className="absolute left-1/2 top-3 z-10 w-[min(20rem,calc(100%-1.5rem))] -translate-x-1/2">
                    <TripPinCard trip={selectedTrip} onClose={() => setSelectedDtId(null)} />
                  </div>
                )}
              </div>
            )}
          />
        </div>
        {chat}
      </div>
    );
  }

  // Collapsed map (no geo, or an error): the bands as-is in a reading column —
  // a home with trips is still a home. Note "no trips yet" is NOT a collapse
  // case anymore: with pins the empty home renders on the canvas above, so the
  // discovery map is the empty state's backdrop.
  return (
    <div className="min-h-screen" onMouseOver={selectFromRow} onFocus={selectFromRow}>
      <AppHeader actions={headerActions} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        {bands}
        {chat}
      </main>
    </div>
  );
}
