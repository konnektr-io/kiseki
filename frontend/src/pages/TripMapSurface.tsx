import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CalendarDays, X } from "lucide-react";
import { useTrip } from "../components/theme";
import { RouteMap } from "../components/RouteMap";
import { ItineraryList } from "../components/ItineraryList";
import { InlineField } from "../components/inline-edit";
import { SplitView, useSurfaceMode } from "../components/SplitView";
import { Button } from "../components/ui";
import { DayBlocks, MetaChips } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";
import { sectionIndexForDay } from "../lib/sections";
import { withDayFields } from "../lib/editing";
import { useCanEdit } from "../components/edit-mode";
import { putTripDay } from "../lib/api";
import { useTripWrite } from "../lib/useTripWrite";
import { capture } from "../lib/posthog";
import { markerNumber, findLocation, prefersReducedMotion } from "../lib/maps";
import { tripJourney } from "../lib/route-surface";
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
 * Scan-level selection toggle: tapping the already-selected pin clears the
 * selection (ring off, pill highlight off), tapping another pin moves it.
 * Pure so the pin-tap contract is unit-testable (node env has no DOM taps).
 */
export function togglePlaceSelection(
  prev: TripLocation | null,
  loc: TripLocation,
): TripLocation | null {
  return prev?.name === loc.name ? null : loc;
}

/**
 * The scan level's place-selection model — what a marker tap DOES in the
 * rail/sheet.
 *
 * Selection is highlight + scroll-to-pill, never a content swap: the
 * itinerary list stays mounted, the selected place's pin gets its ring on the
 * map, its pills highlight in the rail, and the rail scrolls the first
 * matching pill into view with a brief flash. Days open the day level — an
 * in-app state transition, the map stays alive. Place facts (Maps link,
 * address, website, types, summary) live on the day-view blocks that resolve
 * to the place (`PlaceFacts`), not here.
 *
 * Exported for the scroll-helper unit tests; the tree stays auth-agnostic
 * (no role branching — pitfall 16).
 */
export function scrollToPlacePill(root: ParentNode | null, name: string): boolean {
  if (!root) return false;
  // Match on the attribute value rather than a `[data-place-pill="<name>"]`
  // selector — place names carry quotes/parens (no CSS.escape needed, no
  // selector-injection shape to worry about).
  const pills = Array.from(root.querySelectorAll("[data-place-pill]"));
  const target = pills.find((el) => el.getAttribute("data-place-pill") === name) as
    | HTMLElement
    | undefined;
  // No matching pill anywhere (the place is in no section's locationRefs):
  // ring only, no scroll — not an error.
  if (!target) return false;
  // jsdom/node has no scrollIntoView — guard so unit tests don't explode.
  if (typeof target.scrollIntoView === "function") {
    // Confine the scroll to the rail/sheet's own scroller ([data-scroll-root]):
    // scrollIntoView walks the ancestor chain, and on the phone sheet the
    // nearest scrollable box ABOVE the scroller is the .map-surface wrapper —
    // scrolling it drags the whole surface up (see scrollWithinScroller).
    scrollWithinScroller(
      target,
      "nearest",
      prefersReducedMotion() ? "auto" : "smooth",
    );
  }
  // Flash the pill so the eye lands on it; state change only under
  // prefers-reduced-motion (the global CSS guard covers the animation too).
  if (!prefersReducedMotion() && target.classList) {
    target.classList.add("place-pill-flash");
    setTimeout(() => target.classList.remove("place-pill-flash"), 1200);
  }
  return true;
}

/**
 * Scroll `el` into view inside the rail/sheet's OWN scroller — never an
 * ancestor of it.
 *
 * `Element.scrollIntoView` walks the WHOLE ancestor chain looking for
 * scrollable boxes. On the phone sheet the nearest scrollable ancestor above
 * the sheet body is the `.map-surface` wrapper (`overflow-hidden` still
 * scrolls via scrollTop), so centering a day card scrolled THAT wrapper too:
 * the whole map+sheet box slid up (measured `scrollTop = 244`), pushing the
 * in-flow day nav out of the viewport and exposing the sheet's off-screen
 * lower layout region as dead space (v0.23.x mobile regression — day view
 * only; on desktop the SplitView rail is the nearest scroller, so nothing
 * above it ever moved and the bug stayed invisible).
 *
 * Confinement: compute the element's offset relative to the nearest
 * `[data-scroll-root]` (the same convention the day→day scroll reset and the
 * scroll-spy already use) and set that scroller's scrollTop directly.
 */
export function scrollWithinScroller(
  el: Element,
  block: "nearest" | "center",
  behavior: ScrollBehavior,
): void {
  // jsdom fakes carry scrollIntoView but no closest — guard keeps the unit
  // tests' fake elements on the fallback path.
  const scroller =
    typeof el.closest === "function"
      ? (el.closest("[data-scroll-root]") as HTMLElement | null)
      : null;
  if (!scroller) {
    // No scroller found (non-DOM env, or a future layout without the
    // attribute): fall back to scrollIntoView rather than not scrolling.
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block, behavior });
    return;
  }
  const sRect = scroller.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  // Element top in the scroller's content coordinates (unaffected by the
  // scroller's own current scrollTop — both rects move together).
  const relTop = eRect.top - sRect.top + scroller.scrollTop;
  let top: number | null;
  if (block === "center") {
    top = relTop - Math.max(0, (sRect.height - eRect.height) / 2);
  } else {
    // "nearest": only adjust when the element sits outside the visible box.
    const pad = 8;
    if (relTop < scroller.scrollTop + pad) {
      top = relTop - pad;
    } else if (relTop + eRect.height > scroller.scrollTop + sRect.height - pad) {
      top = relTop + eRect.height + pad - sRect.height;
    } else {
      top = null; // already fully visible — no scroll
    }
  }
  if (top === null) return;
  if (behavior === "smooth" && typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top, behavior: "smooth" });
  } else {
    scroller.scrollTop = top;
  }
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
        className="h-11 min-w-0 flex-1 justify-start gap-2 rounded-lg px-2.5 text-left md:px-3 @container"
      >
        {d === "prev" ? <ArrowLeft className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
        <span className="min-w-0 flex flex-col">
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
  const { run, error } = useTripWrite();
  const canEdit = useCanEdit();

  const saveDayField = (field: "title" | "notes") => async (next: string) => {
    capture("trip_day_updated", { field });
    return (
      (await run(
        (token) => putTripDay(trip.id, day.id, { [field]: next }, token),
        (t) => withDayFields(t, day.id, { [field]: next }),
      )) !== null
    );
  };

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
          {/* #296 — the day title fixes inline, where the day is read. An
              untitled day shows its date until an editor names it. */}
          <InlineField
            value={day.title}
            label="Day title"
            canEdit={canEdit}
            error={error}
            placeholder={formatDay(day.date)}
            onSave={saveDayField("title")}
            renderDisplay={(v) => (
              <h2 className="mt-1 font-display text-4xl uppercase leading-none text-foreground">
                {v || formatDay(day.date)}
              </h2>
            )}
          />
          <div className="mt-3">
            <MetaChips meta={day.meta} />
          </div>
        </div>

        {/* #296 — day notes fix inline too (markdown, like everywhere else).
            Editors on a noteless day get an "Add notes" ghost, not nothing. */}
        <InlineField
          value={day.notes ?? ""}
          label="Day notes"
          canEdit={canEdit}
          error={error}
          multiline
          placeholder="Notes for this day (markdown)"
          emptyLabel="Add notes"
          onSave={saveDayField("notes")}
          renderDisplay={(v) => (
            <div className="rounded-xl border border-border bg-muted/40 p-4">
              <p className="kicker mb-1.5">Notes</p>
              <div className="text-sm leading-relaxed text-muted-foreground">
                <Markdown>{v}</Markdown>
              </div>
            </div>
          )}
        />

        <DayBlocks
          blocks={day.blocks}
          editable={canEdit}
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
  /** The chapters currently in view (scroll-spy) → their places' pins stay raised. */
  const [spySections, setSpySections] = useState<Set<number>>(new Set());
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
    setSpySections(new Set());
  }, [dayIdx]);

  /** Marker tap at scan level: toggle the place and raise the sheet. The
   *  rail list stays mounted — the scroll effect below brings the place's
   *  pill into view. */
  const selectFromMap = (loc: TripLocation) => {
    setSelected((prev) => togglePlaceSelection(prev, loc));
    setDetent("half");
  };

  /* Scan-level pin tap → pill scroll: when a place becomes selected on the
     itinerary route, scroll its pill into view inside the rail/sheet scroller
     and flash it (scrollToPlacePill — ring only when no pill matches). Day
     level has no pills: pin tap there keeps the existing behavior only (pin
     ring + card pulse via cardProps). The cleanup clears a lingering flash
     when the selection moves on before its timeout fired. */
  useEffect(() => {
    if (isDayRoute || !selected) return;
    scrollToPlacePill(listRef.current, selected.name);
    return () => {
      listRef.current
        ?.querySelectorAll(".place-pill-flash")
        .forEach((el) => el.classList.remove("place-pill-flash"));
    };
  }, [selected, isDayRoute]);

  /** Day level, map → rail: a chip tap raises, scrolls to and pulses its card.
   *  (#104): the scroll root IS the DayRail root element (`listRef` — scan
   *  level attaches the same ref to `ItineraryList`'s root). The scroll is
   *  confined to the nearest `[data-scroll-root]` scroller
   *  (scrollWithinScroller): plain `scrollIntoView` walks the ancestor chain
   *  and on the phone sheet also scrolled the `.map-surface` wrapper itself —
   *  the whole surface slid up, the in-flow day nav left the viewport and the
   *  sheet's off-screen layout region showed as dead space. */
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
      const card = listRef.current?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
      if (card) scrollWithinScroller(card, "center", reducedMotion() ? "auto" : "smooth");
    });
  };

  /** Rail → map: card / letter badge tap. */
  const tapCard = (blockId: string | null) => setActiveBlock(blockId);

  /** In-app level transitions — navigate() keeps the surface mounted. */
  const showScan = (hash = "") => navigate(`/t/${tripId}/itinerary${hash}`);

  /* Day → day: the content swaps; bring the rail/sheet back to the top.
   *
   * DAY LEVEL ONLY. The scan level's arrival position is owned by
   * ItineraryList, which resolves its own precedence chain (`#s-<n>` chapter
   * anchor → the "you were here" restore → today). Layout effects fire
   * CHILD-FIRST, so ItineraryList's anchor scroll has already happened by the
   * time this parent effect runs — resetting here unconditionally clobbered it
   * and dumped every Overview-TOC / DayNav "up" jump at the top of the
   * itinerary (#218). Entering a day still resets (`isDayRoute` false → true,
   * or day → day), which is what this effect was actually written for. A
   * same-level hash change (an in-scan TOC tap) leaves both deps untouched, so
   * this effect simply does not re-run there. */
  useLayoutEffect(() => {
    if (!isDayRoute) return;
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
      const viewH = scroller ? scroller.clientHeight : window.innerHeight;
      const viewBottom = top + viewH;
      let best: number | null = null;
      let bestOverlap = 0;
      for (const el of sections) {
        const rect = el.getBoundingClientRect();
        const rootRect = scroller ? scroller.getBoundingClientRect() : { top: 0 };
        const relTop = scroller ? rect.top - rootRect.top + scroller.scrollTop : rect.top + window.scrollY;
        const relBottom = relTop + rect.height;
        if (relBottom <= top - 96 || relTop >= viewBottom + 96) continue;
        const overlap = Math.min(relBottom, viewBottom + 96) - Math.max(relTop, top - 96);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = Number(el.dataset.sectionIndex);
        }
      }
      if (best == null) {
        // Degenerate frames (rubber-band overscroll, sticky-header bounce): keep
        // the previous focus rather than flashing every pin.
        return;
      }
      // Rail ends: before the first / after the last section, show the
      // nearest section instead of nothing.
      const first = Number(sections[0].dataset.sectionIndex);
      const last = Number(sections[sections.length - 1].dataset.sectionIndex);
      let focus = best;
      if (best === first) {
        const s0 = sections[0].getBoundingClientRect();
        const r0 = scroller ? s0.top - scroller.getBoundingClientRect().top + scroller.scrollTop : s0.top + window.scrollY;
        if (r0 >= top) focus = first;
      } else if (best === last) {
        const sl = sections[sections.length - 1].getBoundingClientRect();
        const rEnd = scroller ? sl.bottom - scroller.getBoundingClientRect().top + scroller.scrollTop : sl.bottom + window.scrollY;
        if (rEnd <= viewBottom) focus = last;
      }
      setSpySections((prev) => (prev.size === 1 && prev.has(focus) ? prev : new Set([focus])));
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
    if (!spySections.size) return null;
    const si = [...spySections][0];
    const section = trip.sections?.[si];
    if (!section) return null;
    const places = new Map<string, TripLocation>();
    for (const r of section.locationRefs ?? []) {
      const l = findLocation(trip, r);
      if (l && l.lat != null) places.set(l.name, l);
    }
    for (const i of expandDays(section.days)) {
      for (const b of trip.days[i]?.blocks ?? []) {
        for (const n of [b.from, b.to, b.location].filter((n): n is string => !!n)) {
          const l = findLocation(trip, n);
          if (l && l.lat != null) places.set(l.name, l);
        }
      }
    }
    return places.size ? [...places.values()].map((l) => l.name) : null;
  }, [spySections, trip]);

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
          On the map — its pill is highlighted below
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

  /* #109 follow-up: a scroller's sticky constraint rect is the scrollport
     INSET BY ITS PADDING (SplitView rail/split = px-5/py-4, side = px-4/py-3,
     sheet body = px-4). Left alone, the pinned chapter bar hangs 16px down
     and scrolled content slides visibly through the gap above it — and an
     inset wider than the scroller's own padding overhangs the panel edge
     (4px on the sheet, poking past its rounded corners). Both get
     mode-matched values: a compensating negative `top` pins the bar flush,
     and the inset matches the scroller's padding exactly. */
  const stickyChrome = surfaceMode === "sheet"
    ? { top: "0px", inset: "-mx-4 px-4" }
    : surfaceMode === "side"
      ? { top: "-12px", inset: "-mx-4 px-4" }
      : { top: "-16px", inset: "-mx-5 px-5" };

  /* ---------------- the rail/sheet content, per level ---------------- */
  const content = isDayRoute ? (
    <DayRail
      key={dayIdx ?? 0}
      dayIdx={dayIdx ?? 0}
      surface={day ?? { markers: [], legs: [], endpoints: [], letters: new Map(), tracks: [] }}
      activeBlock={activeBlock}
      onCardTap={tapCard}
      scrollRootRef={listRef}
      sheetNav={surfaceMode === "sheet"}
      sheetSticky={surfaceMode === "sheet" && detent === "full"}
    />
  ) : (
    /* Scan level: the itinerary list stays mounted whether or not a place is
       selected — selection is highlight + scroll-to-pill, never a swap. */
    <ItineraryList
      stickyTop={stickyChrome.top}
      stickyInset={stickyChrome.inset}
      anchorMargin="8px"
      rootRef={listRef}
      onSelectPlace={(name) => setSelected(name ? (findLocation(trip, name) ?? null) : null)}
      selectedPlace={selected?.name ?? null}
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
