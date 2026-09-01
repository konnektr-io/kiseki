import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, CalendarDays, ChevronDown, MapPin, Users } from "lucide-react";
import { useTrip } from "../components/theme";
import { Button, Card, Separator, StageBadge } from "../components/ui";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";
import { TripMap } from "../components/MapView";
import { locatedPlaces } from "../lib/maps";
import type { Feature } from "../lib/types";

function FeatureCard({ feature: f }: { feature: Feature }) {
  const trip = useTrip();
  const [open, setOpen] = useState(false);
  const all = locatedPlaces(trip);
  return (
    <Card className="overflow-hidden p-5">
      <p className="kicker mb-1">{f.kicker || "Feature"}</p>
      <h3 className="font-heading text-xl font-semibold uppercase leading-tight tracking-wide text-foreground">
        {f.title}
      </h3>

      {f.map && all.length >= 2 ? (
        <div className="mt-3 print:hidden">
          <TripMap places={all.map((l) => l.name)} loop />
        </div>
      ) : f.images && f.images.length > 1 ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {f.images.map((src) => (
            <img key={src} src={src} alt={f.title} className="h-40 w-full rounded-lg border border-border object-cover" />
          ))}
        </div>
      ) : f.image && !f.map ? (
        <img src={f.image} alt={f.title} className="mt-3 max-h-64 w-full rounded-lg border border-border object-cover" />
      ) : null}

      {f.chips?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {f.chips.map((c) => (
            <span
              key={c}
              className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </div>
      ) : null}

      {f.description && (
        <div className="mt-3 text-sm leading-relaxed md:text-[15px]">
          <Markdown>{f.description}</Markdown>
        </div>
      )}

      {/* cards: grid on desktop; expandable on mobile (images always shown) */}
      {f.cards && f.cards.length > 0 && (
        <>
          <div className="mt-3 hidden grid-cols-2 gap-3 md:grid md:grid-cols-4">
            {f.cards.map((c) => (
              <div key={c.title} className="overflow-hidden rounded-lg border border-border">
                {c.image && <img src={c.image} alt={c.title} className="h-24 w-full object-cover" />}
                <div className="p-2.5">
                  <p className="font-heading text-sm font-semibold uppercase leading-tight">{c.title}</p>
                  {c.value && <p className="text-xs font-semibold text-accent">{c.value}</p>}
                  {c.description && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.description}</p>}
                  {c.links?.map((l) => (
                    <a
                      key={l.url}
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-accent underline underline-offset-2"
                    >
                      {l.label}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="auto"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="mt-3 flex w-full items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5 md:hidden"
          >
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {open ? "Hide details" : `Show details (${f.cards.length})`}
            </span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
          {open && (
            <div className="mt-2 space-y-2.5 md:hidden">
              {f.cards.map((c) => (
                <div key={c.title} className="overflow-hidden rounded-lg border border-border">
                  {c.image && <img src={c.image} alt={c.title} className="h-28 w-full object-cover" />}
                  <div className="p-2.5">
                    <p className="font-heading text-sm font-semibold uppercase leading-tight">{c.title}</p>
                    {c.value && <p className="text-xs font-semibold text-accent">{c.value}</p>}
                    {c.description && <p className="mt-1 text-xs leading-snug text-muted-foreground">{c.description}</p>}
                    {c.links?.map((l) => (
                      <a
                        key={l.url}
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-accent underline underline-offset-2"
                      >
                        {l.label}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {f.links?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {f.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-primary hover:bg-primary/20"
            >
              {l.label} <ArrowRight className="h-3 w-3" />
            </a>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function OverviewPage() {
  const trip = useTrip();
  const { token } = useParams();
  const doneTodos = (trip.practical.todos ?? []).filter((t) => t.done).length;
  const totalTodos = (trip.practical.todos ?? []).length;

  return (
    <div className="space-y-6">
      {/* hero */}
      <div className="relative overflow-hidden rounded-2xl">
        {trip.cover && (
          <img src={trip.cover} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-black/20" />
        <div className="relative flex min-h-[280px] flex-col justify-end p-5 md:min-h-[360px] md:p-8">
          <div className="flex flex-wrap items-center gap-2">
            {/* the floating recipe is StageBadge's own now — only the text
                colour needs forcing against the cover photo */}
            <StageBadge stage={trip.stage} className="text-foreground" />
            <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-white/80">
              <CalendarDays className="h-3.5 w-3.5" />
              {trip.startDate && formatDay(trip.startDate)} → {trip.endDate && formatDay(trip.endDate)}
              {trip.days.length > 0 && ` · ${trip.days.length} days`}
            </span>
          </div>
          <h1 className="mt-3 font-display text-5xl uppercase leading-[0.95] text-white md:text-7xl">
            {trip.title}
          </h1>
          {trip.subtitle && (
            <p className="mt-2 max-w-xl text-sm font-medium uppercase tracking-wide text-white/85 md:text-base">
              {trip.subtitle}
            </p>
          )}
          {trip.coverCredit && <p className="mt-3 text-[10px] uppercase tracking-widest text-white/50">© {trip.coverCredit}</p>}
        </div>
      </div>

      {/* at a glance */}
      {trip.stats?.length ? (
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-6">
          {trip.stats.map((s) => (
            <div key={s.label} className="bg-card px-3 py-4 text-center">
              <p className="font-display text-3xl leading-none tracking-wide tabular-nums text-foreground md:text-4xl">
                {s.value}
              </p>
              <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {s.label}
              </p>
              <span className="mx-auto mt-2 block h-0.5 w-6 rounded-full bg-accent/60" />
            </div>
          ))}
        </div>
      ) : null}

      {/* features — editorial cards (centerpiece / road trip) */}
      {trip.features && trip.features.length > 0 && (
        <div className="space-y-5">
          {trip.features.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </div>
      )}

      {/* summary */}
      {trip.summary && (
        <Card className="p-5">
          <p className="kicker mb-2">The trip</p>
          <div className="text-[15px] leading-relaxed">
            <Markdown>{trip.summary}</Markdown>
          </div>
        </Card>
      )}

      {/* sections strip */}
      {trip.sections?.length ? (
        <Card className="p-5">
          <p className="kicker mb-3">The loop</p>
          <ol className="space-y-2">
            {trip.sections.map((s, i) => (
              <li key={i} className="flex items-baseline gap-3">
                <span className="font-display text-2xl leading-none tabular-nums text-primary/70">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <Link
                  to={`/t/${token}/itinerary`}
                  className="font-heading text-base font-medium text-foreground hover:text-primary"
                >
                  {s.title}
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {/* crew */}
      {trip.crew.length > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="kicker">The crew</p>
            <Link
              to={`/t/${token}/crew`}
              className="no-print inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <ul className="space-y-2.5">
            {trip.crew.map((p) => (
              <li key={p.name} className="flex items-center gap-3">
                <span className="inline-flex aspect-square h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-heading text-sm font-semibold text-primary">
                  {p.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                </span>
                <div className="min-w-0">
                  <p className="font-heading text-sm font-semibold">{p.name}</p>
                  {p.note && <p className="truncate text-xs text-muted-foreground">{p.note}</p>}
                </div>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Users className="h-3 w-3" /> {p.role}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* practical preview */}
      {(totalTodos > 0 || trip.practical.links?.length) && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <p className="kicker">Practical</p>
            <Link to={`/t/${token}/practical`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
              Full list <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {totalTodos > 0 && (
            <>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${Math.round((doneTodos / totalTodos) * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">
                {doneTodos}/{totalTodos} done
              </p>
            </>
          )}
          {trip.practical.links?.length ? (
            <ul className="mt-3 space-y-1">
              {trip.practical.links.slice(0, 4).map((l) => (
                <li key={l.url} className="flex items-center gap-2 text-sm">
                  <MapPin className="h-3 w-3 text-muted-foreground" />
                  <a href={l.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <Separator className="my-4" />
          {trip.practical.notes && (
            <div className="text-sm leading-relaxed text-muted-foreground">
              <Markdown>{trip.practical.notes}</Markdown>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
