import { useMemo, type HTMLAttributes, type ReactNode } from "react";
import { useTrip } from "./theme";
import { MapView, TripMap } from "./MapView";
import { findLocation, markerNumber } from "../lib/maps";
import { gmapsDirectionsUrl, gmapsSearchUrl } from "../lib/gmaps";
import { useLiveDirections } from "../lib/directions";
import { matchTitlePlace } from "../lib/day-surface";
import { tripInForecastWindow } from "../lib/weather-live";
import { PlaceFacts, placeHasFacts } from "./PlaceFacts";
import {
  BedDouble,
  Car,
  Check,
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
import type { Block, BlockKind, BlockStatus, Trip, TripLocation } from "../lib/types";
import { classifyTransportMode, type TransportMode } from "../lib/transport";
import { Markdown } from "../lib/markdown";
import { EditableBlockList } from "./block-edit";
import { ContentLink } from "./content-link";
import { PhotoGallery, PhotoStrip } from "./photos";
import { TrackCard } from "./track-card";
import { YouTubeEmbeds } from "./youtube";
import { extractYouTubeId } from "../lib/youtube";

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
  // A YouTube URL plays inline above the pills (#283) — never as a pill.
  const rest = links.filter((l) => !extractYouTubeId(l.url));
  return (
    <>
      <YouTubeEmbeds links={links} />
      {rest.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {rest.map((l) => (
            <ContentLink
              key={l.url}
              url={l.url}
              glyph="h-3 w-3 text-muted-foreground"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-muted"
            >
              {l.label}
            </ContentLink>
          ))}
        </div>
      )}
    </>
  );
}

/** Auto Google Maps link for a place — the block's own `placeId` wins when
 *  set, then the resolved registry place's `placeId` (keyless deep links,
 *  #15/#95), else the location name/alias as a plain text query. Deliberately
 *  no free-text venue field: a block that names a specific venue carries its
 *  `placeId`, so the link AND the photos/reviews overlay can resolve it. */
function mapsLink(b: Block, resolvedPlace?: TripLocation) {
  const q = b.location || b.title || "";
  const placeId = b.placeId ?? resolvedPlace?.placeId;
  if (!q && !placeId) return null;
  return {
    label: "Google Maps",
    url: gmapsSearchUrl(q, { placeId }),
  };
}

/**
 * The block's registry place: the explicit `location` field resolved via
 * `findLocation`, else the shared day-surface title/alias matcher (#104 —
 * exact name, then aliases, then containment ≥3 chars, longest-name wins).
 * Never invents: an unknown `location` stays unresolved rather than falling
 * through to the title pass. Exported for the maps-link tests.
 */
export function resolveBlockPlace(trip: Trip, b: Block): TripLocation | undefined {
  if (b.location) return findLocation(trip, b.location);
  return matchTitlePlace(trip, b.title);
}

/** Card media strip: an image, or a mini MapLibre map centered on `location`.
 *  Photos render through the shared PhotoStrip (decision A, #191 — N photos,
 *  screen-capped with a +N lightbox affordance, print-capped per DESIGN §12).
 *  The MAP branch is the "minimap": on the trip map surface (#92) it is hidden
 *  — the surface map right beside the card is the spatial context — while the
 *  booklet keeps it (one component, a print-scope CSS rule serves both).
 *
 *  KIND-AGNOSTIC (#303): `images` is a shared field on all ten block kinds and
 *  the itinerary day rows (`dayThumbnails`) already read it from every kind —
 *  so the day view must render this strip for every kind too, or a photo that
 *  the itinerary advertises as the day's thumbnail is invisible where the
 *  reader is reading. The decision lives here, once; `BlockCard` applies it.
 *
 *  Returns null when the block carries no media at all — split out of
 *  `CardMedia` so a card with its own layout (the dark transport card) can ask
 *  BEFORE reserving padding for a strip that may not exist. */
function cardMediaNode(trip: Trip, b: Block): ReactNode {
  if (b.images?.length) {
    return <PhotoStrip images={b.images} alt={b.title ?? ""} />;
  }
  const tracks = b.track ? [b.track] : undefined;
  const place = b.location ? findLocation(trip, b.location) : resolveBlockPlace(trip, b);
  if (place?.lat != null && place.lng != null) {
    return (
      <div className="minimap mb-3 h-24 w-full overflow-hidden rounded-lg border border-border">
        <MapView places={[place.name]} tracks={tracks} compact className="h-full w-full rounded-none border-0" />
      </div>
    );
  }
  // A recorded track with no registry place still earns its minimap — the
  // line IS the spatial context (MapView frames it when no pins resolve).
  if (b.track) {
    return (
      <div className="minimap mb-3 h-24 w-full overflow-hidden rounded-lg border border-border">
        <MapView places={[]} tracks={tracks} compact className="h-full w-full rounded-none border-0" />
      </div>
    );
  }
  return null;
}

/** `cardMediaNode` as a component, for the cards that always render their
 *  strip (via `BlockCard b={…}`, the single call site for all ten kinds). */
function CardMedia({ b }: { b: Block }) {
  return <>{cardMediaNode(useTrip(), b)}</>;
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
  b,
  children,
  className = "",
  cardProps,
}: {
  /** The block this card renders. Given by every kind, the shared media strip
   *  (`cardMediaNode`) renders ONCE here, above the card body — one call site
   *  for all ten kinds instead of three (#303). Omitted only by a card that
   *  is not a `BlockCard` at all (the dark transport card). */
  b?: Block;
  children: ReactNode;
  className?: string;
  cardProps?: BlockCardProps;
}) {
  return (
    <div
      {...cardProps}
      className={`booklet-keep relative rounded-xl border border-border bg-card p-4 shadow-card ${className}`}
    >
      {b ? <CardMedia b={b} /> : null}
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
  // The shared media strip (#303) — a photo attached to the transfer renders
  // where the reader is reading, exactly as the itinerary already advertises
  // it. Computed once, and the card only reserves the wrapper's padding when
  // there IS something to show, so a photo-less transfer card is unchanged.
  const media = cardMediaNode(trip, b);
  const rowCls = `flex items-start gap-3 ${media ? "px-4 pb-4" : "p-4"}`;

  if (isFlight) {
    // flight card — dark, like the booklet's flight treatment
    return (
      <div
        {...cardProps}
        className="booklet-keep relative overflow-hidden rounded-xl border border-foreground/10 bg-foreground text-background shadow-card"
      >
        {media ? <div className="px-4 pt-4">{media}</div> : null}
        <div className={rowCls}>
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
                  <ContentLink
                    key={l.url}
                    url={l.url}
                    glyph="h-3 w-3"
                    className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
                  >
                    {l.label}
                  </ContentLink>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // drive card — dark, like the booklet's drive treatment (distance / time / route / directions)
  // The title row carries the from → to endpoints (marker pills + names, the
  // same letter + TimeChip pattern as every other card); the directions link
  // below is just the CTA. Long names ellipsize, the → never does.
  const fromLoc = b.from ? findLocation(trip, b.from) : undefined;
  const toLoc = b.to ? findLocation(trip, b.to) : undefined;
  // Live HERE drive time (web-only — the hook never fetches under print
  // media, so the booklet keeps the static authored values). While loading
  // or unavailable the static values stay, silently.
  const live = useLiveDirections(
    fromLoc?.lat != null && fromLoc?.lng != null ? { lat: fromLoc.lat, lng: fromLoc.lng } : null,
    toLoc?.lat != null && toLoc?.lng != null ? { lat: toLoc.lat, lng: toLoc.lng } : null,
  );
  const liveDuration = live?.available ? live.durationText : undefined;
  const liveDistance = live?.available ? live.distanceText : undefined;
  const driveTime = liveDuration ?? b.duration;
  const distance = b.distance ?? liveDistance;
  const drivePill = (loc?: TripLocation) =>
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
  const DriveEndpoint = ({ name, loc }: { name: string; loc?: TripLocation }) => (
    <span className="inline-flex min-w-0 items-center gap-1">
      {drivePill(loc)}
      <span className="truncate">{name}</span>
    </span>
  );
  return (
    <div
      {...cardProps}
      className="booklet-keep relative overflow-hidden rounded-xl border border-foreground/10 bg-foreground text-background shadow-sm"
    >
      {media ? <div className="px-4 pt-4">{media}</div> : null}
      <div className={rowCls}>
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
          <Car className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {letter && <LetterBadge letter={letter} />}
            {b.from && b.to ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 font-heading text-lg font-semibold leading-tight">
                <DriveEndpoint name={b.from} loc={fromLoc} />
                <span aria-hidden="true" className="shrink-0 opacity-70">→</span>
                <DriveEndpoint name={b.to} loc={toLoc} />
              </span>
            ) : (
              <h4 className="font-heading text-lg font-semibold leading-tight">{title}</h4>
            )}
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
              {distance && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">Distance</p>
                  <p className="font-heading text-lg font-semibold leading-tight tabular-nums">{distance}</p>
                </div>
              )}
              {driveTime && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">
                    Drive time
                    {liveDuration && (
                      <span className="ml-1.5 rounded-full bg-white/15 px-1.5 py-px align-middle text-[9px] font-semibold uppercase tracking-wider text-white/70">
                        live
                      </span>
                    )}
                  </p>
                  <p aria-live="polite" className="font-heading text-lg font-semibold leading-tight tabular-nums">{driveTime}</p>
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
              href={gmapsDirectionsUrl(b.from, b.to, {
                originPlaceId: fromLoc?.placeId,
                destinationPlaceId: toLoc?.placeId,
              })}
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
            >
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              Directions
            </a>
          )}
          {b.links?.length ? (
            <>
              <YouTubeEmbeds links={b.links} />
              {b.links.some((l) => !extractYouTubeId(l.url)) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {b.links
                    .filter((l) => !extractYouTubeId(l.url))
                    .map((l) => (
                      <ContentLink
                        key={l.url}
                        url={l.url}
                        glyph="h-3 w-3"
                        className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
                      >
                        {l.label}
                      </ContentLink>
                    ))}
                </div>
              )}
            </>
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
  const trip = useTrip();
  const place = resolveBlockPlace(trip, b);
  const showWeather = tripInForecastWindow(trip);
  // The links-row Maps entry is redundant once the block resolves to a
  // registry place — PlaceFacts renders the canonical place_id deep link.
  // Unresolved blocks keep their own location/placeId fallback link.
  const gm = place ? null : mapsLink(b, place);
  const shown = gm ? [gm, ...(b.links ?? [])] : b.links ?? [];
  return (
    <BlockCard b={b} cardProps={cardProps}>
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
          {place && (placeHasFacts(place) || (showWeather && place.lat != null)) && (
            <PlaceFacts
              place={place}
              blockLinks={shown}
              reviewsQuiet={b.status === "done"}
              showWeather={showWeather}
            />
          )}
          {b.description && (
            <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
              <Markdown>{b.description}</Markdown>
            </div>
          )}
          {b.track && <TrackCard track={b.track} status={b.status} />}
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
  const trip = useTrip();
  const place = resolveBlockPlace(trip, b);
  const showWeather = tripInForecastWindow(trip);
  // Same Maps-link dedupe as ActivityBlock (PlaceFacts owns the canonical
  // deep link once the block resolves) — booking CTAs stay first.
  const gm = place ? null : mapsLink(b, place);
  const shown = gm ? [...(b.links ?? []), gm] : b.links ?? []; // booking CTAs first
  return (
    <BlockCard b={b} cardProps={cardProps}>
      <div className="flex items-start gap-3">
        <IconBadge icon={<BedDouble className="h-4 w-4" />} tone="muted" />
        <div className="min-w-0 flex-1">
          <Kicker>Stay</Kicker>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {letter && <LetterBadge letter={letter} />}
            <h4 className="font-heading text-base font-semibold">{b.title ?? "Lodging"}</h4>
          </div>
          {place && (placeHasFacts(place) || (showWeather && place.lat != null)) && (
            <PlaceFacts
              place={place}
              blockLinks={shown}
              reviewsQuiet={b.status === "done"}
              showWeather={showWeather}
            />
          )}
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
  const trip = useTrip();
  const place = resolveBlockPlace(trip, b);
  const showWeather = tripInForecastWindow(trip);
  // Same Maps-link dedupe as ActivityBlock — PlaceFacts owns the canonical
  // deep link once the block resolves.
  const gm = place ? null : mapsLink(b, place);
  const shown = gm ? [gm, ...(b.links ?? [])] : b.links ?? [];
  return (
    <BlockCard b={b} cardProps={cardProps}>
      <div className="flex items-start gap-3">
        <IconBadge icon={<UtensilsCrossed className="h-4 w-4" />} tone="muted" />
        <div className="min-w-0 flex-1">
          <Kicker>Eat</Kicker>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {letter && <LetterBadge letter={letter} />}
            <h4 className="font-heading text-base font-semibold">{b.title ?? "Meal"}</h4>
          </div>
          {place && (placeHasFacts(place) || (showWeather && place.lat != null)) && (
            <PlaceFacts
              place={place}
              blockLinks={shown}
              reviewsQuiet={b.status === "done"}
              showWeather={showWeather}
            />
          )}
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
    <BlockCard b={b}>
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
          <YouTubeEmbeds links={b.links} />
        </div>
      </div>
    </BlockCard>
  );
}

function NoteBlock({ b }: { b: Block }) {
  return (
    <BlockCard b={b} className="border-l-4 border-l-primary/40 bg-muted/40">
      <div className="flex items-start gap-3">
        <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {b.title && <h4 className="font-heading text-sm font-semibold">{b.title}</h4>}
          {b.description && (
            <div className="text-sm leading-relaxed text-muted-foreground italic">
              <Markdown>{b.description}</Markdown>
            </div>
          )}
          <YouTubeEmbeds links={b.links} />
        </div>
      </div>
    </BlockCard>
  );
}

function GalleryBlock({ b }: { b: Block }) {
  // gallery items are stored {"url": name} (DTDL object array); older hand-written
  // Shapes may still carry bare strings — unwrap both.
  const imgs = (b.items ?? []) as (string | { url?: string })[];
  const files = imgs.map((it) => (typeof it === "string" ? it : it?.url ?? "")).filter(Boolean);
  // `images` counts as content too (#303): a gallery block that carries the
  // shared field renders its strip above the grid instead of vanishing.
  if (!files.length && !extractYouTubeId(b.links?.[0]?.url) && !b.images?.length) return null;
  return (
    <BlockCard b={b} className="p-3">
      {files.length > 0 && <PhotoGallery items={files} title={b.title ?? undefined} />}
      <YouTubeEmbeds links={b.links} />
    </BlockCard>
  );
}

function LinkBlock({ b }: { b: Block }) {
  const links = b.links ?? [];
  // Nothing to render without links — unless the block carries the shared
  // `images` field (#303), in which case its strip is the content.
  if (!links.length && !b.images?.length) return null;
  const rest = links.filter((l) => !extractYouTubeId(l.url));
  return (
    <BlockCard b={b}>
      <YouTubeEmbeds links={links} />
      {rest.length > 0 && (
        <div className="flex items-start gap-3">
          <IconBadge icon={<Link2 className="h-4 w-4" />} tone="muted" />
          <div className="min-w-0 flex-1">
            <Kicker>Links</Kicker>
            <ul className="mt-1 space-y-1">
              {rest.map((l) => (
                <li key={l.url}>
                  <ContentLink
                    url={l.url}
                    glyph="h-3.5 w-3.5"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                  >
                    {l.label}
                  </ContentLink>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </BlockCard>
  );
}

function BookingBlock({ b }: { b: Block }) {
  return (
    <BlockCard b={b} className="border-accent/40 bg-accent/5">
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

/** The raw-HTML escape hatch — deliberately NOT a `BlockCard` (the author's own
 *  markup is the surface), so it renders the shared media strip itself when the
 *  block carries `images` (#303) — `images` is a field of every kind. */
function CustomBlock({ b }: { b: Block }) {
  const media = cardMediaNode(useTrip(), b);
  if (!b.html && !media) return null;
  return (
    <>
      {media}
      {b.html ? (
        <div className="md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(b.html) }} />
      ) : null}
    </>
  );
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
