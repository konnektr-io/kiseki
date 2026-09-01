import type { TripSection } from "./types";

/** Trip sections store an inclusive day-index RANGE ([first, last]) — expand it
 *  to the full day list for rendering. Used by the itinerary + booklet. */
export function expandSectionDays(days: number[] | undefined): number[] {
  if (!days || days.length === 0) return [];
  if (days.length === 2 && days[1] >= days[0]) {
    const out: number[] = [];
    for (let i = days[0]; i <= days[1]; i++) out.push(i);
    return out;
  }
  return days;
}

/** Human label for a section's day range, derived from its (0-based) day
 *  indices — DESIGN.md §7.5: titles name the place/theme, the range is derived
 *  and rendered. "Days 3–5" for [2,4], "Day 10" for [9,9], null when empty. */
export function sectionRange(days: number[] | undefined): string | null {
  const d = expandSectionDays(days);
  if (!d.length) return null;
  const contiguous = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
  if (contiguous) {
    const first = d[0] + 1;
    const last = d[d.length - 1] + 1;
    return first === last ? `Day ${first}` : `Days ${first}\u2013${last}`;
  }
  return `Days ${d.map((v) => v + 1).join(", ")}`;
}

/** Index of the section that contains the given (0-based) day index, or
 *  undefined when the day belongs to no section. The day page's "up" button
 *  uses this to return to its chapter anchor (DESIGN.md §7.5). */
export function sectionIndexForDay(sections: TripSection[] | undefined, dayIdx: number): number | undefined {
  if (!sections?.length) return undefined;
  const si = sections.findIndex((s) => expandSectionDays(s.days).includes(dayIdx));
  return si === -1 ? undefined : si;
}

/** One renderable row inside a section: a single day, or a FOLDED group of
 *  consecutive days shown as one card (`fold` on the section — display-only,
 *  the days themselves still exist and keep their day pages). */
export type ItineraryItem =
  | { kind: "day"; idx: number }
  | { kind: "fold"; title: string; indices: number[] };

/** Expand a section into its itinerary rows: every day in its range, except
 *  day groups listed in `section.fold`, which collapse into one fold item.
 *  Fold groups must be consecutive and fully inside the section's range —
 *  anything else is ignored (rendered as plain days). */
export function itineraryItems(section: TripSection): ItineraryItem[] {
  const days = expandSectionDays(section.days);
  if (!days.length) return [];
  const folds = (section.fold ?? []).filter(
    (f) => f.days.length >= 2 && f.days.every((d, i) => i === 0 || d === f.days[i - 1] + 1) && f.days.every((d) => days.includes(d)),
  );
  const items: ItineraryItem[] = [];
  let i = 0;
  while (i < days.length) {
    const fold = folds.find((f) => f.days[0] === days[i]);
    if (fold) {
      items.push({ kind: "fold", title: fold.title, indices: fold.days });
      i += fold.days.length;
    } else {
      items.push({ kind: "day", idx: days[i] });
      i += 1;
    }
  }
  return items;
}
