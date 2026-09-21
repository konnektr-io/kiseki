import type { Stage, Trip } from "./types";
import { expandSectionDays } from "./sections";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-02-15" → "Mon 15 Feb" */
export function formatDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "2027-02-15" → "Feb 15, 2027" */
export function formatDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Number of days between two ISO dates (inclusive of both). */
export function dayCount(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = new Date(`${start}T12:00:00`).getTime();
  const b = new Date(`${end}T12:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function formatMoney(cost?: number, currency?: string): string | null {
  if (cost == null) return null;
  const n = cost.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return currency ? `${n} ${currency}` : n;
}

/* ------------------------------------------------------------------ */
/* Today / timezone-aware helpers (issue #42)                        */
/* ------------------------------------------------------------------ */

/** Minimal date surface for the today helpers — nullable so cards,
 *  summaries and documents all fit (#362). */
export interface DateCarrier {
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string | null;
}

/** Trip-local "today" as YYYY-MM-DD, resolved in the trip's IANA timezone when set. */
export function tripTodayIso(trip: DateCarrier, now = new Date()): string {
  const tz = trip.timezone?.trim();
  if (tz) {
    try {
      // Intl.DateTimeFormat with en-CA gives YYYY-MM-DD, but use formatToParts
      // so we're not dependent on locale formatting quirks.
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = fmt.formatToParts(now);
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
      // fallback to formatted string if parts unexpected
      const s = fmt.format(now);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    } catch {
      // invalid IANA zone → fall through to viewer-local
    }
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** True when today (trip-local) lies within [startDate, endDate] inclusive. */
export function isTodayInRange(trip: DateCarrier, todayIso?: string): boolean {
  if (!trip.startDate || !trip.endDate) return false;
  const today = todayIso ?? tripTodayIso(trip);
  return today >= trip.startDate && today <= trip.endDate;
}

/** The stage a carrier reads as — the "happening now" decision (#362).
 *
 *  Prefers the server's `effectiveStage` (trip-local derivation); falls back
 *  to the same rule locally so older servers still flip. Stored `stage` is
 *  authorial intent (badges, settings); this is what Today / Up-next follow.
 */
export type StageCarrier = DateCarrier & {
  stage: Stage;
  effectiveStage?: Stage;
};

export function displayStage(t: StageCarrier): Stage {
  if (t.effectiveStage) return t.effectiveStage;
  if ((t.stage === "planned" || t.stage === "booked") && isTodayInRange(t)) return "live";
  return t.stage;
}

/** True when the Today surface should be offered (live + in-range). */
export function shouldShowToday(trip: StageCarrier, todayIso?: string): boolean {
  return displayStage(trip) === "live" && isTodayInRange(trip, todayIso);
}

function daysBetween(aIso: string, bIso: string): number | null {
  const a = new Date(`${aIso}T12:00:00`).getTime();
  const b = new Date(`${bIso}T12:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export type TodayResolution =
  | { kind: "no-dates"; todayIso: string }
  | { kind: "before"; todayIso: string; daysUntil: number }
  | { kind: "after"; todayIso: string; daysSinceEnd: number }
  | { kind: "day"; todayIso: string; dayIdx: number; sectionIdx?: number }
  | { kind: "section"; todayIso: string; sectionIdx: number; nearestDayIdx?: number }
  | { kind: "nearest-day"; todayIso: string; dayIdx: number };

/** Resolve "today" for a trip into the degradation table from #42. */
export function resolveToday(trip: Trip, todayIso?: string): TodayResolution {
  const today = todayIso ?? tripTodayIso(trip);

  if (!trip.startDate || !trip.endDate) {
    return { kind: "no-dates", todayIso: today };
  }

  if (today < trip.startDate) {
    const diff = daysBetween(today, trip.startDate);
    return { kind: "before", todayIso: today, daysUntil: diff ?? 0 };
  }
  if (today > trip.endDate) {
    const diff = daysBetween(trip.endDate, today);
    return { kind: "after", todayIso: today, daysSinceEnd: diff ?? 0 };
  }

  // In range: try exact day match
  const exactIdx = trip.days.findIndex((d) => d.date === today);
  if (exactIdx !== -1) {
    const sectionIdx = trip.sections?.findIndex((s) => expandSectionDays(s.days).includes(exactIdx));
    return { kind: "day", todayIso: today, dayIdx: exactIdx, sectionIdx: sectionIdx !== -1 ? sectionIdx : undefined };
  }

  // No Day for that date: try enclosing section by offset from startDate
  const offset = daysBetween(trip.startDate, today);
  if (offset != null && trip.sections?.length) {
    for (let si = 0; si < trip.sections.length; si++) {
      const expanded = expandSectionDays(trip.sections[si].days);
      if (expanded.includes(offset)) {
        // pick nearest existing day within that section, if any
        const nearest = expanded.find((idx) => idx >= 0 && idx < trip.days.length);
        return { kind: "section", todayIso: today, sectionIdx: si, nearestDayIdx: nearest };
      }
    }
  }

  // Fallback: nearest day by date proximity (trip is continuous, this is the honest fallback)
  if (trip.days.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < trip.days.length; i++) {
      const dist = Math.abs(daysBetween(trip.days[i].date, today) ?? Infinity);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return { kind: "nearest-day", todayIso: today, dayIdx: bestIdx };
  }

  // In range but trip has no days at all — surface the section that covers today
  if (trip.sections?.length && offset != null) {
    for (let si = 0; si < trip.sections.length; si++) {
      if (expandSectionDays(trip.sections[si].days).includes(offset)) {
        return { kind: "section", todayIso: today, sectionIdx: si };
      }
    }
    return { kind: "section", todayIso: today, sectionIdx: 0 };
  }

  // Degenerate: in range, no days, no sections
  return { kind: "no-dates", todayIso: today };
}

export function humanizeDays(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  if (days < 7) return `${days} days`;
  const weeks = Math.round(days / 7);
  if (weeks === 1) return "1 week";
  return `${weeks} weeks`;
}

const MINUTE_MS = 60_000;

/** "just now" / "12 min ago" / "3 h ago" / "2 d ago", then a plain date.
 *  `now` is injectable so tests never race the wall clock. Moved here from
 *  FeedPage when FeedRow was lifted into components/ (#249): the row renders
 *  outside the page now, and a component importing time formatting from a page
 *  would be the dependency pointing the wrong way. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const minutes = Math.floor((now - t) / MINUTE_MS);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDate(iso.slice(0, 10));
}
