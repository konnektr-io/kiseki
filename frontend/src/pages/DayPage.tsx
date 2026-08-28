import { useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CalendarDays } from "lucide-react";
import { useTrip } from "../components/theme";
import { DayBlocks, MetaChips } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";

export function DayPage() {
  const trip = useTrip();
  const { idx } = useParams();
  const i = Math.min(Math.max(parseInt(idx ?? "0", 10) || 0, 0), trip.days.length - 1);
  const day = trip.days[i];
  const navigate = useNavigate();
  const touchX = useRef<number | null>(null);
  if (!day) return <p className="py-10 text-center text-sm text-muted-foreground">Day not found.</p>;

  const prev = i > 0 ? i - 1 : null;
  const next = i < trip.days.length - 1 ? i + 1 : null;

  const go = (target: number | null) => {
    if (target != null) navigate(`/t/${trip.token}/day/${target}`);
  };

  return (
    <div
      className="space-y-5 pb-20"
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (Math.abs(dx) > 60) go(dx < 0 ? next : prev); // swipe left → next, right → prev
        touchX.current = null;
      }}
    >
      <div>
        <p className="kicker">
          Day {i + 1} of {trip.days.length} · {formatDay(day.date)}
        </p>
        <h2 className="mt-1 font-display text-4xl uppercase leading-none text-foreground">
          {day.title || formatDay(day.date)}
        </h2>
        <div className="mt-3">
          <MetaChips meta={day.meta} />
        </div>
      </div>

      {day.map && (
        <img src={day.map} alt={`Route map — ${day.title}`} className="w-full rounded-xl border border-border shadow-sm" />
      )}

      {day.notes && (
        <div className="rounded-xl border border-border bg-muted/40 p-4">
          <p className="kicker mb-1.5">Notes</p>
          <div className="text-sm leading-relaxed text-muted-foreground">
            <Markdown>{day.notes}</Markdown>
          </div>
        </div>
      )}

      <DayBlocks blocks={day.blocks} />

      {/* sticky day navigation — always visible, same place */}
      <div className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2.5">
          {prev != null ? (
            <button
              onClick={() => go(prev)}
              className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 text-left hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{trip.days[prev].title}</span>
                <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                  {formatDay(trip.days[prev].date)}
                </span>
              </span>
            </button>
          ) : (
            <span className="flex-1" />
          )}
          <Link
            to={`/t/${trip.token}/itinerary`}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent hover:underline"
          >
            <CalendarDays className="h-4 w-4" /> Itinerary
          </Link>
          {next != null ? (
            <button
              onClick={() => go(next)}
              className="flex h-11 min-w-0 flex-1 items-center justify-end gap-2 rounded-lg border border-border bg-card px-3 text-right hover:bg-muted"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{trip.days[next].title}</span>
                <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                  {formatDay(trip.days[next].date)}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <span className="flex-1" />
          )}
        </div>
      </div>
    </div>
  );
}
