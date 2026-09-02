import { useMemo, type ReactNode } from "react";
import { useTrip } from "./theme";
import { MapView, TripMap } from "./MapView";
import { findLocation } from "../lib/maps";
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
  StickyNote,
  UtensilsCrossed,
} from "lucide-react";
import DOMPurify from "dompurify";
import type { Block, BlockKind, BlockStatus } from "../lib/types";
import { Markdown } from "../lib/markdown";

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

/** Auto Google Maps link for a place — precise query when given (mapsQuery),
 *  else the location name/alias. */
function mapsLink(b: Block) {
  const q = b.mapsQuery || b.location;
  if (!q) return null;
  return {
    label: "Google Maps",
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
  };
}

/** Card media strip: an image, or a mini MapLibre map centered on `location`. */
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
        <div className="mb-3 h-24 w-full overflow-hidden rounded-lg border border-border">
          <MapView places={[b.location]} compact className="h-full w-full rounded-none border-0" />
        </div>
      );
    }
  }
  return null;
}

function BlockCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`booklet-keep rounded-xl border border-border bg-card p-4 shadow-card ${className}`}>{children}</div>
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

const AIRPORT_CODES = /\b(BRU|FRA|YYC|LHR|SCL|CUZ|LIM|CTS|HND|NRT|KIX|AMS|CDG|MAD)\b/;

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

/**
 * Location markers derived from trip.locations — marker number = position in the
 * array (or the explicit `marker` field). The same location data feeds the future
 * map generation / Google Maps embed, so markers never need hardcoding per trip.
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
    return n != null ? (CIRCLED[n - 1] ?? `(${n})`) : "•";
  };
}

function TransportBlock({ b }: { b: Block }) {
  const marker = useLocationMarkers();
  // classify: explicit `mode` beats the heuristic — e.g. a flight like
  // "New Chitose → Brussels" has no airport code/booking code, so without
  // mode it would wrongly render as a drive (car icon)
  const hasDriveInfo = !!(b.distance || b.duration || b.route || b.via);
  const isFlight =
    b.mode === "flight" ||
    (!hasDriveInfo &&
      (!!b.bookingCode ||
        AIRPORT_CODES.test(`${b.title ?? ""} ${b.description ?? ""}`) ||
        /(flight|depart|arriv)/i.test(`${b.title ?? ""}`)));
  const title = b.title ?? "Transfer";
  const desc = b.description;

  if (isFlight) {
    // flight card — dark, like the booklet's flight treatment
    return (
      <div className="booklet-keep overflow-hidden rounded-xl border border-foreground/10 bg-foreground text-background shadow-card">
        <div className="flex items-start gap-3 p-4">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
            <Plane className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
    <div className="booklet-keep overflow-hidden rounded-xl border border-foreground/10 bg-foreground text-background shadow-sm">
      <div className="flex items-start gap-3 p-4">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
          <Car className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="font-heading text-lg font-semibold leading-tight">{title}</h4>
            <TimeChip time={b.time} />
          </div>
          {desc && <p className="mt-1 text-sm leading-relaxed text-white/80">{desc}</p>}
          {b.from && b.to && (
            <div className="mt-2.5">
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
              className="mt-2.5 inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
            >
              <ExternalLink className="h-3 w-3" /> {marker(b.from)} {b.from} → {marker(b.to)} {b.to} — directions
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

function ActivityBlock({ b }: { b: Block }) {
  const gm = mapsLink(b);
  const shown = gm ? [gm, ...(b.links ?? [])] : b.links ?? [];
  return (
    <BlockCard>
      <CardMedia b={b} />
      <div className="flex items-start gap-3">
        <IconBadge icon={<MapPin className="h-4 w-4" />} tone="primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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

function LodgingBlock({ b }: { b: Block }) {
  const gm = mapsLink(b);
  const shown = gm ? [...(b.links ?? []), gm] : b.links ?? []; // booking CTAs first
  return (
    <BlockCard>
      <CardMedia b={b} />
      <div className="flex items-start gap-3">
        <IconBadge icon={<BedDouble className="h-4 w-4" />} tone="muted" />
        <div className="min-w-0 flex-1">
          <Kicker>Stay</Kicker>
          <h4 className="font-heading text-base font-semibold">{b.title ?? "Lodging"}</h4>
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

function MealBlock({ b }: { b: Block }) {
  const gm = mapsLink(b);
  const shown = gm ? [gm, ...(b.links ?? [])] : b.links ?? [];
  return (
    <BlockCard>
      <CardMedia b={b} />
      <div className="flex items-start gap-3">
        <IconBadge icon={<UtensilsCrossed className="h-4 w-4" />} tone="muted" />
        <div className="min-w-0 flex-1">
          <Kicker>Eat</Kicker>
          <h4 className="font-heading text-base font-semibold">{b.title ?? "Meal"}</h4>
          {b.description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{b.description}</p>}
          <Links links={shown} />
        </div>
      </div>
    </BlockCard>
  );
}

function TodoBlock({ b }: { b: Block }) {
  const items = (b.items ?? []) as { label?: string; done?: boolean }[];
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
                  <span
                    className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                      it.done ? "bg-accent text-accent-foreground" : "border border-border"
                    }`}
                  >
                    {it.done && <Check className="h-3 w-3" />}
                  </span>
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

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "transport":
      return <TransportBlock b={block} />;
    case "activity":
      return <ActivityBlock b={block} />;
    case "lodging":
      return <LodgingBlock b={block} />;
    case "meal":
      return <MealBlock b={block} />;
    case "todo":
      return <TodoBlock b={block} />;
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

export function DayBlocks({ blocks }: { blocks: Block[] }) {
  if (!blocks.length)
    return <p className="text-sm italic text-muted-foreground">Nothing planned yet — a free day.</p>;
  return (
    <div className="space-y-2.5">
      {[...blocks]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
    </div>
  );
}

export function BlockGlyph({ kind }: { kind: BlockKind }) {
  const icons: Record<BlockKind, ReactNode> = {
    activity: <MapPin className="h-3.5 w-3.5" />,
    transport: <Car className="h-3.5 w-3.5" />,
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
