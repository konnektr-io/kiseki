import { Link } from "react-router-dom";
import { ArrowRight, CalendarDays, MapPin, Users } from "lucide-react";
import { useTrip } from "../components/theme";
import { Card, Separator, StageBadge } from "../components/ui";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";

export function OverviewPage() {
  const trip = useTrip();
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
            <StageBadge stage={trip.stage} />
            <span className="inline-flex items-center gap-1 text-xs font-medium text-white/80">
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
            <div key={s.label} className="bg-card px-3 py-3 text-center">
              <p className="font-display text-2xl leading-none text-foreground md:text-3xl">{s.value}</p>
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* overview map */}
      {trip.map && (
        <img src={trip.map} alt="Route overview" className="w-full rounded-xl border border-border shadow-sm" />
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
                <span className="font-display text-2xl leading-none text-primary/70">{String(i + 1).padStart(2, "0")}</span>
                <Link
                  to={`/t/${trip.token}/itinerary`}
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
          <p className="kicker mb-3">The crew</p>
          <ul className="space-y-2.5">
            {trip.crew.map((p) => (
              <li key={p.name} className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 font-heading text-sm font-semibold text-primary">
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
            <Link to={`/t/${trip.token}/practical`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
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
              <p className="mt-1.5 text-xs text-muted-foreground">
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
