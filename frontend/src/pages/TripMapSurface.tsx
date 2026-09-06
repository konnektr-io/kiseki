import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CalendarDays, X } from "lucide-react";
import { useTrip } from "../components/theme";
import { RouteMap } from "../components/RouteMap";
import { ItineraryList } from "../components/ItineraryList";
import { SplitView, useSurfaceMode } from "../components/SplitView";
import { Button } from "../components/ui";
import { DayBlocks, MetaChips } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";
import { sectionIndexForDay } from "../lib/sections";
import { roleAtLeast } from "../lib/editing";
import { markerNumber, findLocation } from "../lib/maps";
import { dayRangeLabel, placeDays, tripJourney } from "../lib/route-surface";
import { daySurface, type DaySurface } from "../lib/day-surface";
import { usePageTitle } from "../lib/seo";
import type { Detent } from "../lib/sheet";
import type { Block, Trip, TripLocation } from "../lib/types";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Clamp a raw /day/<idx> param into trip range. */
function parseDayIdx(raw: string | undefined, count: number): number | null {
  const i = parseInt(raw ?? "", 10);
  if (Number.isNaN(i)) return null;
  return Math.min(Math.max(i, 0), Math.max(count - 1, 0));
}

/** Expand a section's [first, last] day range to indices (see lib/sections). */
function expandDays(days: number[] | undefined): number[] {
  if (!days || days.length === 0) return [];
  if (days.length === 2 && days[1] >= days[0]) {
    const out: number[] = [];
    for (let i = days[0]; i <= days[1]; i++) out.push(i);
    return out;
  }
  return days;
}

/**
 * The scan level's PLACE panel — what a marker tap opens in the rail/sheet.
 * The itinerary list is the rail's normal content; selecting a place on the
 * map temporarily swaps it for this panel (the marker → days interaction the
 * surface exists for), with a way back. Days open the day level — an in-app
 * state transition, the map stays alive.
 */
function PlacePanel({
  place,
  days,
  onClear,
  onOpenDay,
}: {
  place: TripLocation;
  days: number[];
  onClear: () => void;
  onOpenDay: (idx: number) => void;
}) {
  const trip = useTrip();
  return (
    <div className="pb-6">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-marker-fg bg-marker text-[12px] font-bold leading-none text-marker-fg"
        >
          {markerNumber(trip, place)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-base font-semibold leading-tight">{place.name}</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {dayRangeLabel(days) ?? "No days scheduled here yet"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Clear the selected place, ${place.name}`}
          onClick={onClear}
          className="h-11 w-11 shrink-0 rounded-full"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {days.length > 0 && (
        <ul className="mb-3 ml-9 mt-1 space-y-0.5 border-l border-border pl-3">
          {days.map((d) => (
            <li key={d}>
              <button
                type="button"
                onClick={() => onOpenDay(d)}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:focus-ring"
              >
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
                  Day {d + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {trip.days[d]?.title || formatDay(trip.days[d]?.date ?? "")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline focus-visible:focus-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to the route
      </button>
    </div>
  );
}

/**
 * DayNav (#104): the day level's prev / up / next bar, rendered OUTSIDE the
 * scroll flow — TripMapSurface passes it to SplitView's `footer` slot, so it
 * pins flush to the rail's bottom edge at every scroll position (an in-flow
 * sticky bar inside a padded scroller always ends ~24px above the edge).
 * The phone sheet has no footer row — its height is detent-controlled — so
 * there the SAME bar renders in-flow sticky at the scroller's floor instead
 * (DayRail mounts it via `variant="sheet"`).
 */
function DayNav({
  trip,
  tripId,
  dayIdx,
  variant = "footer",
}: {
  trip: Trip;
  tripId: string;
  dayIdx: number;
  /** "footer": SplitView's pinned footer slot (desktop rail/split, landscape
   *  side panel). "sheet": in-flow sticky at the phone sheet's scroll floor. */
  variant?: "footer" | "sheet";
}) {
  const navigate = useNavigate();
  const sectionIdx = sectionIndexForDay(trip.sections, dayIdx);

  const go = (i: number) => navigate(`/t/${tripId}/day/${i}`);
  const up = () => navigate(sectionIdx != null ? `/t/${tripId}/itinerary#s-${sectionIdx}` : `/t/${tripId}/itinerary`);
  const prev = dayIdx > 0 ? dayIdx - 1 : null;
  const next = dayIdx < trip.days.length - 1 ? dayIdx + 1 : null;

  const dayNav = (target: number | null, d: "prev" | "next") => {
    if (target == null) return <span className="flex-1" />;
    return (
      <Button
        variant="outline"
        size="auto"
        onClick={() => go(target)}
        aria-label={`${d === "prev" ? "Previous" : "Next"} day — day ${target + 1}, ${trip.days[target].title || formatDay(trip.days[target].date)}`}
        className="h-11 min-w-0 flex-1 justify-start gap-2 rounded-lg px-2.5 text-left md:px-3"
      >
        {d === "prev" ? <ArrowLeft className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
        <span className="min-w-0 flex flex-col @container">
          <span className="block truncate text-sm font-medium leading-tight">
            {trip.days[target].title || formatDay(trip.days[target].date)}
          </span>
          {/* #109: the date drops out via container query before it can
              overflow — on a narrow rail or phone the button fits "Day 2"
              alone; ellipsis on the meta line is only the last resort. */}
          <span className="block truncate text-[10px] uppercase tracking-wide tabular-nums text-muted-foreground">
            Day {target + 1}
            <span className="@max-[140px]:hidden">
              {" · "}
              {formatDay(trip.days[target].date).replace(",", "")}
            </span>
          </span>
        </span>
        {d === "next" ? <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
      </Button>
    );
  };

  return (
    <div
      className={
        variant === "sheet"
          ? // Phone: in-flow sticky at the scroll floor — full-bleed over the
            // sheet body's px-4, opaque so cards scroll under it, safe-area pad.
            "no-print sticky bottom-0 z-10 -mx-4 flex items-center gap-1.5 border-t border-border bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
          : "flex items-center gap-1.5 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
      }
    >
      {dayNav(prev, "prev")}
      <button
        type="button"
        onClick={up}
        aria-label={`Back to the itinerary${sectionIdx != null && trip.sections?.[sectionIdx] ? ` — ${trip.sections[sectionIdx].title}` : ""}`}
        className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground focus-visible:focus-ring"
      >
        <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="hidden max-w-[10rem] truncate sm:inline">
          {(sectionIdx != null && trip.sections?.[sectionIdx]?.title) || "Itinerary"}
        </span>
      </button>
      {dayNav(next, "next")}
    </div>
  );
}

/**
 * The day level's rail/sheet content (#90): the day's blocks EXACTLY as the
 * day page renders them (`DayBlocks`), with the letter chips stamped on the
 * mapped cards and the tap↔card wiring. Prev/up/next live in the `DayNav`
 * footer (desktop) — never inside this scroll flow.
 */
function DayRail({
  dayIdx,
  surface,
  activeBlock,
  onCardTap,
  scrollRootRef,
  sheetNav,
  sheetSticky,
}: {
  dayIdx: number;
  surface: DaySurface;
  activeBlock: string | null;
  onCardTap: (blockId: string | null) => void;
  scrollRootRef?: React.RefObject<HTMLElement | null>;
  /** Phone sheet only: the prev/up/next bar rides INSIDE the scroll flow. */
  sheetNav?: boolean;
  /** Phone sheet at `full` only (#109): pin the bar to the sheet's bottom
   *  edge (sticky). At `half` it stays in flow — scrolling down to reach the
   *  nav is the intended behavior there (it would eat too much of the small
   *  sheet otherwise), and the correctly-sized body makes it reachable. */
  sheetSticky?: boolean;
}) {
  const trip = useTrip();
  const { tripId = "" } = useParams();
  const day = trip.days[dayIdx];
  const letters = surface.letters;

  /** Card → map: tapping the card body (not its links/buttons) toggles the
   *  letter-chip focus on the map. The active card pulses. */
  const cardProps = (b: Block) => ({
    "data-block-id": b.id,
    "data-active-block": activeBlock === b.id ? "true" : undefined,
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("a,button,select,textarea,input")) return;
      onCardTap(activeBlock === b.id ? null : b.id);
    },
  });

  return (
    <div ref={scrollRootRef as React.Ref<HTMLDivElement> | undefined} className="flex h-full flex-col">
      <div className="space-y-5 pb-2">
        <div>
          <p className="kicker tabular-nums">
            Day {dayIdx + 1} of {trip.days.length} · {formatDay(day.date)}
          </p>
          <h2 className="mt-1 font-display text-4xl uppercase leading-none text-foreground">
            {day.title || formatDay(day.date)}
          </h2>
          <div className="mt-3">
            <MetaChips meta={day.meta} />
          </div>
        </div>

        {day.notes && (
          <div className="rounded-xl border border-border bg-muted/40 p-4">
            <p className="kicker mb-1.5">Notes</p>
            <div className="text-sm leading-relaxed text-muted-foreground">
              <Markdown>{day.notes}</Markdown>
            </div>
          </div>
        )}

        <DayBlocks
          blocks={day.blocks}
          editable={roleAtLeast(trip.myRole, "editor")}
          containerId={day.id}
          letters={letters}
          cardProps={cardProps}
        />
      </div>
      {sheetNav && (
        /* #109: at `full` the WRAPPER is sticky so the bar lifts to the sheet
           floor even with short content or slight overflow (a bar-sized
           wrapper would pin the inner bar to its flow position forever —
           measured 35px below the floor). At `half` the bar stays IN FLOW:
           scrolling down to reach the nav is the intended behavior there
           (pinned would eat ~70px of the small sheet), and the visible-region
           body fix makes the flow position reachable. */
        <div className={sheetSticky ? "sticky bottom-0 mt-auto" : "mt-auto"}>
          <DayNav trip={trip} tripId={tripId} dayIdx={dayIdx} variant="sheet" />
        </div>
      )}
    </div>
  );
}

/**
 * The trip map surface (DESIGN.md §7.6, issues #92 + #90): the itinerary scan
 * level and the day read level on the #39 layout. ONE mounted map (RouteMap
 * never remounts between levels); the rail/sheet swaps its content and the
 * URL tracks the level — in-app transitions push history, browser
 * back/forward walks levels without unmounting anything.
 */
export function TripMapSurface() {
  const trip = useTrip();
  const { tripId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const surfaceMode = useSurfaceMode();

  /* ---- the level IS the URL ---- */
  const isDayRoute = /\/day\/\d+$/.test(location.pathname);
  const rawIdx = isDayRoute ? location.pathname.match(/\/day\/(\d+)$/)?.[1] : undefined;
  const dayIdx = isDayRoute ? parseDayIdx(rawIdx, trip.days.length) : null;

  const journey = useMemo(() => tripJourney(trip), [trip]);
  const day = useMemo(
    () => (dayIdx != null ? daySurface(trip, dayIdx) : null),
    [trip, dayIdx],
  );

  /* ---- scan-level state ---- */
  const [selected, setSelected] = useState<TripLocation | null>(null);
  const [detent, setDetent] = useState<Detent>("half");
  /** The chapter in view (scroll-spy) → its places' pins stay raised. */
  const [spySection, setSpySection] = useState<number | null>(null);
  /* ---- day-level state ---- */
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  usePageTitle(
    dayIdx != null && trip.days[dayIdx]
      ? `Day ${dayIdx + 1} — ${trip.days[dayIdx].title || trip.title}`
      : trip.title
        ? `Itinerary — ${trip.title}`
        : null,
  );

  // Level-scoped state resets on every level change (including day → day):
  // a fresh level starts with no chip focus and no stale selection/spy.
  useEffect(() => {
    setActiveBlock(null);
    setSelected(null);
    setSpySection(null);
  }, [dayIdx]);

  /** The selected place's days — the scan place panel's list. */
  const dayIndex = useMemo(
    () => new Map(journey.stops.map((s) => [s.name, placeDays(trip, s.name)])),
    [trip, journey.stops],
  );
  const selectedDays = selected ? (dayIndex.get(selected.name) ?? []) : [];

  /** Marker tap at scan level: select the place and raise the sheet. */
  const selectFromMap = (loc: TripLocation) => {
    setSelected(loc);
    setDetent("half");
    // The place panel replaces the list, so the old data-stop target is gone;
    // the panel itself is the answer (RouteMapPage scrolled the list; the
    // panel is shorter and always in view at half).
  };

  /** Day level, map → rail: a chip tap raises, scrolls to and pulses its card.
   *  (#104): the scroll root IS the DayRail root element (`listRef` — scan
   *  level attaches the same ref to `ItineraryList`'s root). `scrollIntoView`
   *  with `block: "center"` walks the ancestor chain itself, which the rail's
   *  nested scroller handles correctly. */
  const tapBlockFromMap = (blockId: string) => {
    if (!blockId) {
      setActiveBlock(null);
      return;
    }
    setActiveBlock(blockId);
    setDetent("half");
    // The card scroll happens after the content is committed; rAF so the DOM
    // is settled.
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
        ?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    });
  };

  /** Rail → map: card / letter badge tap. */
  const tapCard = (blockId: string | null) => setActiveBlock(blockId);

  /** In-app level transitions — navigate() keeps the surface mounted. */
  const showDay = (i: number) => navigate(`/t/${tripId}/day/${i}`);
  const showScan = (hash = "") => navigate(`/t/${tripId}/itinerary${hash}`);

  /* Day → day: the content swaps; bring the rail/sheet back to the top. */
  useLayoutEffect(() => {
    const scroller = listRef.current?.closest("[data-scroll-root]") as HTMLElement | null;
    if (scroller) scroller.scrollTop = 0;
  }, [dayIdx, isDayRoute]);

  /* Scroll-spy (scan level only): the topmost section in the scroll container
     drives which places' pins stay raised on the map. A cheap scroll listener
     beats an IntersectionObserver here — the container is either the rail or
     the sheet body, both simple vertical scrollers. */
  useEffect(() => {
    if (isDayRoute) return;
    const root = listRef.current;
    if (!root) return;
    const scroller = (root.closest("[data-scroll-root]") as HTMLElement | null) ?? null;
    let raf = 0;
    const update = () => {
      raf = 0;
      const sections = root.querySelectorAll<HTMLElement>("section[data-section-index]");
      if (!sections.length) return;
      const top = scroller ? scroller.scrollTop : window.scrollY;
      let current = 0;
      sections.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const rootRect = scroller ? scroller.getBoundingClientRect() : { top: 0 };
        const rel = scroller ? rect.top - rootRect.top + scroller.scrollTop : rect.top + window.scrollY;
        if (rel - top <= 96) current = Number(el.dataset.sectionIndex);
      });
      setSpySection((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isDayRoute]);

  const spyPlaces = useMemo(() => {
    if (spySection == null) return null;
    const section = trip.sections?.[spySection];
    if (!section) return null;
    const refs = (section.locationRefs ?? [])
      .map((r) => findLocation(trip, r))
      .filter((l): l is TripLocation => !!l && l.lat != null);
    // The chapter's days' own located blocks raise too — an activity pinned
    // inside a chapter lights up with it.
    const days = expandDays(section.days)
      .flatMap((i) => trip.days[i]?.blocks ?? [])
      .flatMap((b) => [b.from, b.to, b.location].filter((n): n is string => !!n))
      .map((n) => findLocation(trip, n))
      .filter((l): l is TripLocation => !!l && l.lat != null);
    const all = [...refs, ...days];
    return all.length ? [...new Set(all)].map((l) => l.name) : null;
  }, [spySection, trip]);

  /* ---------------- empty trip: content-only, no map ---------------- */
  if (journey.stops.length < 1) {
    return (
      <div className="h-full overflow-y-auto" data-scroll-root="">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <ItineraryList stickyTop="0px" anchorMargin="8px" />
        </div>
      </div>
    );
  }

  /** The chip identity of the focused block (its marker's first block id). */
  const chipId =
    activeBlock && day
      ? (day.markers.find(
          (m): m is Extract<(typeof day.markers)[number], { role: "activity" }> =>
            m.role === "activity" && m.blockIds.includes(activeBlock),
        )?.blockIds[0] ?? null)
      : null;

  /* ---------------- the rail/sheet header, per level ---------------- */
  const header = isDayRoute ? (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Back to the itinerary"
        onClick={() => {
          const si = sectionIndexForDay(trip.sections, dayIdx!);
          showScan(si != null ? `#s-${si}` : "");
        }}
        className="h-9 w-9 shrink-0 rounded-full"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      </Button>
      <p className="min-w-0 flex-1 truncate text-sm font-medium">
        <span className="tabular-nums">Day {(dayIdx ?? 0) + 1}</span>
        {trip.days[dayIdx ?? 0]?.title ? ` — ${trip.days[dayIdx ?? 0].title}` : ""}
      </p>
    </div>
  ) : selected ? (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-marker-fg bg-marker text-[12px] font-bold leading-none text-marker-fg"
      >
        {markerNumber(trip, selected)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-heading text-base font-semibold leading-tight">{selected.name}</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {dayRangeLabel(selectedDays) ?? "No days scheduled here yet"}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Clear the selected place, ${selected.name}`}
        onClick={() => setSelected(null)}
        className="h-11 w-11 shrink-0 rounded-full"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  ) : (
    <div>
      <p className="kicker">The route</p>
      <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">
        {journey.stops.length} {journey.stops.length === 1 ? "place" : "places"}
        {trip.days.length > 0 && ` · ${trip.days.length} days`}
        {journey.legs.length > 0 &&
          ` · ${journey.legs.length} ${journey.legs.length === 1 ? "leg" : "legs"}`}
        {journey.loop && " · returns to the start"}
        {journey.excursions.length > 0 &&
          ` · ${journey.excursions.length} side trip${journey.excursions.length === 1 ? "" : "s"}`}
      </p>
    </div>
  );

  /* ---------------- the rail/sheet content, per level ---------------- */
  const content = isDayRoute ? (
    <DayRail
      key={dayIdx ?? 0}
      dayIdx={dayIdx ?? 0}
      surface={day ?? { markers: [], legs: [], endpoints: [], letters: new Map() }}
      activeBlock={activeBlock}
      onCardTap={tapCard}
      scrollRootRef={listRef}
      sheetNav={surfaceMode === "sheet"}
      sheetSticky={surfaceMode === "sheet" && detent === "full"}
    />
  ) : selected ? (
    <PlacePanel
      place={selected}
      days={selectedDays}
      onClear={() => setSelected(null)}
      onOpenDay={showDay}
    />
  ) : (
    <ItineraryList
      stickyTop="0px"
      stickyInset="-mx-5 px-5"
      anchorMargin="8px"
      rootRef={listRef}
      onSelectPlace={(name) => setSelected(name ? (findLocation(trip, name) ?? null) : null)}
      /* This branch only renders when no place is selected. */
      selectedPlace={null}
    />
  );

  return (
    <div className="trip-map-surface h-full">
      <SplitView
        label={
          isDayRoute
            ? `${trip.title} — day ${(dayIdx ?? 0) + 1}`
            : `${trip.title} — the itinerary and the route`
        }
        header={header}
        content={content}
        /* #104: the day level's prev/up/next bar rides OUTSIDE the scroller
           (desktop + landscape-phone footer slot) so it pins flush to the rail
           edge; the phone sheet keeps the bar in-flow sticky instead. */
        footer={
          isDayRoute && dayIdx != null && surfaceMode !== "sheet" ? (
            <DayNav trip={trip} tripId={tripId} dayIdx={dayIdx} />
          ) : undefined
        }
        detent={detent}
        onDetentChange={setDetent}
        map={(padding) => (
          <RouteMap
            journey={journey}
            padding={padding}
            selected={selected}
            onSelect={selectFromMap}
            spyPlaces={isDayRoute ? null : spyPlaces}
            day={day}
            dayIdx={dayIdx}
            activeBlock={chipId}
            onBlockTap={tapBlockFromMap}
          />
        )}
      />
    </div>
  );
}
