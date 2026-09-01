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
