import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useParams } from "react-router-dom";
import { MapPin } from "lucide-react";
import { useTrip } from "../components/theme";
import { BlockSummaryRow, DaySummaryRow, FoldedDayCard } from "../components/DaySummaryRow";
import { useLocationMarkers } from "../components/blocks";
import { findLocation } from "../lib/maps";
import { tripTodayIso, isTodayInRange, formatDay } from "../lib/dates";
import { itineraryItems, sectionRange } from "../lib/sections";
import { roleAtLeast } from "../lib/editing";
import { useTripWrite } from "../lib/useTripWrite";
import { moveTripBlock } from "../lib/api";
import type { Day, TripSection } from "../lib/types";

const scrollKey = (tripId: string) => `kiseki:itinerary-scroll:${tripId}`;

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
  const { tripId = "" } = useParams();
  const { hash } = useLocation();
  const todayIso = tripTodayIso(trip);
  const todayInRange = isTodayInRange(trip, todayIso);
  const key = scrollKey(tripId);
  const canEdit = roleAtLeast(trip.myRole, "editor");
  const { busy, error, run } = useTripWrite();

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
        items: itineraryItems(section).map((item) =>
          item.kind === "fold"
            ? {
                kind: "fold" as const,
                title: item.title,
                days: item.indices
                  .map((idx) => trip.days[idx])
                  .filter((d): d is Day => Boolean(d)),
                startNo: item.indices[0] + 1,
              }
            : {
                kind: "day" as const,
                day: trip.days[item.idx],
                idx: item.idx,
              },
        ),
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
        sections.map(({ section, si, items }) => (
          <section
            key={si}
            id={`s-${si}`}
            style={{ scrollMarginTop: "var(--kiseki-header-h, 3.5rem)" }}
          >
            <SectionHeader section={section} />
            <SectionLocations section={section} />
            {items.length ? (
              <div className="space-y-2.5 pt-3">
                {items.map((item) =>
                  item.kind === "fold" ? (
                    <FoldedDayCard
                      key={`fold-${item.startNo}`}
                      days={item.days}
                      title={item.title}
                      startNo={item.startNo}
                      isToday={item.days.some((d) => d.date === todayIso)}
                    />
                  ) : (
                    <DaySummaryRow
                      key={item.idx}
                      day={item.day}
                      idx={item.idx}
                      dayNo={item.idx + 1}
                      isToday={item.day.date === todayIso}
                    />
                  ),
                )}
              </div>
            ) : (
              /* a section with no days yet — its unscheduled blocks ARE the
                 chapter content (idea-stage trip). Editors can "schedule"
                 (promote) one onto a day (§7.5 / #46). */
              <div className="space-y-2.5 pt-3">
                {[...(section.blocks ?? [])]
                  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                  .map((b, i) => (
                    <div key={b.id ?? i} className="space-y-1">
                      <BlockSummaryRow block={b} />
                      {canEdit && trip.days.length > 0 && (
                        <div className="no-print flex items-center gap-1.5 pl-1">
                          <label className="sr-only" htmlFor={`schedule-${b.id}`}>
                            Schedule block to a day
                          </label>
                          <select
                            id={`schedule-${b.id}`}
                            className="h-7 rounded-md border border-border bg-card px-1.5 text-[11px] font-medium text-foreground focus-visible:focus-ring disabled:opacity-50"
                            disabled={busy}
                            defaultValue=""
                            onChange={(e) => {
                              const dayId = e.target.value;
                              if (!dayId) return;
                              void run((token) =>
                                moveTripBlock(trip.id, b.id, { type: "day", id: dayId }, token),
                              );
                            }}
                          >
                            <option value="" disabled>
                              Schedule to day…
                            </option>
                            {trip.days.map((d, di) => (
                              <option key={d.id} value={d.id}>
                                Day {di + 1} — {d.title || formatDay(d.date)}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  ))}
                {!section.blocks?.length && (
                  <p className="text-sm italic text-muted-foreground">
                    Planning this chapter — nothing scheduled yet.
                  </p>
                )}
                {error && (
                  <p role="alert" className="pt-1 text-xs font-medium text-destructive">
                    {error}
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
