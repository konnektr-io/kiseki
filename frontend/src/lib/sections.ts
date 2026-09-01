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
