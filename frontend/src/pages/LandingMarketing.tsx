import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, MapPin } from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { StageBadge } from "../components/ui";
import { fetchShowcase } from "../lib/api";
import { dayCount, formatDate, humanizeDays } from "../lib/dates";
import {
  MARKETING_BOOKLET,
  MARKETING_CLOSING,
  MARKETING_FOOTER,
  MARKETING_HERO,
  MARKETING_INSIDE,
  MARKETING_PRIVACY,
  MARKETING_STEPS,
  MARKETING_TRUST,
  closingShowcaseTrip,
  leadShowcaseTrip,
  sortShowcaseTrips,
} from "../lib/marketing";
import type { ShowcaseTrip } from "../lib/types";

/**
 * The signed-out landing page (#249) — the front door for someone who has never
 * signed in, and the whole of what they see.
 *
 * The redesign (this file's second version) answers a fair complaint: the first
 * version was *organized* but dull. It was a claim, a three-step list, an icon
 * grid and cards — no photograph above the fold, and the display face (Bebas
 * Neue, DESIGN.md §4 "cover titles") never used once, so the page was set
 * entirely in the heading face at small sizes. It used half the system.
 *
 * What changed, and why it is the same brand:
 * - **Photography leads** (§9: "photos carry most of the emotional weight").
 *   The hero is a real trip's cover at full bleed with a scrim, which is the
 *   identical pattern to the trip overview's own cover (`OverviewPage`) —
 *   borrowed from inside the app, not from a consumer travel app.
 * - **The display face is used for what it is for** — one big cover title,
 *   uppercase, tight — and the heading face keeps every other heading.
 * - **The spine is the trip's life** (idea → together → live it and keep it),
 *   not the document: crews, the feed, discovery and print all shipped since
 *   "living document" described the product.
 * - **The icon grid became a definition list.** Six icon-and-sentence columns
 *   is a spec sheet; the same copy as a list beside the booklet spread reads.
 *
 * Deliberately still true, from the first version:
 * - It is a DOCUMENT surface (DESIGN.md §2), not a map surface.
 * - Every word renders with NO network call, which is why the copy is readable
 *   when the graph is not — and why a prerender (a later slice) can put it in
 *   front of a crawler.
 * - The photographic bands read `GET /api/showcase` and COLLAPSE when they have
 *   nothing (no data, no graph, a 500). A stranger must never see an error state
 *   and must never see a private trip: the server filters to public AND
 *   discoverable, and this page never fetches a trip by id.
 * - The sign-in CTA arrives as a node from the page that owns the auth SDK, so
 *   this file stays renderable with no Auth0 context at all.
 */
export function MarketingLanding({
  signIn,
  headerActions,
}: {
  signIn?: ReactNode;
  /**
   * The bar's account chip. Defaults to `AuthButton`; the prerender (E4) passes
   * `null` because it runs in Node, where AuthButton's Auth0 provider does not
   * exist and a rendered chip would be one a no-JS visitor could not use.
   */
  headerActions?: ReactNode;
}) {
  const [trips, setTrips] = useState<ShowcaseTrip[] | null>(null);
  // A cover can 404 (its media object was replaced). The hero is designed to
  // work without a photograph, so a stranger never sees a broken image, and
  // never an empty grey box either.
  const [heroCoverFailed, setHeroCoverFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchShowcase().then((found) => {
      // Guarded so a resolved fetch cannot set state after unmount (the landing
      // is the one page people navigate away from mid-load).
      if (alive) setTrips(sortShowcaseTrips(found));
    });
    return () => {
      alive = false;
    };
  }, []);

  const ordered = trips ?? [];
  const lead = leadShowcaseTrip(ordered);
  const closing = closingShowcaseTrip(ordered, lead);
  const heroCover = lead?.cover && !heroCoverFailed ? lead.cover : null;

  return (
    <div className="min-h-screen">
      <AppHeader actions={headerActions === undefined ? <AuthButton /> : headerActions} />

      <main>
        {/* ---------- The hero: one real trip, at full bleed ---------- */}
        <section className="relative isolate overflow-hidden bg-scrim text-white">
          {heroCover ? (
            <img
              src={heroCover}
              alt=""
              fetchPriority="high"
              onError={() => setHeroCoverFailed(true)}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          {/* §9: a scrim, always — the same gradient the trip overview uses. */}
          <div
            className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/55 to-black/30"
            aria-hidden
          />
          <div className="relative mx-auto flex min-h-[560px] max-w-5xl flex-col justify-end px-6 pb-16 pt-24 sm:min-h-[620px] sm:pb-20">
            <p className="kicker text-white/70">{MARKETING_HERO.kicker}</p>
            <h2 className="mt-4 max-w-[20ch] font-display text-5xl uppercase leading-[0.92] text-balance sm:text-6xl md:text-7xl">
              {MARKETING_HERO.headline}
            </h2>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-white/85">
              {MARKETING_HERO.lede}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {lead ? (
                <Link to={`/t/${lead.dtId}`} className={CTA_PRIMARY}>
                  {MARKETING_HERO.primaryCta}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              ) : (
                // With a trip to open, that IS the hero's action — the sign-in
                // sits in the bar directly above, and two Sign in buttons in one
                // screenful reads as clutter (the first screenshot showed it).
                // With nothing to open, signing in is the only way forward.
                signIn
              )}
              <a href="#how" className={CTA_ON_PHOTO}>
                {MARKETING_HERO.secondaryCta}
              </a>
            </div>
            <p className="mt-6 text-sm text-white/70">{MARKETING_HERO.guestNote}</p>
            <ul className="mt-8 flex flex-wrap gap-x-8 gap-y-2 border-t border-white/20 pt-5 text-[11px] font-medium uppercase tracking-[0.14em] text-white/85">
              {MARKETING_TRUST.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------- The trip's life ---------- */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="border-b border-border px-6 py-16 sm:py-24"
        >
          <div className="mx-auto max-w-5xl">
            <p className="kicker">How it works</p>
            <h2
              id="how-heading"
              className="mt-3 max-w-[24ch] font-heading text-3xl leading-tight sm:text-4xl"
            >
              A trip moves through three stages.
            </h2>
            <ol className="mt-10 grid gap-8 sm:grid-cols-3 sm:gap-10">
              {MARKETING_STEPS.map((step, index) => (
                <li key={step.key}>
                  <p className="font-display text-4xl leading-none tabular-nums text-primary/25">
                    {String(index + 1).padStart(2, "0")}
                  </p>
                  <p className="mt-3 font-heading text-xl leading-tight">{step.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------- Real trips, as photographs ---------- */}
        {ordered.length > 0 ? (
          <section
            id="trips"
            aria-labelledby="trips-heading"
            className="border-b border-border px-6 py-16 sm:py-24"
          >
            <div className="mx-auto max-w-6xl">
              <p className="kicker">Real trips</p>
              <h2
                id="trips-heading"
                className="mt-3 max-w-[24ch] font-heading text-3xl leading-tight sm:text-4xl"
              >
                Being planned right now.
              </h2>
              <p className="mt-4 max-w-2xl text-muted-foreground">
                Live trips from Kiseki, in the state they are really in. A public
                trip opens without an account.
              </p>
              <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {ordered.map((trip) => (
                  <TripPanel key={trip.dtId} trip={trip} />
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {/* ---------- The booklet ---------- */}
        <section
          id="booklet"
          aria-labelledby="booklet-heading"
          className="border-b border-border px-6 py-16 sm:py-24"
        >
          <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-center md:gap-16">
            <BookletCover trip={lead} />
            <div>
              <p className="kicker">{MARKETING_BOOKLET.kicker}</p>
              <h2
                id="booklet-heading"
                className="mt-3 max-w-[24ch] font-heading text-3xl leading-tight sm:text-4xl"
              >
                {MARKETING_BOOKLET.title}
              </h2>
              <p className="mt-4 max-w-2xl text-muted-foreground">{MARKETING_BOOKLET.body}</p>
              <p className="kicker mt-12">{MARKETING_INSIDE.kicker}</p>
              <h3 className="mt-3 max-w-[24ch] font-heading text-2xl leading-tight">
                {MARKETING_INSIDE.title}
              </h3>
              <dl className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2">
                {MARKETING_INSIDE.items.map((item) => (
                  <div key={item.key}>
                    <dt className="font-medium">{item.title}</dt>
                    <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {item.body}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* ---------- Privacy ---------- */}
        <section
          id="privacy"
          aria-labelledby="privacy-heading"
          className="bg-foreground px-6 py-16 text-background sm:py-24"
        >
          <div className="mx-auto max-w-5xl">
            <p className="kicker text-background/60">{MARKETING_PRIVACY.kicker}</p>
            <h2
              id="privacy-heading"
              className="mt-3 max-w-[24ch] font-heading text-3xl leading-tight sm:text-4xl"
            >
              {MARKETING_PRIVACY.title}
            </h2>
            <div className="mt-10 grid gap-8 sm:grid-cols-3">
              {MARKETING_PRIVACY.points.map((point) => (
                <div key={point.key}>
                  <p className="font-heading text-lg">{point.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-background/75">{point.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- Closing: a second trip, not the same photo twice ---------- */}
        <section
          aria-labelledby="start-heading"
          className="relative isolate overflow-hidden bg-scrim text-white"
        >
          {closing?.cover ? (
            <img
              src={closing.cover}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          <div
            className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/60 to-black/35"
            aria-hidden
          />
          <div className="relative mx-auto flex min-h-[420px] max-w-4xl flex-col items-center justify-center px-6 py-20 text-center">
            <h2
              id="start-heading"
              className="max-w-[26ch] font-display text-4xl uppercase leading-[0.95] text-balance sm:text-5xl"
            >
              {MARKETING_CLOSING.title}
            </h2>
            <p className="mt-4 max-w-xl text-white/85">{MARKETING_CLOSING.body}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              {signIn}
              {lead ? (
                <Link to={`/t/${lead.dtId}`} className={CTA_ON_PHOTO}>
                  {MARKETING_HERO.primaryCta}
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>{MARKETING_FOOTER.left}</p>
          <p>{MARKETING_FOOTER.right}</p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- the bands ---------- */

/**
 * Buttons that navigate carry the same vocabulary as `ui.Button` on an anchor —
 * there is no `asChild`, and a trip link is a route, not a `<button>`.
 */
const CTA_PRIMARY =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:focus-ring";
const CTA_ON_PHOTO =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-white/45 px-5 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:focus-ring";

/** "Feb 15, 2027 – Mar 2, 2027 · 2 weeks", or just what is known. */
function dateLine(trip: ShowcaseTrip): string | null {
  if (!trip.startDate) return null;
  const start = formatDate(trip.startDate);
  const range = trip.endDate ? `${start} – ${formatDate(trip.endDate)}` : start;
  const days = dayCount(trip.startDate, trip.endDate ?? undefined);
  const span = days && days > 1 ? humanizeDays(days) : null;
  return span ? `${range} · ${span}` : range;
}

/** "16 days" — the numeral the booklet prints, not a humanised span. */
function dayLabel(trip: ShowcaseTrip | null): string | null {
  if (!trip?.startDate) return null;
  const days = dayCount(trip.startDate, trip.endDate ?? undefined);
  if (!days) return null;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function TripPanel({ trip }: { trip: ShowcaseTrip }) {
  // A cover can 404 (the media object was replaced). A landing page falls back
  // to a mark; it never shows a broken image to a stranger.
  const [coverFailed, setCoverFailed] = useState(false);
  const dates = dateLine(trip);
  return (
    <Link
      to={`/t/${trip.dtId}`}
      className="group overflow-hidden rounded-xl border border-border bg-card focus-visible:focus-ring"
    >
      <div className="relative aspect-[16/10] bg-muted">
        {trip.cover && !coverFailed ? (
          <img
            src={trip.cover}
            alt=""
            loading="lazy"
            onError={() => setCoverFailed(true)}
            className="h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <MapPin className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
        )}
        <div className="scrim absolute inset-0" aria-hidden />
        <div className="absolute inset-x-4 bottom-4">
          <StageBadge stage={trip.stage} className="text-foreground" />
          <p className="mt-2 font-heading text-xl leading-tight text-white">{trip.title}</p>
          {dates ? <p className="mt-1 text-xs tabular-nums text-white/80">{dates}</p> : null}
        </div>
      </div>
      {trip.subtitle ? (
        <p className="p-4 text-sm text-muted-foreground">{trip.subtitle}</p>
      ) : null}
    </Link>
  );
}

/**
 * The booklet's first page, built from the lead trip the same way the real
 * booklet is (cover photo + title + day count) — the print artifact is the one
 * thing a consumer travel app cannot answer (DESIGN.md §1, §12). With no trip
 * to show it is still a page: the panel keeps its paper, not a grey box.
 */
function BookletCover({ trip }: { trip: ShowcaseTrip | null }) {
  const days = dayLabel(trip);
  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-card shadow-card">
        {trip?.cover ? (
          <img
            src={trip.cover}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <div
          className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/15"
          aria-hidden
        />
        <div className="relative flex h-full flex-col justify-end p-5">
          <p className="kicker text-white/70">Day 1</p>
          <p className="mt-2 font-display text-3xl uppercase leading-[0.95] text-white">
            {trip?.title ?? "Your trip"}
          </p>
          {days ? (
            <p className="mt-2 text-[11px] uppercase tracking-[0.14em] tabular-nums text-white/75">
              {days}
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        The booklet's cover
      </p>
    </div>
  );
}
