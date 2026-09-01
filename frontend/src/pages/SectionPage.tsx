import { Link, useParams } from "react-router-dom";
import { ArrowLeft, MapPin } from "lucide-react";
import { useTrip } from "../components/theme";
import { DayBlocks, useLocationMarkers } from "../components/blocks";
import { DaySummaryRow } from "../components/DaySummaryRow";
import { findLocation } from "../lib/maps";
import { expandSectionDays, sectionRange } from "../lib/sections";
import type { Day } from "../lib/types";

/** /t/<token>/s/<n> — a section as a navigable surface (DESIGN.md §7.5):
 *  the place/chapter's own unscheduled blocks plus the days inside it. */
export function SectionPage() {
  const trip = useTrip();
  const { token = "", n = "0" } = useParams();
  const marker = useLocationMarkers();
  const si = Math.min(Math.max(parseInt(n, 10) || 0, 0), Math.max((trip.sections?.length ?? 1) - 1, 0));
  const section = trip.sections?.[si];

  if (!section) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Section not found.</p>;
  }

  const days = expandSectionDays(section.days)
    .map((idx) => ({ day: trip.days[idx], idx }))
    .filter((d): d is { day: Day; idx: number } => Boolean(d.day));
  const range = sectionRange(section.days);
  const refs = (section.locationRefs ?? []).filter((ref) => findLocation(trip, ref));
  const blocks = section.blocks ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/t/${token}/itinerary`}
          className="no-print mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Itinerary
        </Link>
        <p className="kicker tabular-nums">{range ?? (days.length ? "Itinerary" : "Planning")}</p>
        <h2 className="mt-1 font-display text-4xl uppercase leading-none text-foreground md:text-5xl">
          {section.title}
        </h2>
        {refs.length ? (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {refs.map((ref) => (
              <li
                key={ref}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground"
              >
                <MapPin className="h-3 w-3 text-primary" aria-hidden />
                <span aria-hidden>{marker(ref) !== "•" ? `${marker(ref)} ` : ""}</span>
                {ref}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* the section's unscheduled pool — rendered by the shared block renderer */}
      {blocks.length ? (
        <div>
          <p className="kicker mb-2">Options & ideas</p>
          <DayBlocks blocks={blocks} />
        </div>
      ) : null}

      {/* the days inside the section */}
      {days.length ? (
        <div className="space-y-2.5">
          {days.map(({ day, idx }) => (
            <DaySummaryRow key={idx} day={day} idx={idx} dayNo={idx + 1} />
          ))}
        </div>
      ) : (
        <p className="text-sm italic text-muted-foreground">
          {blocks.length
            ? "Nothing scheduled yet — the options above are the chapter so far."
            : "This chapter is still taking shape — no days or options scheduled yet."}
        </p>
      )}
    </div>
  );
}
