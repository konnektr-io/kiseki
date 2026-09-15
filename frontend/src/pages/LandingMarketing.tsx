import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Map as MapIcon,
  MapPin,
  MessageCircle,
  Palette,
  Printer,
  RefreshCw,
  Users,
} from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { StageBadge } from "../components/ui";
import { fetchShowcase } from "../lib/api";
import { dayCount, formatDate, humanizeDays } from "../lib/dates";
import {
  MARKETING_FEATURES,
  MARKETING_STEPS,
  sortShowcaseTrips,
} from "../lib/marketing";
import type { ShowcaseTrip } from "../lib/types";

/**
 * The signed-out landing page (#249) — the front door for someone who has
 * never signed in, and the whole of what they see.
 *
 * Design constraints that shaped it:
 * - It is a DOCUMENT surface (DESIGN.md §2), not a map surface: a reading
 *   column, generous whitespace, no widgets.
 * - The copy is static and the examples are not. Every word here renders
 *   without a network call, which is why the claim, the steps and the features
 *   are readable even when the graph is not — and why a prerender (a later
 *   slice) can put all of it in front of a crawler.
 * - The examples band reads `GET /api/showcase` and COLLAPSES when it has
 *   nothing (no data, no graph, a 500). A stranger must never see an error
 *   state, and must never see a private trip: the server filters to public AND
 *   discoverable, and this page never fetches a trip by id.
 * - The sign-in CTA arrives as a node from the page that owns the auth SDK, so
 *   this file stays renderable with no Auth0 context at all.
 */
export function MarketingLanding({ signIn }: { signIn?: ReactNode }) {
  const [examples, setExamples] = useState<ShowcaseTrip[] | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchShowcase().then((trips) => {
      // Guarded so a resolved fetch cannot set state after unmount (the
      // landing is the one page people navigate away from mid-load).
      if (alive) setExamples(sortShowcaseTrips(trips));
    });
    return () => {
      alive = false;
    };
  }, []);

  const hasExamples = (examples?.length ?? 0) > 0;

  return (
    <div className="min-h-screen">
      <AppHeader actions={<AuthButton />} />

      <main>
        {/* ---------- The claim ---------- */}
        <section className="border-b border-border px-6 pb-14 pt-12 sm:pb-20 sm:pt-16">
          <div className="mx-auto max-w-3xl">
            <p className="kicker">Living trip documents</p>
            <h2 className="mt-3 font-heading text-4xl leading-[0.95] text-balance sm:text-6xl">
              The trip as a living document.
            </h2>
            <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
              Kiseki turns a journey into a booklet that stays true: an itinerary
              you can read, the whole route on one map, the practicals, and the
              people you are going with. Plan it with the assistant before you
              leave — it keeps up while you are there.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {signIn}
              <a
                href="#how"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-medium text-foreground focus-visible:focus-ring"
              >
                See how it works
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            </div>
            <p className="mt-6 border-l-2 border-border pl-4 text-sm text-muted-foreground">
              Sent a trip link? Open it — reading a trip needs no account.
            </p>
          </div>
        </section>

        {/* ---------- How it works ---------- */}
        <section
          id="how"
          aria-labelledby="how-heading"
          className="border-b border-border px-6 py-14 sm:py-20"
        >
          <div className="mx-auto max-w-3xl">
            <p className="kicker">From an idea to a plan</p>
            <h2 id="how-heading" className="mt-3 font-heading text-3xl sm:text-4xl">
              Three steps, no forms.
            </h2>
            <ol className="mt-8 space-y-6">
              {MARKETING_STEPS.map((step, index) => {
                const Icon = STEP_ICONS[step.key] ?? MessageCircle;
                return (
                  <li key={step.key} className="flex gap-4">
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                      <Icon className="h-4 w-4 text-primary" aria-hidden />
                    </div>
                    <div>
                      <p className="font-medium">
                        <span className="text-muted-foreground">
                          {String(index + 1).padStart(2, "0")} ·{" "}
                        </span>
                        {step.title}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        {/* ---------- Real trips ---------- */}
        {hasExamples ? (
          <section
            id="examples"
            aria-labelledby="examples-heading"
            className="border-b border-border px-6 py-14 sm:py-20"
          >
            <div className="mx-auto max-w-5xl">
              <p className="kicker">Real trips</p>
              <h2 id="examples-heading" className="mt-3 font-heading text-3xl sm:text-4xl">
                Already being planned.
              </h2>
              <p className="mt-4 max-w-2xl text-muted-foreground">
                Live trips from Kiseki, in the state they are really in. Open one:
                a public trip reads without an account.
              </p>
              <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {(examples ?? []).map((trip) => (
                  <ShowcaseCard key={trip.dtId} trip={trip} />
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {/* ---------- What you get ---------- */}
        <section
          id="what"
          aria-labelledby="what-heading"
          className="border-b border-border px-6 py-14 sm:py-20"
        >
          <div className="mx-auto max-w-5xl">
            <p className="kicker">What is in it</p>
            <h2 id="what-heading" className="mt-3 font-heading text-3xl sm:text-4xl">
              One document, the whole trip.
            </h2>
            <div className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
              {MARKETING_FEATURES.map((feature) => {
                const Icon = FEATURE_ICONS[feature.key] ?? BookOpen;
                return (
                  <div key={feature.key}>
                    <Icon className="h-5 w-5 text-primary" aria-hidden />
                    <p className="mt-3 font-medium">{feature.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{feature.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---------- Closing ---------- */}
        <section aria-labelledby="start-heading" className="px-6 py-14 sm:py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h2 id="start-heading" className="font-heading text-3xl sm:text-4xl">
              Start with the trip you are already planning.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
              Describe it once and let the document build itself while the plans
              firm up.
            </p>
            {signIn ? <div className="mt-7 flex justify-center">{signIn}</div> : null}
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>Kiseki 軌跡 — living trip documents</p>
          <p>Printed as a booklet. Alive as a page.</p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- the examples ---------- */

const STEP_ICONS: Record<string, typeof MessageCircle> = {
  describe: MessageCircle,
  build: BookOpen,
  alive: RefreshCw,
};

const FEATURE_ICONS: Record<string, typeof MessageCircle> = {
  booklet: Printer,
  map: MapIcon,
  crew: Users,
  identity: Palette,
  assistant: MessageCircle,
  feed: Activity,
};

/** "Feb 15, 2027 – Mar 2, 2027 · 16 days", or just what is known. */
function dateLine(trip: ShowcaseTrip): string | null {
  if (!trip.startDate) return null;
  const start = formatDate(trip.startDate);
  const range = trip.endDate ? `${start} – ${formatDate(trip.endDate)}` : start;
  const days = dayCount(trip.startDate, trip.endDate ?? undefined);
  const span = days && days > 1 ? humanizeDays(days) : null;
  return span ? `${range} · ${span}` : range;
}

function ShowcaseCard({ trip }: { trip: ShowcaseTrip }) {
  // A cover can 404 (the media object was replaced). A landing page falls back
  // to a placeholder; it never shows a broken image to a stranger.
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
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <MapPin className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
        )}
        <div className="scrim absolute inset-0" aria-hidden />
        <div className="absolute inset-x-3 bottom-3">
          <StageBadge stage={trip.stage} />
        </div>
      </div>
      <div className="space-y-1 p-4">
        <p className="font-heading text-xl leading-tight">{trip.title}</p>
        {trip.subtitle ? (
          <p className="text-sm text-muted-foreground">{trip.subtitle}</p>
        ) : null}
        {dates ? <p className="text-xs text-muted-foreground">{dates}</p> : null}
      </div>
    </Link>
  );
}
