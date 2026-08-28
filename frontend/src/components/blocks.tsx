import {
  BedDouble,
  Car,
  CreditCard,
  Images,
  Link2,
  ListChecks,
  MapPin,
  Plane,
  StickyNote,
  TrainFront,
  UtensilsCrossed,
  Clock,
} from "lucide-react";
import DOMPurify from "dompurify";
import { Card, StatusChip } from "./ui";
import { Markdown } from "../lib/markdown";
import { formatMoney } from "../lib/dates";
import type { Block, BlockKind, Link, TodoItem } from "../lib/types";

const KIND_ICON: Record<BlockKind, typeof MapPin> = {
  activity: MapPin,
  transport: Plane,
  lodging: BedDouble,
  meal: UtensilsCrossed,
  todo: ListChecks,
  note: StickyNote,
  gallery: Images,
  link: Link2,
  booking: CreditCard,
  custom: StickyNote,
};

function transportIcon(title?: string) {
  const t = (title ?? "").toLowerCase();
  if (t.includes("train") || t.includes("shinkansen") || t.includes("vistadome") || t.includes("rail"))
    return TrainFront;
  if (t.includes("car") || t.includes("camper") || t.includes("drive") || t.includes("rental"))
    return Car;
  if (t.includes("bus") || t.includes("shuttle")) return TrainFront;
  return Plane;
}

function Links({ links }: { links?: Link[] }) {
  if (!links?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {links.map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium hover:bg-primary/10 hover:border-primary/40"
        >
          <Link2 className="h-3 w-3" />
          {l.label}
        </a>
      ))}
    </div>
  );
}

function BlockHeader({
  kind,
  title,
  time,
  status,
  bookingCode,
}: {
  kind: BlockKind;
  title?: string;
  time?: string;
  status?: Block["status"];
  bookingCode?: string;
}) {
  const Icon = kind === "transport" ? transportIcon(title) : KIND_ICON[kind];
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 rounded-md bg-primary/10 p-1.5 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        {title && <h3 className="font-semibold leading-tight">{title}</h3>}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {time && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {time}
            </span>
          )}
          <StatusChip status={status} />
          {bookingCode && (
            <span className="inline-flex items-center gap-1 font-mono">
              <CreditCard className="h-3 w-3" /> {bookingCode}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function BlockBody({ block }: { block: Block }) {
  if (block.description) return <Markdown>{block.description}</Markdown>;
  return null;
}

function TodoBlock({ items }: { items?: string[] | TodoItem[] }) {
  const todos = (items ?? []) as TodoItem[];
  if (!todos.length) return null;
  const done = todos.filter((t) => t.done).length;
  return (
    <div className="mt-2">
      <p className="text-xs text-muted-foreground">
        {done}/{todos.length} done
      </p>
      <ul className="mt-1 space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                t.done ? "border-accent bg-accent text-accent-foreground" : "border-border"
              }`}
            >
              {t.done ? "✓" : ""}
            </span>
            <span className={t.done ? "text-muted-foreground line-through" : undefined}>{t.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GalleryBlock({ items }: { items?: string[] | TodoItem[] }) {
  const images = (items ?? []).filter((i): i is string => typeof i === "string");
  if (!images.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {images.map((src, i) => (
        <a key={i} href={src} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg">
          <img src={src} alt="" loading="lazy" className="h-32 w-full object-cover transition-transform hover:scale-105" />
        </a>
      ))}
    </div>
  );
}

function Cost({ block }: { block: Block }) {
  const money = formatMoney(block.cost, block.currency);
  if (!money) return null;
  return (
    <p className="mt-2 text-sm font-medium text-accent">
      {money}
      {block.status === "booked" ? " · booked" : ""}
    </p>
  );
}

export function BlockView({ block }: { block: Block }) {
  if (block.kind === "custom" && block.html) {
    return (
      <Card className="p-4">
        <div
          className="md"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(block.html) }}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <BlockHeader kind={block.kind} title={block.title} time={block.time} status={block.status} bookingCode={block.bookingCode} />
      <BlockBody block={block} />
      {block.kind === "todo" && <TodoBlock items={block.items} />}
      {block.kind === "gallery" && <GalleryBlock items={block.items} />}
      {block.kind === "link" && block.links && <Links links={block.links} />}
      {block.kind !== "link" && <Links links={block.links} />}
      <Cost block={block} />
    </Card>
  );
}

export function DayBlocks({ blocks }: { blocks: Block[] }) {
  if (!blocks.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Nothing planned yet for this day.
      </p>
    );
  }
  const ordered = [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <div className="space-y-3">
      {ordered.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
