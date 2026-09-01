import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTrip } from "../components/theme";
import { Badge } from "../components/ui";
import { BlockGlyph, MetaChips } from "../components/blocks";
import { formatDay } from "../lib/dates";
import { expandSectionDays } from "../lib/sections";
import type { Block, Day, TripSection } from "../lib/types";

function DayRow({ day, idx, dayNo }: { day: Day; idx: number; dayNo: number }) {
  const { token } = useParams();
  const [open, setOpen] = useState(false);
  const hasBooked = day.blocks.some((b) => b.status === "booked" || b.status === "done");
  const hasPlanned = day.blocks.some((b) => b.status === "planned");
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/60"
      >
        <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-muted py-1.5">
          <span className="font-display text-xl leading-none text-foreground">{dayNo}</span>
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {formatDay(day.date).split(" ")[0]}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="font-heading text-base font-semibold leading-snug">{day.title || formatDay(day.date)}</h4>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{day.blocks.length} items</span>
            <span className="inline-flex items-center gap-0.5">
              {day.blocks.map((b, i) => (
                <BlockGlyph key={i} kind={b.kind} />
              ))}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasBooked && <Badge variant="accent">Booked</Badge>}
          {hasPlanned && <Badge variant="outline">Planned</Badge>}
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-border bg-muted/30 p-3">
          <div className="mb-3">
            <MetaChips meta={day.meta} />
          </div>
          {day.notes && <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{day.notes}</p>}
          <ul className="space-y-1.5">
            {day.blocks.map((b: Block, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <BlockGlyph kind={b.kind} />
                <span className="min-w-0 flex-1 truncate">{b.title || "—"}</span>
                {b.time && <span className="shrink-0 text-xs text-muted-foreground">{b.time}</span>}
                {b.status && (
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {b.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <Link
            to={`/t/${token}/day/${idx}`}
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            Open day <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}

export function ItineraryPage() {
  const trip = useTrip();
  const sections: { section: TripSection | null; days: { day: Day; idx: number }[] }[] = trip.sections?.length
    ? trip.sections.map((s) => ({
        section: s,
        days: expandSectionDays(s.days)
          .map((idx) => ({ day: trip.days[idx], idx }))
          .filter((d): d is { day: Day; idx: number } => Boolean(d.day)),
      }))
    : [{ section: null, days: trip.days.map((day, idx) => ({ day, idx })) }];

  if (!trip.days.length) {
    return (
      <p className="py-10 text-center text-sm italic text-muted-foreground">
        Still in the <strong>idea</strong> stage — no itinerary yet. The route skeleton lives in the overview.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {sections.map(({ section, days }, si) => (
        <section key={si}>
          {section && (
            <div className="mb-3 flex items-center gap-3">
              <span className="h-[3px] w-8 shrink-0 rounded-full bg-primary" />
              <h3 className="font-heading text-lg font-semibold uppercase leading-tight tracking-wide text-foreground md:text-xl">
                {section.title}
              </h3>
            </div>
          )}
          <div className="space-y-2.5">
            {days.map(({ day, idx }) => (
              <DayRow key={idx} day={day} idx={idx} dayNo={idx + 1} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
