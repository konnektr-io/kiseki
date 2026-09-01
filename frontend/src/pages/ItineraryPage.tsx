import { useEffect, useLayoutEffect, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useTrip } from "../components/theme";
import { BlockSummaryRow, DaySummaryRow } from "../components/DaySummaryRow";
import { tripTodayIso, isTodayInRange } from "../lib/dates";
import { expandSectionDays, sectionRange } from "../lib/sections";
import type { Day, TripSection } from "../lib/types";

const scrollKey = (token: string) => `kiseki:itinerary-scroll:${token}`;

/** Sticky chapter header — the whole bar links to the section's own page.
 *  Sticks below the app header (`--kiseki-header-h`, measured by TripLayout). */
function SectionHeader({ section, si, token }: { section: TripSection; si: number; token: string }) {
  const range = sectionRange(section.days);
  return (
    <Link
      to={`/t/${token}/s/${si}`}
      aria-label={`${section.title}${range ? ` — ${range}` : ""}. Open section`}
      className="sticky z-10 -mx-4 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      style={{ top: "var(--kiseki-header-h, 3.5rem)" }}
    >
      <span className="h-[3px] w-8 shrink-0 rounded-full bg-primary" aria-hidden />
      <h3 className="min-w-0 flex-1 truncate font-heading text-lg font-semibold uppercase leading-tight tracking-wide text-foreground md:text-xl">
        {section.title}
      </h3>
      {range && (
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{range}</span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

export function ItineraryPage() {
  const trip = useTrip();
  const { token = "" } = useParams();
  const todayIso = tripTodayIso(trip);
  const todayInRange = isTodayInRange(trip, todayIso);
  const key = scrollKey(token);

  // Restore the saved scroll position (returning from a day page). A fresh
  // visit with no saved position settles on today when it's in range (#42).
  useLayoutEffect(() => {
    const saved = sessionStorage.getItem(key);
    if (saved != null && !Number.isNaN(Number(saved))) {
      window.scrollTo(0, Number(saved));
    } else if (todayInRange) {
      const el = document.querySelector<HTMLElement>('[data-today="true"]');
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Track scroll live (passive) so the unmount-save below reads the LAST real
  // position: passive cleanups run after React swaps the DOM, when
  // window.scrollY has already been reset to 0. The listener also covers
  // exits via browser back/forward, which fire no click.
  const lastY = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      lastY.current = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Persist the scroll position whenever the itinerary unmounts (day page,
  // section page, nav away) so the scan view resumes where it was.
  useEffect(() => {
    return () => sessionStorage.setItem(key, String(lastY.current));
  }, [key]);

  const sections = trip.sections?.length
    ? trip.sections.map((section, si) => ({
        section,
        si,
        days: expandSectionDays(section.days)
          .map((idx) => ({ day: trip.days[idx], idx }))
          .filter((d): d is { day: Day; idx: number } => Boolean(d.day)),
      }))
    : [];

  const hasDays = trip.days.length > 0;
  const hasSections = sections.length > 0;

  if (!hasDays && !hasSections) {
    return (
      <p className="py-10 text-center text-sm italic text-muted-foreground">
        Still in the <strong>idea</strong> stage — no itinerary yet. The route skeleton lives in the overview.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {hasSections ? (
        sections.map(({ section, si, days }) => (
          <section key={si} className="scroll-mt-24">
            <SectionHeader section={section} si={si} token={token} />
            {days.length ? (
              <div className="space-y-2.5 pt-3">
                {days.map(({ day, idx }) => (
                  <DaySummaryRow key={idx} day={day} idx={idx} dayNo={idx + 1} isToday={day.date === todayIso} />
                ))}
              </div>
            ) : (
              /* a section with no days yet — its unscheduled blocks ARE the
                 content (idea-stage chapter). Link lives on the header. */
              <div className="space-y-2.5 pt-3">
                {(section.blocks ?? []).map((b, i) => (
                  <BlockSummaryRow key={i} block={b} />
                ))}
                {!section.blocks?.length && (
                  <p className="text-sm italic text-muted-foreground">
                    Planning this chapter — nothing scheduled yet.
                  </p>
                )}
              </div>
            )}
          </section>
        ))
      ) : (
        /* no sections — legacy flat day list */
        <div className="space-y-2.5">
          {trip.days.map((day, idx) => (
            <DaySummaryRow key={idx} day={day} idx={idx} dayNo={idx + 1} isToday={day.date === todayIso} />
          ))}
        </div>
      )}
    </div>
  );
}
