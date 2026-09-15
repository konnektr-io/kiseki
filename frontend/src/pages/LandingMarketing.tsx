import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { StageBadge } from "../components/ui";
import {
  MARKETING_BOOKLET,
  MARKETING_CLOSING,
  MARKETING_DEMO,
  MARKETING_FOOTER,
  MARKETING_HERO,
  MARKETING_INSIDE,
  MARKETING_PRIVACY,
  MARKETING_STEPS,
  MARKETING_TRUST,
} from "../lib/marketing";

/**
 * The signed-out landing page (#249).
 *
 * Three revisions in, and this one is the honest one. v1 was a claim, a step list,
 * an icon grid and cards — organised but dull, with no photograph above the fold
 * and the display face unused. v2 fixed that with photography and the poster voice,
 * but it illustrated itself with the owner's REAL trips: the hero was one trip's
 * cover, the cards linked into them, and a stranger following a link landed on
 * booking codes, costs and the crew's checklist. Public is not the same as "fine to
 * advertise from a landing page".
 *
 * So the page now shows an invented example, and therefore:
 *
 * - **It makes no network call at all.** No showcase read, no trip read, no trip
 *   link, no trip id — which also means it cannot degrade: there is no empty state,
 *   no failure state and nothing to be missing. The prerender (`scripts/prerender.mjs`)
 *   therefore carries the whole page, not just the copy.
 * - **The crew's paperwork cannot leak through it**, because no real trip's content
 *   is in it. The example's booking chip says "confirmation on file" and carries no
 *   code: the feature, without anyone's reference.
 * - **Print is demoted.** The booklet is one stage, one band and one entry in
 *   "what is inside" — the headline is about planning and living the trip.
 *
 * The sign-in CTA still arrives as a node from the page that owns the auth SDK, so
 * this file renders with no Auth0 context (and the prerender passes `null`).
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
  return (
    <div className="min-h-screen">
      <AppHeader actions={headerActions === undefined ? <AuthButton /> : headerActions} />

      <main>
        {/* ---------- The hero ---------- */}
        <section className="relative isolate overflow-hidden bg-scrim text-white">
          <img
            src="/marketing/hero.jpg"
            alt=""
            fetchPriority="high"
            className="absolute inset-0 h-full w-full object-cover"
          />
          {/* §9: a scrim, always — the same gradient the trip overview uses. */}
          <div
            className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/55 to-black/30"
            aria-hidden
          />
          <div className="relative mx-auto flex min-h-[560px] max-w-5xl flex-col justify-end px-6 pb-16 pt-24 sm:min-h-[620px] sm:pb-20">
            <p className="kicker text-white/70">{MARKETING_HERO.kicker}</p>
            <h2 className="mt-4 max-w-[18ch] font-display text-5xl uppercase leading-[0.92] text-balance sm:text-6xl md:text-7xl">
              {MARKETING_HERO.headline}
            </h2>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-white/85">
              {MARKETING_HERO.lede}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {/* ONE action, and not a second Sign in: the bar above already carries
                  that, and two of them in one screenful reads as clutter (caught in
                  review on the previous revision). Showing the product is the
                  hero's job; signing in is the bar's. */}
              <a href="#demo" className={CTA_PRIMARY}>
                {MARKETING_HERO.secondaryCta}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            </div>
            <p className="mt-6 text-sm text-white/70">{MARKETING_HERO.guestNote}</p>
            {/* The house accent rule (the same detail the trip's stat strip uses)
                instead of a full-width hairline, which read as an unanchored divider
                over a photograph. */}
            <span className="mt-8 block h-0.5 w-8 rounded-full bg-accent" aria-hidden />
            <ul className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-[11px] font-medium uppercase tracking-[0.14em] text-white/85">
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

        {/* ---------- The example ---------- */}
        <section
          id="demo"
          aria-labelledby="demo-heading"
          className="border-b border-border px-6 py-16 sm:py-24"
        >
          <div className="mx-auto max-w-6xl">
            <p className="kicker">{MARKETING_DEMO.kicker}</p>
            <h2
              id="demo-heading"
              className="mt-3 max-w-[24ch] font-heading text-3xl leading-tight sm:text-4xl"
            >
              {MARKETING_DEMO.title}
            </h2>
            <p className="mt-4 max-w-2xl text-muted-foreground">{MARKETING_DEMO.caption}</p>

            <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              {/* the day */}
              <article className="overflow-hidden rounded-xl border border-border bg-card">
                <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border p-5">
                  <div>
                    <p className="font-heading text-lg leading-tight">
                      {MARKETING_DEMO.trip.title}
                    </p>
                    <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                      {MARKETING_DEMO.trip.meta}
                    </p>
                  </div>
                  <StageBadge stage={MARKETING_DEMO.trip.stage} />
                </header>

                <div className="border-b border-border px-5 py-4">
                  <p className="kicker">{MARKETING_DEMO.day.label}</p>
                  <p className="mt-1.5 font-heading text-xl leading-tight">
                    {MARKETING_DEMO.day.title}
                  </p>
                </div>

                <ul className="divide-y divide-border">
                  {MARKETING_DEMO.day.rows.map((row) => (
                    <li key={row.title} className="p-5">
                      <div className="flex gap-4">
                        <p className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                          {row.time}
                        </p>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                            {row.kind}
                          </p>
                          <p className="mt-1 font-heading text-lg leading-tight">{row.title}</p>
                          {row.body ? (
                            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                              {row.body}
                            </p>
                          ) : null}
                          {row.chip ? (
                            <p className="mt-3 inline-flex items-center rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                              {row.chip}
                            </p>
                          ) : null}
                          {row.photo ? (
                            <div className="relative mt-3 aspect-[16/10] overflow-hidden rounded-lg bg-muted">
                              <img
                                src={row.photo.src}
                                alt={row.photo.alt}
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>

              {/* the rest of the trip */}
              <div className="space-y-6">
                <div className="rounded-xl border border-border bg-card p-5">
                  <p className="kicker">{MARKETING_DEMO.route.label}</p>
                  <p className="mt-2 font-heading text-lg leading-tight">
                    {MARKETING_DEMO.route.title}
                  </p>
                  <ExampleRouteMap />
                  <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                    {MARKETING_DEMO.route.stops.map((stop, index) => (
                      <li key={stop} className="inline-flex items-center gap-1.5">
                        <span className="inline-grid h-5 w-5 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">
                          {index + 1}
                        </span>
                        {stop}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {MARKETING_DEMO.route.body}
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-card p-5">
                  <p className="kicker">{MARKETING_DEMO.crew.label}</p>
                  <div className="mt-3 flex items-center gap-2">
                    {MARKETING_DEMO.crew.initials.map((initial) => (
                      <span
                        key={initial}
                        aria-hidden
                        className="inline-grid h-8 w-8 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
                      >
                        {initial}
                      </span>
                    ))}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {MARKETING_DEMO.crew.note}
                  </p>
                </div>

                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <div className="relative aspect-[16/10] bg-muted">
                    <img
                      src={MARKETING_DEMO.note.src}
                      alt={MARKETING_DEMO.note.alt}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <p className="p-5 text-sm leading-relaxed text-muted-foreground">
                    {MARKETING_DEMO.note.text}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- The booklet, and what is inside ---------- */}
        <section
          id="booklet"
          aria-labelledby="booklet-heading"
          className="border-b border-border px-6 py-16 sm:py-24"
        >
          <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-center md:gap-16">
            {/* On a tinted panel: bare on white the spread had nothing holding it, so
                the band read as the weakest on the page. */}
            <div className="rounded-xl bg-muted p-6 sm:p-8">
              <div className="relative mx-auto aspect-[3/4] w-full max-w-xs overflow-hidden rounded-lg border border-border bg-card shadow-card">
                <img
                  src="/marketing/day-rain.jpg"
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div
                  className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/15"
                  aria-hidden
                />
                <div className="relative flex h-full flex-col justify-end p-5">
                  <p className="kicker text-white/70">Day 1</p>
                  <p className="mt-2 font-display text-3xl uppercase leading-[0.95] text-white">
                    Nine days in Tokyo
                  </p>
                  <p className="mt-2 text-[11px] uppercase tracking-[0.14em] tabular-nums text-white/75">
                    9 days
                  </p>
                </div>
              </div>
            </div>
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
            <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {MARKETING_PRIVACY.points.map((point) => (
                <div key={point.key}>
                  <p className="font-heading text-lg">{point.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-background/75">{point.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- Closing ---------- */}
        <section
          aria-labelledby="start-heading"
          className="relative isolate overflow-hidden bg-scrim text-white"
        >
          <img
            src="/marketing/closing.jpg"
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
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
            {/* Rendered only when the page was given a CTA: the prerender has none
                (AuthButton needs the browser), and an empty flex box would ship as
                dead markup in the crawlable shell. */}
            {signIn ? (
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{signIn}</div>
            ) : null}
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
 * there is no `asChild`, and these are anchors, not `<button>`s.
 */
/** The hero's one action, and the closing band's, in the `ui.Button` vocabulary. */
const CTA_PRIMARY =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:focus-ring";

/**
 * The example's map, drawn rather than photographed.
 *
 * Deliberately not a real route-map image: the one a real trip carries is built on
 * Google Maps tiles, so it is neither ours to license for a public page nor
 * fictional — and a "fake trip" illustrated with somebody's actual route would be
 * the same mistake this revision is fixing, one level down. A drawn line is
 * honest, carries no data, and is on-brand for a cartographic product.
 */
function ExampleRouteMap() {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border bg-muted">
      <svg
        viewBox="0 0 360 200"
        role="img"
        aria-label="An example route drawn as a dashed line through five numbered stops"
        className="h-auto w-full"
      >
        {/* land shapes — a schematic hint, not a map of anywhere */}
        <path d="M0 150 L70 120 L140 138 L210 104 L280 126 L360 96 L360 200 L0 200 Z" className="fill-border" />
        <path d="M0 60 L60 40 L130 66 L190 34 L250 58 L320 30 L360 44 L360 0 L0 0 Z" className="fill-border/60" />
        {/* the route */}
        <path
          d="M48 150 C96 118, 120 92, 168 96 S244 130, 292 74"
          fill="none"
          strokeWidth="2.5"
          strokeDasharray="7 5"
          className="stroke-primary"
        />
        {[
          { x: 48, y: 150, n: 1 },
          { x: 112, y: 104, n: 2 },
          { x: 186, y: 96, n: 3 },
          { x: 248, y: 118, n: 4 },
          { x: 292, y: 74, n: 5 },
        ].map((pin) => (
          <g key={pin.n}>
            <circle cx={pin.x} cy={pin.y} r="9" className="fill-card stroke-primary" strokeWidth="2" />
            <text
              x={pin.x}
              y={pin.y + 3.5}
              textAnchor="middle"
              className="fill-primary text-[9px] font-semibold tabular-nums"
            >
              {pin.n}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
