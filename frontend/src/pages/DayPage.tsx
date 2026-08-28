import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useTrip } from "../components/theme";
import { DayBlocks } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";

export function DayPage() {
  const trip = useTrip();
  const { idx } = useParams();
  const index = Number.parseInt(idx ?? "", 10);
  const day = Number.isNaN(index) ? undefined : trip.days[index];

  if (!day) {
    return (
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
        Day not found.
      </p>
    );
  }

  const prev = index > 0 ? trip.days[index - 1] : null;
  const next = index < trip.days.length - 1 ? trip.days[index + 1] : null;

  return (
    <div>
      <div className="mb-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Day {index + 1} of {trip.days.length}
        </p>
        <h1 className="mt-1 text-2xl font-bold">{formatDay(day.date)}</h1>
        {day.title && <p className="mt-1 text-muted-foreground">{day.title}</p>}
      </div>

      {day.notes && (
        <div className="mb-4 rounded-xl bg-muted p-4">
          <Markdown>{day.notes}</Markdown>
        </div>
      )}

      <DayBlocks blocks={day.blocks} />

      <div className="mt-8 flex items-center justify-between gap-3">
        {prev ? (
          <Link
            to={`/t/${trip.token}/day/${index - 1}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" /> {formatDay(prev.date)}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            to={`/t/${trip.token}/day/${index + 1}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            {formatDay(next.date)} <ArrowRight className="h-4 w-4" />
          </Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
