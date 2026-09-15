import { Link, useParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Badge } from "./ui";
import { BlockGlyph, MetaChips } from "./blocks";
import { TripMedia } from "./photos";
import { classifyTransportMode } from "../lib/transport";
import { formatDay } from "../lib/dates";
import type { Block, Day } from "../lib/types";
/** Photo images referenced by a day's blocks (block `images` + `gallery` items),
 *  capped at 2 — the summary-density thumbnail strip. Map images are excluded:
 *  no maps inline in the itinerary list (DESIGN.md §7.5). */
export function dayThumbnails(day: Day): string[] {
  const out: string[] = [];
  for (const b of day.blocks) {
    if (b.images?.length) out.push(...b.images);
    if (b.kind === "gallery") {
      for (const it of b.items ?? []) {
        if (typeof it === "string") out.push(it);
        else if (it && typeof it === "object" && typeof (it as { url?: string }).url === "string") {
          out.push((it as { url: string }).url);
        }
      }
    }
    if (out.length >= 2) break;
  }
  return out.slice(0, 2);
}

function TodayPill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-foreground" aria-hidden /> Today
    </span>
  );
}

/** One day at summary density — the scan-view row shared by the itinerary and
 *  the section page. Always visible (no accordion), the whole card links to the
 *  day page; thumbnails below the fold load lazily. */
export function DaySummaryRow({
  day,
  idx,
  dayNo,
  isToday,
  active,
}: {
  day: Day;
  idx: number;
  dayNo: number;
  isToday?: boolean;
  /** The day currently open in the day level (map surface, #92). */
  active?: boolean;
}) {
  const { tripId } = useParams();
  const thumbs = dayThumbnails(day);
  const hasBooked = day.blocks.some((b) => b.status === "booked" || b.status === "done");
  const hasPlanned = day.blocks.some((b) => b.status === "planned");
  const title = day.title || formatDay(day.date);

  return (
    <article
      data-today={isToday ? "true" : undefined}
      data-day-idx={idx}
      className={`overflow-hidden rounded-xl border bg-card shadow-card ${
        isToday ? "border-primary ring-1 ring-primary/30" : active ? "border-primary/60" : "border-border"
      }`}
    >
      <Link
        to={`/t/${tripId}/day/${idx}`}
        aria-label={`Day ${dayNo}: ${title}`}
        className="block p-3 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <div className="flex items-center gap-3">
          <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-muted py-1.5">
            <span className="font-display text-xl leading-none tabular-nums text-foreground">{dayNo}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {formatDay(day.date).split(" ")[0]}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="flex items-center gap-2 font-heading text-base font-semibold leading-snug">
              <span className="truncate">{title}</span>
              {isToday && <TodayPill />}
            </h4>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {formatDay(day.date)} · {day.blocks.length} {day.blocks.length === 1 ? "item" : "items"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasBooked && <Badge variant="accent">Booked</Badge>}
            {hasPlanned && <Badge variant="outline">Planned</Badge>}
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
        </div>

        {day.meta?.length ? (
          <div className="mt-2.5">
            <MetaChips meta={day.meta} />
          </div>
        ) : null}

        {day.notes ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{day.notes}</p>
        ) : null}

        {day.blocks.length ? (
          <ul className="mt-2.5 space-y-1.5">
            {/* sort by the explicit `order` field — parity with DayBlocks; the
                graph returns a day's blocks in $dtId order, not content order */}
            {[...day.blocks]
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map((b, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <BlockGlyph kind={b.kind} mode={classifyTransportMode(b)} />
                  <span className="min-w-0 flex-1 truncate">{b.title || "—"}</span>
                  {b.time && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{b.time}</span>}
                  {b.status && (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {b.status}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        ) : null}

        {thumbs.length ? (
          <div className={`mt-2.5 grid gap-2 ${thumbs.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {thumbs.map((src) => (
              // TripMedia: a clip among a day's photos plays here and prints as
              // its poster + link (#250) instead of as an empty <img>.
              <TripMedia
                key={src}
                src={src}
                alt=""
                className="aspect-[16/9] w-full rounded-lg border border-border object-cover"
              />
            ))}
          </div>
        ) : null}

        <span className="mt-2.5 inline-flex items-center gap-1 text-sm font-medium text-accent">
          Open day <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Link>
    </article>
  );
}

/** One unscheduled block at summary density (glyph + title + time) — used for
 *  sections that have blocks but no days yet (the ideation pool). The glyph is
 *  mode-aware like every other summary row (issue #88), so the prop carries
 *  the transport evidence fields, not just kind/title/time. */
export function BlockSummaryRow({
  block,
}: {
  block: Pick<
    Block,
    "kind" | "title" | "time" | "mode" | "bookingCode" | "description" | "distance" | "duration" | "route" | "via"
  >;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm shadow-card">
      <BlockGlyph kind={block.kind} mode={classifyTransportMode(block)} />
      <span className="min-w-0 flex-1 truncate">{block.title || "—"}</span>
      {block.time && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{block.time}</span>}
    </div>
  );
}

/** A group of consecutive days rendered as ONE itinerary card (`fold` on the
 *  section — display-only). Unlike DaySummaryRow it is NOT a link: there is no
 *  single day page to open. Number badge shows the trip-day range (e.g. 7–9),
 *  the date row the span, and blocks are the union across the folded days in
 *  (day, order) sequence. */
export function FoldedDayCard({
  days,
  title,
  startNo,
  isToday,
  active,
}: {
  days: Day[];
  title: string;
  /** Trip-day number of the first folded day (array position + 1). */
  startNo: number;
  isToday?: boolean;
  active?: boolean;
}) {
  const first = days[0];
  const last = days[days.length - 1];
  const thumbs = days.flatMap(dayThumbnails).slice(0, 2);
  const blocks = days
    .flatMap((d, di) => d.blocks.map((b) => ({ di, b })))
    .sort((a, b) => a.di - b.di || (a.b.order ?? 0) - (b.b.order ?? 0))
    .map(({ b }) => b);
  const hasBooked = blocks.some((b) => b.status === "booked" || b.status === "done");
  const hasPlanned = blocks.some((b) => b.status === "planned");
  const meta = days
    .flatMap((d) => d.meta ?? [])
    .filter((m, i, arr) => arr.findIndex((x) => x.label === m.label) === i);
  const itemCount = blocks.length;
  const dayRange = days.length > 1 ? `${startNo}–${startNo + days.length - 1}` : String(startNo);

  return (
    <article
      data-today={isToday ? "true" : undefined}
      data-day-idx={String(startNo - 1)}
      className={`overflow-hidden rounded-xl border bg-card shadow-card ${
        isToday ? "border-primary ring-1 ring-primary/30" : active ? "border-primary/60" : "border-border"
      }`}
    >
      <div className="block p-3">
        <div className="flex items-center gap-3">
          <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-muted py-1.5">
            <span className="font-display text-base leading-none tabular-nums text-foreground">{dayRange}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {first ? formatDay(first.date).split(" ")[0] : ""}–{last ? formatDay(last.date).split(" ")[0] : ""}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="flex items-center gap-2 font-heading text-base font-semibold leading-snug">
              <span className="truncate">{title}</span>
              {isToday && <TodayPill />}
            </h4>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {first && last ? `${formatDay(first.date)} – ${formatDay(last.date)}` : ""} · {itemCount}{" "}
              {itemCount === 1 ? "item" : "items"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasBooked && <Badge variant="accent">Booked</Badge>}
            {hasPlanned && <Badge variant="outline">Planned</Badge>}
          </div>
        </div>

        {meta.length ? (
          <div className="mt-2.5">
            <MetaChips meta={meta} />
          </div>
        ) : null}

        {blocks.length ? (
          <ul className="mt-2.5 space-y-1.5">
            {blocks.map((b, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <BlockGlyph kind={b.kind} mode={classifyTransportMode(b)} />
                <span className="min-w-0 flex-1 truncate">{b.title || "—"}</span>
                {b.time && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{b.time}</span>}
                {b.status && (
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {b.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {thumbs.length ? (
          <div className={`mt-2.5 grid gap-2 ${thumbs.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {thumbs.map((src) => (
              // TripMedia: a clip among a day's photos plays here and prints as
              // its poster + link (#250) instead of as an empty <img>.
              <TripMedia
                key={src}
                src={src}
                alt=""
                className="aspect-[16/9] w-full rounded-lg border border-border object-cover"
              />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
