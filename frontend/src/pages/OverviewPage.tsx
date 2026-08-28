import { Link } from "react-router-dom";
import { ArrowRight, CalendarDays, MapPin, Users } from "lucide-react";
import { useTrip } from "../components/theme";
import { Card, Separator, StageBadge } from "../components/ui";
import { Markdown } from "../lib/markdown";
import { dayCount, formatDate } from "../lib/dates";

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export function OverviewPage() {
  const trip = useTrip();
  const days = dayCount(trip.startDate, trip.endDate);

  return (
    <div className="space-y-6">
      {trip.cover && (
        <div className="overflow-hidden rounded-2xl border border-border">
          <img
            src={trip.cover}
            alt=""
            className="max-h-80 w-full object-cover"
          />
          {trip.coverCredit && (
            <p className="bg-card px-3 py-1 text-right text-[10px] text-muted-foreground">
              {trip.coverCredit}
            </p>
          )}
        </div>
      )}

      <div>
        <h1 className="text-3xl font-bold tracking-tight">{trip.title}</h1>
        {trip.subtitle && <p className="mt-1 text-muted-foreground">{trip.subtitle}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StageBadge stage={trip.stage} />
          {trip.startDate && trip.endDate && (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
              {formatDate(trip.startDate)} → {formatDate(trip.endDate)}
              {days ? ` (${days} days)` : ""}
            </span>
          )}
        </div>
      </div>

      {trip.summary && (
        <Card className="p-5">
          <Markdown>{trip.summary}</Markdown>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Users className="h-4 w-4" /> Crew
        </h2>
        <div className="flex flex-wrap gap-2">
          {trip.crew.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-2 rounded-full border border-border bg-muted py-1 pl-1 pr-3 text-sm"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                {initials(p.name)}
              </span>
              {p.name}
              {p.role !== "viewer" && (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {p.role}
                </span>
              )}
            </div>
          ))}
          {!trip.crew.length && (
            <p className="text-sm text-muted-foreground">Crew TBD.</p>
          )}
        </div>
      </Card>

      {trip.days.length > 0 && (
        <Link
          to="itinerary"
          className="group flex items-center justify-between rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40"
        >
          <div className="flex items-center gap-3">
            <MapPin className="h-5 w-5 text-primary" />
            <div>
              <p className="font-semibold">
                {trip.days.length} days planned
              </p>
              <p className="text-sm text-muted-foreground">
                {trip.days[0].date} → {trip.days[trip.days.length - 1].date}
              </p>
            </div>
          </div>
          <ArrowRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-1" />
        </Link>
      )}

      {trip.practical?.todos?.length ? (
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            To-do preview
          </h2>
          <ul className="space-y-1.5">
            {trip.practical.todos.slice(0, 5).map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                    t.done ? "border-accent bg-accent text-accent-foreground" : "border-border"
                  }`}
                >
                  {t.done ? "✓" : ""}
                </span>
                <span className={t.done ? "text-muted-foreground line-through" : undefined}>
                  {t.label}
                </span>
              </li>
            ))}
          </ul>
          <Separator className="my-3" />
          <Link to="practical" className="text-sm font-medium text-accent hover:underline">
            All practicals →
          </Link>
        </Card>
      ) : null}
    </div>
  );
}
