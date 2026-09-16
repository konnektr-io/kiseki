import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useTrip } from "./theme";
import { InlineField } from "./inline-edit";
import { BlockSummaryRow, DaySummaryRow, FoldedDayCard } from "./DaySummaryRow";
import { findLocation, markerNumber } from "../lib/maps";
import { tripTodayIso, isTodayInRange, formatDay } from "../lib/dates";
import { itineraryItems, sectionAnchorElement, sectionRange } from "../lib/sections";
import { roleAtLeast, withSectionTitle } from "../lib/editing";
import { useTripWrite } from "../lib/useTripWrite";
import { moveTripBlock, putTripSection } from "../lib/api";
import { isPostHogConfigured, posthog, capture } from "../lib/posthog";
import type { Day, TripSection } from "../lib/types";

const scrollKey = (tripId: string) => `kiseki:itinerary-scroll:${tripId}`;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Sticky chapter header — title + derived range on one line. A section is a
 *  chapter within the itinerary, not a page (§7.5), so this bar is a plain
 *  header: the chapter itself is the anchor target (id="s-<si>"). `top` and
 *  `inset` are set by the host: the document page docks under the app header,
 *  the map surface's rail/sheet docks at its own scroll container's top. */
function SectionHeader({
  section,
  top = "var(--kiseki-header-h, 3.5rem)",
  inset = "-mx-4 px-4",
}: {
  section: TripSection;
  top?: string;
  inset?: string;
}) {
  const trip = useTrip();
  const { run, error } = useTripWrite();
  const canEdit = roleAtLeast(trip.myRole, "editor");
  const range = sectionRange(section.days);
  return (
    <div
      className={`sticky z-10 flex items-center gap-3 border-b border-border bg-background py-2.5 ${inset}`}
      style={{ top }}
    >
      <span className="h-[3px] w-8 shrink-0 rounded-full bg-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        {/* #296 — chapter titles fix inline, where the chapter is read. */}
        <InlineField
          value={section.title}
          label="Section title"
          canEdit={canEdit}
          error={error}
          onSave={async (next) => {
            capture("trip_section_updated", { field: "title" });
            return (
              (await run(
                (token) => putTripSection(trip.id, section.id, { title: next }, token),
                (t) => withSectionTitle(t, section.id, next),
              )) !== null
            );
          }}
          renderDisplay={(v) => (
            <h3 className="truncate font-heading text-lg font-semibold uppercase leading-tight tracking-wide text-foreground md:text-xl">
              {v}
            </h3>
          )}
        />
      </div>
      {range && (
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{range}</span>
      )}
    </div>
  );
}

/** Location chips for a chapter — orientation read once on arrival, so they
 *  live in the (non-sticky) chapter body, not the pinned bar. Marker numbers
 *  are the section → place → map-marker tie (§7.5, §8.3). On the map surface
 *  (#92) a pill is also a BUTTON: tapping it selects the place on the map. */
function SectionLocations({
  section,
  onSelectPlace,
  selectedPlace,
}: {
  section: TripSection;
  onSelectPlace?: (name: string) => void;
  /** The map-surface selection — the matching pill highlights (both
   *  directions of #109: pill tap selects, pin tap highlights the pill). */
  selectedPlace?: string | null;
}) {
  const trip = useTrip();
  const refs = (section.locationRefs ?? []).filter((ref) => findLocation(trip, ref));
  if (!refs.length) return null;
  const Pill = onSelectPlace ? "button" : "span";
  return (
    <ul className="flex flex-wrap gap-1.5 pt-3">
      {refs.map((ref) => {
        const loc = findLocation(trip, ref);
        const n = loc ? markerNumber(trip, loc) : null;
        const isSelected = selectedPlace === ref;
        return (
          <li key={ref}>
            <Pill
              {...(onSelectPlace
                ? {
                    type: "button" as const,
                    "aria-pressed": isSelected,
                    onClick: () => onSelectPlace(ref),
                    "aria-label": `Show ${ref} on the map`,
                  }
                : {})}
              data-place-pill={ref}
              className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-foreground ${
                onSelectPlace ? "transition-colors hover:border-primary/40 hover:bg-muted cursor-pointer" : ""
              }${isSelected ? " border-accent bg-accent/10" : ""}`}
            >
              {/* #109: the pill's marker IS the map's numbered pin — same
                  circle, same --map-marker colour, same digit — instead of a
                  bare ② glyph. The number is the through-line (§8.3). */}
              {n != null && (
                <span
                  aria-hidden
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-marker text-[10px] font-bold leading-none text-marker-fg"
                >
                  {n}
                </span>
              )}
              {ref}
            </Pill>
          </li>
        );
      })}
    </ul>
  );
}

export interface ItineraryListProps {
  /** Sticky-header top within the host's scroll container. */
  stickyTop?: string;
  /** Sticky-header horizontal bleed — matches the host scroll container's padding. */
  stickyInset?: string;
  /** Scroll-margin for #s-<n> anchors inside the host scroll container. */
  anchorMargin?: string;
  /** Scan-level map interactions (#92): pills select places. */
  onSelectPlace?: (name: string) => void;
  /** The currently selected place — its pills highlight. */
  selectedPlace?: string | null;
  /** Receives the list root — the scroll-spy's query scope (map surface). */
  rootRef?: RefObject<HTMLDivElement | null>;
  /** Which day is open in the day level (highlights its row when embedded elsewhere). */
  activeDayIdx?: number | null;
}

/**
 * The itinerary scan list — chapters, sticky headers, location pills, day
 * summary cards, folds — EXACTLY as the itinerary page has always rendered it
 * (#92: "no markup change"). Extracted from `ItineraryPage` so the map
 * surface's rail/sheet can host the same content; the document page renders
 * it with its original chrome (app-header-docked sticky bars, window scroll).
 */
export function ItineraryList({
  stickyTop,
  stickyInset = "-mx-4 px-4",
  anchorMargin = "var(--kiseki-header-h, 3.5rem)",
  onSelectPlace,
  selectedPlace,
  rootRef,
  activeDayIdx,
}: ItineraryListProps) {
  const trip = useTrip();
  const { tripId = "" } = useParams();
  const { hash } = useLocation();
  const todayIso = tripTodayIso(trip);
  const todayInRange = isTodayInRange(trip, todayIso);
  const key = scrollKey(tripId);
  const canEdit = roleAtLeast(trip.myRole, "editor");
  const { busy, error, run } = useTripWrite();
  const innerRef = useRef<HTMLDivElement>(null);

  // Restore position with strict precedence: an incoming #s-<n> anchor (from a
  // shared /s/<n> link, the Overview TOC, or a day page's up button) wins;
  // then the saved scroll position (returning from a day); then settle on
  // today when it's in range (#42). Hash arrival is INSTANT — the user asked
  // for a specific place, smooth-scrolling across the whole trip is
  // disorienting. Today keeps its smooth "here's where you are" gesture.
  // Both degrade to instant under prefers-reduced-motion (§10).
  //
  // The scroll container is the nearest [data-scroll-root] — the window on the
  // document page, the rail/sheet body on the map surface.
  useLayoutEffect(() => {
    const root = innerRef.current;
    const scroller = (root?.closest("[data-scroll-root]") as HTMLElement | null) ?? null;
    // Chapter anchor first: it is the most specific thing the URL can ask for.
    // A hash that names no chapter (stale link, section removed, or something
    // that isn't a chapter at all) yields null and falls through to the rules
    // below rather than doing nothing.
    const anchor = sectionAnchorElement(root, hash);
    if (anchor) {
      anchor.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "instant" });
      return;
    }
    const saved = sessionStorage.getItem(key);
    if (saved != null && !Number.isNaN(Number(saved))) {
      if (scroller) scroller.scrollTop = Number(saved);
      else window.scrollTo(0, Number(saved));
      return;
    }
    if (todayInRange) {
      const el = root?.querySelector<HTMLElement>('[data-today="true"]');
      if (el) el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hash]);

  // Track scroll live (passive) so the unmount-save below reads the LAST real
  // position: passive cleanups run after React swaps the DOM, when
  // scrollTop/scrollY has already been reset. The listener also covers exits
  // via browser back/forward, which fire no click.
  const lastY = useRef(0);
  useEffect(() => {
    const root = innerRef.current;
    const scroller = (root?.closest("[data-scroll-root]") as HTMLElement | null) ?? null;
    const onScroll = () => {
      lastY.current = scroller ? scroller.scrollTop : window.scrollY;
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Persist the scroll position whenever the list unmounts (day level, nav
  // away) so the scan view resumes where it was.
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
      <div ref={rootRef ?? innerRef} data-itinerary-list="">
        <p className="py-10 text-center text-sm italic text-muted-foreground">
          Still in the <strong>idea</strong> stage — no itinerary yet. The route skeleton lives in the overview.
        </p>
      </div>
    );
  }

  const content = (
    <div className="space-y-8">
      {hasSections ? (
        sections.map(({ section, si, items }) => (
          <section
            key={si}
            id={`s-${si}`}
            data-section-id={section.id}
            data-section-index={si}
            style={{ scrollMarginTop: anchorMargin }}
          >
            <SectionHeader section={section} top={stickyTop} inset={stickyInset} />
            <SectionLocations
              section={section}
              onSelectPlace={
                onSelectPlace
                  ? (name) => onSelectPlace(selectedPlace === name ? "" : name)
                  : undefined
              }
              selectedPlace={selectedPlace}
            />
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
                      active={activeDayIdx === item.idx}
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
                              if (isPostHogConfigured) {
                                posthog.capture("itinerary_block_scheduled", {
                                  block_kind: b.kind,
                                });
                              }
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
            <DaySummaryRow
              key={idx}
              day={day}
              idx={idx}
              dayNo={idx + 1}
              isToday={day.date === todayIso}
              active={activeDayIdx === idx}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={(el) => {
        innerRef.current = el;
        if (rootRef) rootRef.current = el;
      }}
      data-itinerary-list=""
    >
      {content}
    </div>
  );
}
