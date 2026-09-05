import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Car, MapPin, Plane, Ship, Train, X } from "lucide-react";
import { useTrip } from "../components/theme";
import { RouteMap } from "../components/RouteMap";
import { SplitView } from "../components/SplitView";
import { Button } from "../components/ui";
import { formatDay } from "../lib/dates";
import { usePageTitle } from "../lib/seo";
import { markerNumber } from "../lib/maps";
import {
  LEG_STAGE_LABELS,
  dayRangeLabel,
  placeDays,
  tripJourney,
  type JourneyLeg,
  type LegStage,
} from "../lib/route-surface";
import type { Detent } from "../lib/sheet";
import type { Block, TripLocation } from "../lib/types";

/** The numbered pin, as a list glyph — the same ordinal the map draws (§8.3). */
function Pin({ n, dimmed = false }: { n: number; dimmed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border border-marker-fg bg-marker text-[12px] font-bold leading-none text-marker-fg ${
        dimmed ? "opacity-45" : ""
      }`}
    >
      {n}
    </span>
  );
}

const MODE_ICON = { flight: Plane, train: Train, ferry: Ship, drive: Car } as const;

function legIcon(block: Block | undefined) {
  const Icon = (block?.mode && MODE_ICON[block.mode]) || Car;
  return <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
}

/**
 * The leg between two stops, in the list.
 *
 * It carries the same three states the map draws, in words — the list is the
 * accessible path to a map surface (§11), so "this leg is still provisional"
 * has to be readable and not only dashed. A leg with no speaking block reads
 * "Provisional" with no card facts — there is genuinely no plan for it (#91),
 * and the fallback title names the two places it would join.
 */
function LegRow({ leg }: { leg: JourneyLeg }) {
  const border: Record<LegStage, string> = {
    provisional: "border-l border-dashed border-border",
    planned: "border-l border-border",
    booked: "border-l-2 border-primary/50",
  };
  const facts = [leg.block?.distance, leg.block?.duration].filter(Boolean).join(" · ");
  return (
    <div className={`ml-3.5 flex items-center gap-2 py-2 pl-4 ${border[leg.stage]}`}>
      {legIcon(leg.block)}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {leg.block?.title ?? `${leg.from.name} → ${leg.to.name}`}
        {facts && <span className="tabular-nums"> · {facts}</span>}
      </span>
      <span
        className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] ${
          leg.stage === "booked" ? "text-accent" : "text-muted-foreground"
        }`}
      >
        {LEG_STAGE_LABELS[leg.stage]}
      </span>
    </div>
  );
}

export function RouteMapPage() {
  const trip = useTrip();
  const { tripId = "" } = useParams();
  const [selected, setSelected] = useState<TripLocation | null>(null);
  const [detent, setDetent] = useState<Detent>("half");
  const listRef = useRef<HTMLOListElement>(null);

  usePageTitle(trip.title ? `Route — ${trip.title}` : null);

  const journey = useMemo(() => tripJourney(trip), [trip]);
  const dayIndex = useMemo(
    () => new Map(journey.stops.map((s) => [s.name, placeDays(trip, s.name)])),
    [trip, journey.stops],
  );

  /** Marker tap: reveal that place's days without burying the map (§7.3). */
  const selectFromMap = (loc: TripLocation) => {
    setSelected(loc);
    setDetent("half");
    listRef.current
      ?.querySelector(`[data-stop="${CSS.escape(loc.name)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  if (journey.stops.length < 1) {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <MapPin className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="font-heading text-lg font-semibold">No places on the map yet</p>
        <p className="text-sm text-muted-foreground">
          The route draws itself from the trip's places. Add one with coordinates and it appears
          here, numbered, alongside the itinerary.
        </p>
        <Link
          to={`/t/${tripId}/itinerary`}
          className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
        >
          Back to the itinerary <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    );
  }

  const selectedDays = selected ? (dayIndex.get(selected.name) ?? []) : [];

  const header = selected ? (
    <div className="flex items-center gap-2.5">
      <Pin n={markerNumber(trip, selected)} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-heading text-base font-semibold leading-tight">
          {selected.name}
        </p>
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

  const content = (
    // The keyboard path to every place on the map. Not a fallback — a WebGL
    // canvas is not accessible, so this IS the accessible surface (§11).
    <ol ref={listRef} className="pb-6">
      {journey.chain.map((stop) => {
        const days = dayIndex.get(stop.name) ?? [];
        const isSelected = selected?.name === stop.name;
        // Each stop departs on exactly one leg — including the last, whose leg
        // is the closing one back to the start when the trip loops.
        const leg = journey.legs.find((l) => l.from === stop);
        return (
          <li key={stop.name} data-stop={stop.name}>
            <Button
              variant="ghost"
              size="auto"
              aria-pressed={isSelected}
              onClick={() => setSelected(isSelected ? null : stop)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left ${
                isSelected ? "bg-primary/10" : ""
              }`}
            >
              <Pin n={markerNumber(trip, stop)} dimmed={!!selected && !isSelected} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-heading text-[15px] font-semibold leading-tight">
                  {stop.name}
                </span>
                <span className="block text-xs tabular-nums text-muted-foreground">
                  {dayRangeLabel(days) ?? "Not scheduled yet"}
                </span>
              </span>
            </Button>

            {/* The selected place's days — the marker → sheet interaction the
                surface exists for, and the way into the day pages. */}
            {isSelected && days.length > 0 && (
              <ul className="mb-1 ml-9 space-y-0.5 border-l border-border pl-3">
                {days.map((d) => (
                  <li key={d}>
                    <Link
                      to={`/t/${tripId}/day/${d}`}
                      className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
                        Day {d + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {trip.days[d]?.title || formatDay(trip.days[d]?.date ?? "")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {leg && <LegRow leg={leg} />}
          </li>
        );
      })}
    </ol>
  );

  // Excursions are not chain members, so they must not pretend to be: they
  // ride under the route as "side trips" — diamond glyph (the same marker the
  // map draws), days, days-link list. The keyboard/reader path to them stays
  // real without ever suggesting a leg passes through them (§11, #91).
  const excursions =
    journey.excursions.length > 0 ? (
      <section aria-label="Side trips" className="mt-4 border-t border-border pt-3">
        <p className="kicker">Side trips</p>
        <ul className="pb-6">
          {journey.excursions.map((stop) => {
            const days = dayIndex.get(stop.name) ?? [];
            const isSelected = selected?.name === stop.name;
            return (
              <li key={stop.name} data-stop={stop.name}>
                <Button
                  variant="ghost"
                  size="auto"
                  aria-pressed={isSelected}
                  onClick={() => setSelected(isSelected ? null : stop)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left ${
                    isSelected ? "bg-primary/10" : ""
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-7 w-7 shrink-0 rotate-45 place-items-center rounded-[4px] border-2 border-marker bg-surface ${
                      selected && !isSelected ? "opacity-45" : ""
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-heading text-[15px] font-semibold leading-tight">
                      {stop.name}
                    </span>
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      {dayRangeLabel(days) ?? "Not scheduled yet"}
                    </span>
                  </span>
                </Button>
                {isSelected && days.length > 0 && (
                  <ul className="mb-1 ml-9 space-y-0.5 border-l border-border pl-3">
                    {days.map((d) => (
                      <li key={d}>
                        <Link
                          to={`/t/${tripId}/day/${d}`}
                          className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                        >
                          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
                            Day {d + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {trip.days[d]?.title || formatDay(trip.days[d]?.date ?? "")}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    ) : null;

  const contentWithExcursions = (
    <>
      {content}
      {excursions}
    </>
  );

  return (
    <SplitView
      label={`${trip.title} — places and legs`}
      header={header}
      content={contentWithExcursions}
      detent={detent}
      onDetentChange={setDetent}
      map={(padding) => (
        <RouteMap
          journey={journey}
          padding={padding}
          selected={selected}
          onSelect={selectFromMap}
        />
      )}
    />
  );
}
