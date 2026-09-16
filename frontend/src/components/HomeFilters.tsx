import { useEffect, useId, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { SEASON_MONTHS, type Season } from "../lib/home";
import type { Stage, Visibility } from "../lib/types";

/**
 * The discovery home's search + filters (#249, slice 4 — reviewed).
 *
 * The first cut put every facet on screen at once: two text boxes and fifteen
 * pills, which reads as a control panel, not as a home. The rule now is
 * **one visible control plus a door**: a single search box (title, subtitle
 * and the trip's map anchor all at once — "where" is part of what you are
 * looking for), and a `Filters` button with a badge for how many facets are
 * narrowing the list.
 *
 * The panel renders **in the page flow, below the row** — never as an
 * absolutely-positioned popover. This surface lives in the `SplitView`
 * rail/sheet furniture, whose scroll body is `overflow-y-auto`; a popover would
 * simply be clipped at the rail's edge on a phone. In flow it inherits the
 * column's width and the sheet scrolls to it.
 *
 * Only facets that can return something are offered (`stageChips`,
 * `seasonChips`, `visibilityChips` are pre-filtered by the page against the
 * loaded trips), so no chip is a dead click.
 */
export interface HomeFiltersProps {
  query: string;
  onQueryChange: (q: string) => void;
  /** Stages present in the loaded trips, in stage-weight order. */
  stageChips: Stage[];
  stages: readonly Stage[];
  onToggleStage: (stage: Stage) => void;
  /** Seasons present in the loaded trips, in calendar order. */
  seasonChips: Season[];
  months: readonly number[];
  onToggleSeason: (season: Season) => void;
  originSel: "all" | "mine" | "following";
  onOriginSel: (sel: "all" | "mine" | "following") => void;
  /** Visibilities present in the loaded trips. */
  visibilityChips: Visibility[];
  vis: readonly Visibility[];
  onToggleVisibility: (v: Visibility) => void;
  /** Facets narrowing the list — the button's badge. Text is not a facet. */
  activeCount: number;
  onClearAll: () => void;
}

/** The chip both facet groups and seasons use: one look, one behaviour. */
function Chip({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`h-8 rounded-full border px-3 text-xs font-medium capitalize transition-colors focus-visible:focus-ring ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

/** One labelled row inside the panel. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function HomeFilters({
  query,
  onQueryChange,
  stageChips,
  stages,
  onToggleStage,
  seasonChips,
  months,
  onToggleSeason,
  originSel,
  onOriginSel,
  visibilityChips,
  vis,
  onToggleVisibility,
  activeCount,
  onClearAll,
}: HomeFiltersProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // Escape closes, like every other transient surface on a map (#109's sheet
  // reads the same key). Clicking away closes too — the panel is a door, not a
  // mode, and leaving it open over the bands wastes the rail.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="mt-4">
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search trips by name, note or place</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search trips, places…"
            className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:focus-ring"
          />
        </label>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className={`flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:focus-ring ${
            open || activeCount > 0
              ? "border-primary/40 bg-card text-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          Filters
          {activeCount > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold tabular-nums text-primary-foreground">
              {activeCount}
            </span>
          )}
        </button>
      </div>

      {open && (
        <div
          id={panelId}
          data-home-filters=""
          className="mt-2 flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
        >
          {stageChips.length > 0 && (
            <Group label="Stage">
              {stageChips.map((stage) => (
                <Chip
                  key={stage}
                  active={stages.includes(stage)}
                  onClick={() => onToggleStage(stage)}
                  label={stage}
                />
              ))}
            </Group>
          )}
          {seasonChips.length > 0 && (
            <Group label="Season">
              {seasonChips.map((season) => {
                const active = SEASON_MONTHS[season].every((m) => months.includes(m));
                return (
                  <Chip
                    key={season}
                    active={active}
                    onClick={() => onToggleSeason(season)}
                    label={season}
                    title="Trips starting in this season"
                  />
                );
              })}
            </Group>
          )}
          <Group label="Whose trips">
            {(["all", "mine", "following"] as const).map((sel) => (
              <Chip
                key={sel}
                active={originSel === sel}
                onClick={() => onOriginSel(sel)}
                label={sel === "all" ? "All" : sel === "mine" ? "Mine" : "Following"}
              />
            ))}
          </Group>
          {visibilityChips.length > 0 && (
            <Group label="Visibility">
              {visibilityChips.map((v) => (
                <Chip
                  key={v}
                  active={vis.includes(v)}
                  onClick={() => onToggleVisibility(v)}
                  label={v}
                />
              ))}
            </Group>
          )}
          {activeCount > 0 && (
            <button
              type="button"
              onClick={onClearAll}
              className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
