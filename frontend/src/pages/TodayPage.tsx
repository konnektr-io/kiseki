import { Link, Navigate, useParams } from "react-router-dom";
import { CalendarDays, Clock } from "lucide-react";
import { useTrip } from "../components/theme";
import { DayBlocks, MetaChips } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay, humanizeDays, resolveToday } from "../lib/dates";
import { roleAtLeast } from "../lib/editing";

/**
 * Today surface — chrome, no-print.
 * Resolves "today" in the trip's timezone (or viewer-local) and degrades
 * honestly per the #42 table. Reuses the day renderer; don't build a second one.
 */
export function TodayPage() {
  const trip = useTrip();
  const { tripId } = useParams();

  const r = resolveToday(trip);

  if (r.kind === "no-dates") {
    return <Navigate to={`/t/${tripId}`} replace />;
  }

  if (r.kind === "before") {
    const label = humanizeDays(r.daysUntil);
    return (
      <div className="no-print space-y-5">
        <div className="space-y-1">
          <p className="kicker tabular-nums flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-primary/40" aria-hidden />
            Today · {formatDay(r.todayIso)}
          </p>
          <h2 className="font-display text-4xl uppercase leading-none">Starts in {label}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The trip hasn't started yet — first day is {trip.startDate ? formatDay(trip.startDate) : "soon"}.
          </p>
        </div>
        {trip.days[0] ? (
          <Link
            to={`/t/${tripId}/day/0`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Day 1 · {trip.days[0].title || formatDay(trip.days[0].date)} →
          </Link>
        ) : (
          <Link to={`/t/${tripId}`} className="text-sm font-medium text-accent hover:underline">
            Back to overview →
          </Link>
        )}
      </div>
    );
  }

  if (r.kind === "after") {
    const label = humanizeDays(r.daysSinceEnd);
    return (
      <div className="no-print space-y-5">
        <div className="space-y-1">
          <p className="kicker tabular-nums">Today · {formatDay(r.todayIso)}</p>
          <h2 className="font-display text-4xl uppercase leading-none">Ended {label} ago</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The trip ran {trip.startDate ? formatDay(trip.startDate) : ""} →{" "}
            {trip.endDate ? formatDay(trip.endDate) : ""}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/t/${tripId}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Back to overview
          </Link>
          {trip.days.length ? (
            <Link
              to={`/t/${tripId}/day/${trip.days.length - 1}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium"
            >
              Last day →
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  if (r.kind === "section") {
    const section = trip.sections?.[r.sectionIdx];
    const nearestDay = r.nearestDayIdx != null ? trip.days[r.nearestDayIdx] : null;
    return (
      <div className="no-print space-y-5">
        <div className="space-y-1">
          <p className="kicker tabular-nums flex items-center gap-2">
            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
            Today · {formatDay(r.todayIso)}
          </p>
          <h2 className="font-display text-4xl uppercase leading-none">
            {section?.title ?? `Day ${r.nearestDayIdx != null ? r.nearestDayIdx + 1 : "—"}`}
          </h2>
          {section && <p className="text-sm text-muted-foreground">In {section.title}</p>}
        </div>
        {nearestDay && r.nearestDayIdx != null ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">No exact day for today — showing the closest:</p>
            <Link
              to={`/t/${tripId}/day/${r.nearestDayIdx}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Day {r.nearestDayIdx + 1} · {nearestDay.title || formatDay(nearestDay.date)} →
            </Link>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No day for today.</p>
        )}
      </div>
    );
  }

  // kind === "day" | "nearest-day" — render the day itself
  const dayIdx = r.dayIdx;
  const day = trip.days[dayIdx];
  if (!day) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Day not found.</p>;
  }
  const sectionLabel = r.kind === "day" && r.sectionIdx != null ? trip.sections?.[r.sectionIdx]?.title : undefined;

  return (
    <div className="no-print space-y-5 pb-20">
      <div className="space-y-1">
        <p className="kicker tabular-nums flex items-center gap-2">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
          Today · Day {dayIdx + 1} of {trip.days.length} · {formatDay(day.date)}
          {sectionLabel ? <span className="text-muted-foreground">· {sectionLabel}</span> : null}
        </p>
        <h2 className="font-display text-4xl uppercase leading-none">
          {day.title || formatDay(day.date)}
        </h2>
        <div className="mt-2 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <Clock className="h-3 w-3" /> Today in {trip.timezone ?? "your time"}
        </div>
        <div className="mt-3">
          <MetaChips meta={day.meta} />
        </div>
      </div>

      {day.notes ? (
        <div className="rounded-xl border border-border bg-muted/40 p-4">
          <p className="kicker mb-1.5">Notes</p>
          <div className="text-sm leading-relaxed text-muted-foreground">
            <Markdown>{day.notes}</Markdown>
          </div>
        </div>
      ) : null}

      <DayBlocks
        blocks={day.blocks}
        editable={roleAtLeast(trip.myRole, "editor")}
        containerId={day.id}
      />

      <div className="flex flex-wrap gap-2 pt-2">
        <Link
          to={`/t/${tripId}/day/${dayIdx}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <CalendarDays className="h-4 w-4" /> Open as day page
        </Link>
        <Link to={`/t/${tripId}/itinerary`} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
          Itinerary →
        </Link>
      </div>
    </div>
  );
}
