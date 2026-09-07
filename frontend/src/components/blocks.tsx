import { useMemo, type HTMLAttributes, type ReactNode } from "react";
import { useTrip } from "./theme";
import { MapView, TripMap } from "./MapView";
import { findLocation, markerNumber } from "../lib/maps";
import { gmapsSearchUrl } from "../lib/gmaps";
import {
  BedDouble,
  Car,
  Check,
  ChevronRight,
  Clock,
  CreditCard,
  ExternalLink,
  Images,
  Link2,
  ListChecks,
  MapPin,
  Plane,
  Ship,
  StickyNote,
  Train,
  UtensilsCrossed,
} from "lucide-react";
import DOMPurify from "dompurify";
import type { Block, BlockKind, BlockStatus } from "../lib/types";
import { classifyTransportMode, type TransportMode } from "../lib/transport";
import { Markdown } from "../lib/markdown";
import { EditableBlockList } from "./block-edit";

/* ---------- shared bits ---------- */

function Kicker({ children }: { children: ReactNode }) {
  return <p className="kicker">{children}</p>;
}

const STATUS_LABEL: Record<BlockStatus, string> = {
  planned: "PLANNED",
  booked: "BOOKED",
  done: "DONE",
};

function StatusChip({ status }: { status?: BlockStatus }) {
  if (!status) return null;
  const booked = status === "booked" || status === "done";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        booked ? "bg-accent text-accent-foreground" : "border border-border text-muted-foreground"
      }`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function Cost({ cost, currency }: { cost?: number; currency?: string }) {
  if (cost == null) return null;
  return (
    <span className="whitespace-nowrap font-heading text-sm font-medium tabular-nums text-muted-foreground">
      {cost.toLocaleString("de-DE", { maximumFractionDigits: 0 })} {currency}
    </span>
  );
}

function BookingCode({ code }: { code?: string }) {
  if (!code) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-foreground">
      <CreditCard className="h-3 w-3" /> {code}
    </span>
  );
}

/** Day-level meta chips, e.g. "Stay: Banff · Lift: Ikon" — booklet style. */
export function MetaChips({ meta }: { meta?: { label: string; value: string }[] }) {
  if (!meta?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {meta.map((m, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <span className="font-semibold uppercase tracking-wide text-foreground">{m.label}</span>
          <span className="font-medium">{m.value}</span>
        </span>
      ))}
    </div>
  );
}

function Links({ links }: { links?: { label: string; url: string }[] }) {
  if (!links?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {links.map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-muted"
        >
          <ExternalLink className="h-3 w-3 text-muted-foreground" />
          {l.label}
        </a>
      ))}
    </div>
  );
}

/** Auto Google Maps link for a place — the venue's `googlePlaceId` wins when
 *  set (keyless deep link, #15/#95), else the precise query (`mapsQuery`),
 *  else the location name/alias. */
function mapsLink(b: Block) {
  const q = b.mapsQuery || b.location || b.title || "";
  if (!q && !b.googlePlaceId) return null;
  return {
    label: "Google Maps",
    url: gmapsSearchUrl(q, { placeId: b.googlePlaceId, query: b.mapsQuery }),
  };
}

/** Card media strip: an image, or a mini MapLibre map centered on `location`.
 *  The MAP branch is the "minimap": on the trip map surface (#92) it is hidden
 *  — the surface map right beside the card is the spatial context — while the
 *  booklet keeps it (one component, a print-scope CSS rule serves both). */
function CardMedia({ b }: { b: Block }) {
  const trip = useTrip();
  if (b.images?.length) {
    const imgs = b.images.slice(0, 2);
    return (
      <div className={`mb-3 grid gap-2 ${imgs.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {imgs.map((src) => (
          <img key={src} src={src} alt={b.title ?? ""} className="h-28 w-full rounded-lg object-cover" />
        ))}
      </div>
    );
  }
  if (b.location) {
    const loc = findLocation(trip, b.location);
    if (loc?.lat != null && loc.lng != null) {
      return (
        <div className="minimap mb-3 h-24 w-full overflow-hidden rounded-lg border border-border">
          <MapView places={[b.location]} compact className="h-full w-full rounded-none border-0" />
        </div>
      );
    }
  }
  return null;
}

/** The day level's letter badge (§8.3, #90/#104) — the same square chip glyph
 *  the map draws, INLINE next to the card's title (the floating corner badge
 *  was easy to miss — "I can not see that the hotel is A"). Static: the card
 *  root carries the tap handler, and a tap on the badge bubbles to it. */
function LetterBadge({ letter }: { letter: string }) {
  return (
    <span
      aria-hidden="true"
      className="route-chip-badge inline-grid h-6 w-6 shrink-0 place-items-center rounded-md bg-marker font-heading text-[13px] font-semibold leading-none text-marker-fg shadow-card"
    >
      {letter}
    </span>
  );
}

/** Extra props a card root can carry from the map surface (data hooks + the
 *  tap↔card handler). Booklet/today/summary never pass them. */
export type BlockCardProps = HTMLAttributes<HTMLDivElement> & Record<string, unknown>;

function BlockCard({
  children,
  className = "",
  cardProps,
}: {
  children: ReactNode;
  className?: string;
  cardProps?: BlockCardProps;
}) {
  return (
    <div
      {...cardProps}
      className={`booklet-keep relative rounded-xl border border-border bg-card p-4 shadow-card ${className}`}
    >
      {children}
    </div>
  );
}

function IconBadge({ icon, tone }: { icon: ReactNode; tone: "muted" | "primary" | "accent" }) {
  const tones = {
    muted: "bg-muted text-foreground",
    primary: "bg-primary/10 text-primary",
    accent: "bg-accent/10 text-accent",
  };
  return <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`}>{icon}</span>;
}

function TimeChip({ time }: { time?: string }) {
  if (!time) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
      <Clock className="h-3 w-3" /> {time}
    </span>
  );
}

/* ---------- per-kind renderers ---------- */

/**
 * Location markers derived from trip.locations — marker number = position in the
 * array (or the explicit `marker` field). The same location data feeds the future
 * map generation / Google Maps embed, so markers never need hardcoding per trip.
 *
 * #109: renders the REDESIGNED pill (plain number in a --map-marker circle,
 * same shape/colour as the location pills in the itinerary) — the old ①-style
 * circled glyph is retired. No live callers left; kept for compatibility.
 */
export function useLocationMarkers() {
  const trip = useTrip();
  const map = useMemo(() => {
    const m = new Map<string, number>();
    (trip.locations ?? []).forEach((loc, i) => {
      const num = loc.marker ?? i + 1;
      m.set(loc.name.toLowerCase(), num);
      (loc.alias ?? []).forEach((a) => m.set(a.toLowerCase(), num));
    });
    return m;
  }, [trip.locations]);
  return (place: string) => {
    const n = map.get(place.toLowerCase());
    return n != null ? String(n) : "•";
  };
}

function TransportBlock({
  b,
  letter,
  cardProps,
}: {
  b: Block;
  letter?: string;
  cardProps?: BlockCardProps;
}) {
  const trip = useTrip();
  // classify via the shared classifier (lib/transport) — explicit `mode` beats
  // the heuristic; both this card and the summary glyphs derive from it, so a
  // block carries the same transport identity on every surface (issue #88)
  const isFlight = classifyTransportMode(b) === "flight";
  const title = b.title ?? "Transfer";
  const desc = b.description;

  if (isFlight) {
    // flight card — dark, like the booklet's flight treatment
    return (
      <div
        {...cardProps}
        className="booklet-keep relative overflow-hidden rounded-xl border border-foreground/10 bg-foreground text-background shadow-card"
      >
        <div className="flex items-start gap-3 p-4">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
            <Plane className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {letter && <LetterBadge letter={letter} />}
              <h4 className="font-heading text-lg font-semibold leading-tight">{title}</h4>
              <TimeChip time={b.time} />
            </div>
            {desc && (
              <p className="mt-1 text-sm leading-relaxed text-white/80">
                {desc}
              </p>
            )}
            {(b.bookingCode || b.cost != null) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <BookingCode code={b.bookingCode} />
                <Cost cost={b.cost} currency={b.currency} />
                <StatusChip status={b.status} />
              </div>
            )}
            {b.links?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {b.links.map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
                  >
                    <ExternalLink className="h-3 w-3" /> {l.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // drive card — dark, like the booklet's drive treatment (distance / time / route / directions)
  return (
    <div
      {...cardProps}
      className="booklet-keep relative overflow-hidden rounded-xl border border-foreground/10 bg-foreground text-background shadow-sm"
    >
      <div className="flex items-start gap-3 p-4">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
          <Car className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {letter && <LetterBadge letter={letter} />}
            <h4 className="font-heading text-lg font-semibold leading-tight">{title}</h4>
            <TimeChip time={b.time} />
          </div>
          {desc && <p className="mt-1 text-sm leading-relaxed text-white/80">{desc}</p>}
          {b.from && b.to && (
            <div className="minimap mt-2.5 overflow-hidden rounded-lg">
              <TripMap places={[b.from, b.to]} />
            </div>
          )}
          {(b.distance || b.duration || b.route) && (
            <div className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2">
              {/* distance and drive time sit in a two-column grid across
                  stacked cards — tabular numerals so they line up (§4) */}
              {b.distance && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">Distance</p>
                  <p className="font-heading text-lg font-semibold leading-tight tabular-nums">{b.distance}</p>
                </div>
              )}
              {b.duration && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">Drive time</p>
                  <p className="font-heading text-lg font-semibold leading-tight tabular-nums">{b.duration}</p>
                </div>
              )}
              {b.route && (
                <div className="col-span-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">Route</p>
                  <p className="text-sm font-medium">
                    {b.route}
                    {b.via ? <span className="text-white/70"> — {b.via}</span> : null}
                  </p>
                </div>
              )}
            </div>
          )}
          {b.from && b.to && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(b.from)}&destination=${encodeURIComponent(b.to)}&travelmode=driving`}
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 inline-flex w-full max-w-full items-center gap-1.5 rounded-full bg-white/15 py-1 pl-2 pr-2.5 text-xs font-medium hover:bg-white/25"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              {(() => {
                const from = findLocation(trip, b.from);
                const to = findLocation(trip, b.to);
                // Pill row + a trailing "directions" tag. Each name is in a
                // min-w-0 truncate so a long place ("Santiago Airport") can
                // never push the trailing tag onto its own line — the row
                // flexes to fit, the names ellipsize, "directions" stays put.
                const pill = (loc?: ReturnType<typeof findLocation>) =>
                  loc ? (
                    <span
                      aria-hidden
                      className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full bg-marker text-[10px] font-bold leading-none text-marker-fg"
                    >
                      {markerNumber(trip, loc)}
                    </span>
                  ) : (
                    <span aria-hidden className="shrink-0 text-white/50">•</span>
                  );
                const Place = ({
                  name,
                  loc,
                }: {
                  name: string;
                  loc?: ReturnType<typeof findLocation>;
                }) => (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    {pill(loc)}
                    <span className="truncate">{name}</span>
                  </span>
                );
                return (
                  <>
                    <Place name={b.from} loc={from} />
                    <span className="shrink-0 opacity-70">→</span>
                    <Place name={b.to} loc={to} />
                    <span className="ml-auto shrink-0 pl-2 text-white/70">directions</span>
                  </>
                );
              })()}
            </a>
          )}
          {b.links?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {b.links.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
                >
                  <ExternalLink className="h-3 w-3" /> {l.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActivityBlock({
  b,
  letter,
  cardProps,
}: {
  b: Block;
  letter?: string;
  cardProps?: BlockCardProps;
}) {
  const gm = mapsLink(b);
  const shown = gm ? [gm, ...(b.links ?? [])] : b.links ?? [];
  return (
    <BlockCard cardProps={cardProps}>
      <CardMedia b={b} />
      <div className="flex items-start gap-3">
        <IconBadge icon={<MapPin className="h-4 w-4" />} tone="primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {letter && <LetterBadge letter={letter} />}
            <h4 className="font-heading text-base font-semibold">{b.title ?? "Activity"}</h4>
            <TimeChip time={b.time} />
            {b.cost != null && <Cost cost={b.cost} currency={b.currency} />}
            <StatusChip status={b.status} />
          </div>
          {b.description && (
            <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
              <Markdown>{b.description}</Markdown>
            </div>
          )}
          <Links links={shown} />
        </div>
      </div>
    </BlockCard>
  );
}

function LodgingBlock({
  b,
  letter,
  cardProps,
}: {
  b: Block;
  letter?: string;
  cardProps?: BlockCardProps;
}) {
  const gm = mapsLink(b);
  const shown = gm ? [...(b.links ?? []), gm] : b.links ?? []; // booking CTAs first
  return (
    <BlockCard cardProps={cardProps}>
      <CardMedia b={b} />
      <div className="flex items-start gap-3">
        <IconBadge icon={<BedDouble className="h-4 w-4" />} tone="muted" />
        <div className="min-w-0 flex-1">
          <Kicker>Stay</Kicker>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {letter && <LetterBadge letter={letter} />}
            <h4 className="font-heading text-base font-semibold">{b.title ?? "Lodging"}</h4>
          </div>
          {b.description && (
            <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
              <Markdown>{b.description}</Markdown>
            </div>
          )}
          {(b.bookingCode || b.cost != null) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <BookingCode code={b.bookingCode} />
              <Cost cost={b.cost} currency={b.currency} />
            </div>
          )}
          <Links links={shown} />
        </div>
      </div>
    </BlockCard>
  );
}

function MealBlock({
  b,
  letter,
  cardProps,
}: {
  b: Block;
  letter?: string;
  cardProps?: BlockCardProps;
}) {
  const gm = mapsLink(b);
  const shown = gm ? [gm, ...(b.links ?? [])] : b.links ?? [];
  return (
    <BlockCard cardProps={cardProps}>
      <CardMedia b={b} />
      <div className="flex items-start gap-3">
        <IconBadge icon={<UtensilsCrossed className="h-4 w-4" />} tone="muted" />
        <div className="min-w-0 flex-1">
          <Kicker>Eat</Kicker>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {letter && <LetterBadge letter={letter} />}
            <h4 className="font-heading text-base font-semibold">{b.title ?? "Meal"}</h4>
          </div>
          {b.description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{b.description}</p>}
          <Links links={shown} />
        </div>
      </div>
    </BlockCard>
  );
}

function TodoBlock({
  b,
  editable = false,
  onToggleItem,
}: {
  b: Block;
  editable?: boolean;
  onToggleItem?: (itemIndex: number, done: boolean) => void;
}) {
  const items = (b.items ?? []) as { label?: string; done?: boolean }[];
  const interactive = editable && !!onToggleItem;
  const boxCls = (done: boolean) =>
    `mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded ${
      done ? "bg-accent text-accent-foreground" : "border border-border"
    } ${interactive ? "cursor-pointer transition-colors hover:border-accent" : ""}`;
  return (
    <BlockCard>
      <div className="flex items-start gap-3">
        <IconBadge icon={<ListChecks className="h-4 w-4" />} tone="accent" />
        <div className="min-w-0 flex-1">
          <Kicker>To-do</Kicker>
          {b.title && <h4 className="font-heading text-base font-semibold">{b.title}</h4>}
          {items.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {items.map((it, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  {interactive ? (
                    <button
                      type="button"
                      onClick={() => onToggleItem(i, !it.done)}
                      aria-pressed={!!it.done}
                      aria-label={`Mark "${it.label ?? "item"}" ${it.done ? "not done" : "done"}`}
                      className={boxCls(!!it.done)}
                    >
                      {it.done && <Check className="h-3 w-3" />}
                    </button>
                  ) : (
                    <span className={boxCls(!!it.done)} aria-hidden>
                      {it.done && <Check className="h-3 w-3" />}
                    </span>
                  )}
                  <span className={it.done ? "text-muted-foreground line-through" : ""}>{it.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </BlockCard>
  );
}

function NoteBlock({ b }: { b: Block }) {
  return (
    <BlockCard className="border-l-4 border-l-primary/40 bg-muted/40">
      <div className="flex items-start gap-3">
        <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {b.title && <h4 className="font-heading text-sm font-semibold">{b.title}</h4>}
          {b.description && (
            <div className="text-sm leading-relaxed text-muted-foreground italic">
              <Markdown>{b.description}</Markdown>
            </div>
          )}
        </div>
      </div>
    </BlockCard>
  );
}

function GalleryBlock({ b }: { b: Block }) {
  const imgs = (b.items ?? []) as string[];
  if (!imgs.length) return null;
  return (
    <BlockCard className="p-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {imgs.map((src, i) => (
          <img key={i} src={src} alt="" loading="lazy" className="h-32 w-full rounded-lg object-cover" />
        ))}
      </div>
    </BlockCard>
  );
}

function LinkBlock({ b }: { b: Block }) {
  if (!b.links?.length) return null;
  return (
    <BlockCard>
      <div className="flex items-start gap-3">
        <IconBadge icon={<Link2 className="h-4 w-4" />} tone="muted" />
        <div className="min-w-0 flex-1">
          <Kicker>Links</Kicker>
          <ul className="mt-1 space-y-1">
            {b.links.map((l) => (
              <li key={l.url}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <ChevronRight className="h-3.5 w-3.5" /> {l.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </BlockCard>
  );
}

function BookingBlock({ b }: { b: Block }) {
  return (
    <BlockCard className="border-accent/40 bg-accent/5">
      <div className="flex items-start gap-3">
        <IconBadge icon={<CreditCard className="h-4 w-4" />} tone="accent" />
        <div className="min-w-0 flex-1">
          <Kicker>Booking</Kicker>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="font-heading text-base font-semibold">{b.title ?? "Booking"}</h4>
            <StatusChip status={b.status} />
          </div>
          {b.description && (
            <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
              <Markdown>{b.description}</Markdown>
            </div>
          )}
          {(b.bookingCode || b.cost != null) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <BookingCode code={b.bookingCode} />
              <Cost cost={b.cost} currency={b.currency} />
            </div>
          )}
          <Links links={b.links} />
        </div>
      </div>
    </BlockCard>
  );
}

function CustomBlock({ b }: { b: Block }) {
  if (!b.html) return null;
  return <div className="md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(b.html) }} />;
}

/* ---------- dispatcher ---------- */

export function BlockView({
  block,
  editable = false,
  onToggleItem,
  letter,
  cardProps,
}: {
  block: Block;
  /** Interactive affordances (currently: todo-item checkboxes). */
  editable?: boolean;
  onToggleItem?: (itemIndex: number, done: boolean) => void;
  /** The day-level letter (§8.3/#90) to stamp on mapped cards. */
  letter?: string;
  /** Map-surface card hooks (data-block-id, tap↔card click). */
  cardProps?: BlockCardProps;
}) {
  switch (block.kind) {
    case "transport":
      return <TransportBlock b={block} letter={letter} cardProps={cardProps} />;
    case "activity":
      return <ActivityBlock b={block} letter={letter} cardProps={cardProps} />;
    case "lodging":
      return <LodgingBlock b={block} letter={letter} cardProps={cardProps} />;
    case "meal":
      return <MealBlock b={block} letter={letter} cardProps={cardProps} />;
    case "todo":
      return <TodoBlock b={block} editable={editable} onToggleItem={onToggleItem} />;
    case "note":
      return <NoteBlock b={block} />;
    case "gallery":
      return <GalleryBlock b={block} />;
    case "link":
      return <LinkBlock b={block} />;
    case "booking":
      return <BookingBlock b={block} />;
    case "custom":
      return <CustomBlock b={block} />;
    default:
      return null;
  }
}

export function DayBlocks({
  blocks,
  editable = false,
  containerId,
  letters,
  cardProps,
}: {
  blocks: Block[];
  /** Editor mode (issue #46): inline chrome per block. Requires the owning
   *  day's twin id — the block-order target. Booklet/today/summary renderers
   *  never set it, so the print output stays byte-identical. */
  editable?: boolean;
  containerId?: string;
  /** Day-level letters (§8.3/#90), blockId → letter. When present, mapped
   *  cards carry the badge; when absent (booklet/today) nothing changes. */
  letters?: Map<string, string>;
  /** Map-surface card hooks, per block (tap↔card). */
  cardProps?: (b: Block) => BlockCardProps;
}) {
  if (!blocks.length)
    return <p className="text-sm italic text-muted-foreground">Nothing planned yet — a free day.</p>;
  if (editable && containerId) {
    return (
      <EditableBlockList
        blocks={blocks}
        containerId={containerId}
        letters={letters}
        cardProps={cardProps}
      />
    );
  }
  return (
    <div className="space-y-2.5">
      {[...blocks]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((b) => (
          <BlockView
            key={b.id}
            block={b}
            letter={letters?.get(b.id)}
            cardProps={cardProps?.(b)}
          />
        ))}
    </div>
  );
}

/** Summary-density glyph. For transport blocks the icon follows the block's
 *  classified mode — one shared classifier with the day-page card
 *  (lib/transport, issue #88): explicit `mode` wins, then drive/flight
 *  evidence; otherwise the plain car (the historical default). */
export function BlockGlyph({
  kind,
  mode,
}: {
  kind: BlockKind;
  /** Transport mode for `kind: "transport"` rows (classified per block by the
   *  caller). Undefined keeps the plain car — the pre-#88 behaviour. */
  mode?: TransportMode;
}) {
  if (kind === "transport") {
    const Icon = mode === "flight" ? Plane : mode === "train" ? Train : mode === "ferry" ? Ship : Car;
    return (
      <span className="text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
    );
  }
  const icons: Record<Exclude<BlockKind, "transport">, ReactNode> = {
    activity: <MapPin className="h-3.5 w-3.5" />,
    lodging: <BedDouble className="h-3.5 w-3.5" />,
    meal: <UtensilsCrossed className="h-3.5 w-3.5" />,
    todo: <ListChecks className="h-3.5 w-3.5" />,
    note: <StickyNote className="h-3.5 w-3.5" />,
    gallery: <Images className="h-3.5 w-3.5" />,
    link: <Link2 className="h-3.5 w-3.5" />,
    booking: <CreditCard className="h-3.5 w-3.5" />,
    custom: <StickyNote className="h-3.5 w-3.5" />,
  };
  return <span className="text-muted-foreground">{icons[kind]}</span>;
}
