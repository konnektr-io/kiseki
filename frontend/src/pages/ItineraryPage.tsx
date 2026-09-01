import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useParams } from "react-router-dom";
import { MapPin } from "lucide-react";
import { useTrip } from "../components/theme";
import { BlockSummaryRow, DaySummaryRow } from "../components/DaySummaryRow";
import { useLocationMarkers } from "../components/blocks";
import { findLocation } from "../lib/maps";
import { tripTodayIso, isTodayInRange } from "../lib/dates";
import { expandSectionDays, sectionRange } from "../lib/sections";
import type { Day, TripSection } from "../lib/types";

const scrollKey = (token: string) => `kiseki:itinerary-scroll:${token}`;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Sticky chapter header — title + derived range on one line. A section is a
 *  chapter within the itinerary, not a page (§7.5), so this bar is a plain
 *  header: the chapter itself is the anchor target (id="s-<si>"). */
function SectionHeader({ section }: { section: TripSection }) {
  const range = sectionRange(section.days);
  return (
    <div
      className="sticky z-10 -mx-4 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur"
      style={{ top: "var(--kiseki-header-h, 3.5rem)" }}
    >
      <span className="h-[3px] w-8 shrink-0 rounded-full bg-primary" aria-hidden />
      <h3 className="min-w-0 flex-1 truncate font-heading text-lg font-semibold uppercase leading-tight tracking-wide text-foreground md:text-xl">
        {section.title}
      </h3>
      {range && (
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{range}</span>
      )}
    </div>
  );
}

/** Location chips for a chapter — orientation read once on arrival, so they
 *  live in the (non-sticky) chapter body, not the pinned bar. Marker numbers
 *  are the section → place → map-marker tie (§7.5, §8.3). */
function SectionLocations({ section }: { section: TripSection }) {
  const trip = useTrip();
  const marker = useLocationMarkers();
  const refs = (section.locationRefs ?? []).filter((ref) => findLocation(trip, ref));
  if (!refs.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 pt-3">
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
  );
}

export function ItineraryPage() {
  const trip = useTrip();
  const { token = "" } = useParams();
  const { hash } = useLocation();
  const todayIso = tripTodayIso(trip);
  const todayInRange = isTodayInRange(trip, todayIso);
  const key = scrollKey(token);

  // Restore position with strict precedence: an incoming #s-<n> anchor (from a
  // shared /s/<n> link, the Overview TOC, or a day page's up button) wins;
  // then the saved scroll position (returning from a day); then settle on
  // today when it's in range (#42). Hash arrival is INSTANT — the user asked
  // for a specific place, smooth-scrolling across the whole trip is
  // disorienting. Today keeps its smooth "here's where you are" gesture.
  // Both degrade to instant under prefers-reduced-motion (§10).
  useLayoutEffect(() => {
    if (hash.startsWith("#s-")) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "instant" });
        return;
      }
      // Hash present but no such chapter (stale link, section removed) —
      // fall through to the next precedence rule rather than doing nothing.
    }
    const saved = sessionStorage.getItem(key);
    if (saved != null && !Number.isNaN(Number(saved))) {
      window.scrollTo(0, Number(saved));
      return;
    }
    if (todayInRange) {
      const el = document.querySelector<HTMLElement>('[data-today="true"]');
      if (el) el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hash]);

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
  // nav away) so the scan view resumes where it was.
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
          <section
            key={si}
            id={`s-${si}`}
            style={{ scrollMarginTop: "var(--kiseki-header-h, 3.5rem)" }}
          >
            <SectionHeader section={section} />
            <SectionLocations section={section} />
            {days.length ? (
              <div className="space-y-2.5 pt-3">
                {days.map(({ day, idx }) => (
                  <DaySummaryRow key={idx} day={day} idx={idx} dayNo={idx + 1} isToday={day.date === todayIso} />
                ))}
              </div>
            ) : (
              /* a section with no days yet — its unscheduled blocks ARE the
                 chapter content (idea-stage trip). */
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
