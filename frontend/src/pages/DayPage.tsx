import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useTrip } from "../components/theme";
import { DayBlocks } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";

export function DayPage() {
  const trip = useTrip();
  const { idx } = useParams();
  const i = Math.min(Math.max(parseInt(idx ?? "0", 10) || 0, 0), trip.days.length - 1);
  const day = trip.days[i];
  if (!day) return <p className="py-10 text-center text-sm text-muted-foreground">Day not found.</p>;

  const prev = i > 0 ? i - 1 : null;
  const next = i < trip.days.length - 1 ? i + 1 : null;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="kicker">
            Day {i + 1} of {trip.days.length} · {formatDay(day.date)}
          </p>
          <h2 className="font-display text-4xl uppercase leading-none text-foreground">
            {day.title || formatDay(day.date)}
          </h2>
        </div>
        <div className="flex shrink-0 gap-2">
          {prev != null ? (
            <Link
              to={`/t/${trip.token}/day/${prev}`}
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" /> {formatDay(trip.days[prev].date).split(" ")[0]}
            </Link>
          ) : (
            <span className="h-9 w-9" />
          )}
          {next != null && (
            <Link
              to={`/t/${trip.token}/day/${next}`}
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted"
            >
              {formatDay(trip.days[next].date).split(" ")[0]} <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      </div>

      {day.map && (
        <img
          src={day.map}
          alt={`Route map — ${day.title}`}
          className="w-full rounded-xl border border-border shadow-sm"
        />
      )}

      {day.notes && (
        <div className="rounded-xl border-l-4 border-l-primary/40 bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground">
          <Markdown>{day.notes}</Markdown>
        </div>
      )}

      <DayBlocks blocks={day.blocks} />
    </div>
  );
}
