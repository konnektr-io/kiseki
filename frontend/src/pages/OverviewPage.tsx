import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, CalendarDays, ChevronDown, MapPin, Users } from "lucide-react";
import { useTrip } from "../components/theme";
import { useCanEdit } from "../components/edit-mode";
import { Button, Card, Separator, StageBadge } from "../components/ui";
import { InlineField } from "../components/inline-edit";
import { TripMedia } from "../components/photos";
import { ContentLink } from "../components/content-link";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";
import { sectionRange } from "../lib/sections";
import { splitCrew } from "../lib/crew";
import { withTripFields } from "../lib/editing";
import { useTripWrite } from "../lib/useTripWrite";
import { putTrip } from "../lib/api";
import { capture } from "../lib/posthog";
import { TripMap } from "../components/MapView";
import { locatedPlaces } from "../lib/maps";
import { tripTracks } from "../lib/tracks";
import type { Feature } from "../lib/types";

function FeatureCard({ feature: f }: { feature: Feature }) {
  const trip = useTrip();
  const [open, setOpen] = useState(false);
  const all = locatedPlaces(trip);
  return (
    <Card className="overflow-hidden p-5">
      <p className="kicker mb-1">{f.kicker || "Feature"}</p>
      <h3 className="font-heading text-xl font-semibold uppercase leading-tight tracking-wide text-foreground">
        {f.title}
      </h3>

      {f.map && all.length >= 2 ? (
        <div className="mt-3 print:hidden">
          <TripMap places={all.map((l) => l.name)} loop tracks={tripTracks(trip)} />
        </div>
      ) : f.images && f.images.length > 1 ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {f.images.map((src) => (
            // TripMedia, not <img>: a clip plays here and prints as its poster
            // frame with a link (#250) — an <img src="….mp4"> shows nothing.
            // `fill`: the CELL owns the geometry and the image fills it, so the
            // cell has to state a box the image can fill — the shared 4:3 photo
            // box on a phone, the wide strip from md up (a fixed 160px cell is a
            // desktop strip; at 152px wide it would crop a landscape photo to
            // near-square). Without it the image sized itself by its own 4:3
            // ratio inside the cell and left the white band under every photo.
            <TripMedia key={src} src={src} alt={f.title} className="aspect-[4/3] w-full rounded-lg border border-border object-cover md:h-40" fill />
          ))}
        </div>
      ) : f.image && !f.map ? (
        // `aspect-[4/3]` beside the `max-h-64` cap: the CELL states the box the
        // image fills, so the cap crops nothing away (a bare `max-h-64` on the
        // wrapper just clipped a taller ratio-sized image, #284).
        <TripMedia src={f.image} alt={f.title} className="mt-3 aspect-[4/3] max-h-64 w-full rounded-lg border border-border object-cover" fill />
      ) : null}

      {f.chips?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {f.chips.map((c) => (
            <span
              key={c}
              className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </div>
      ) : null}

      {f.description && (
        <div className="mt-3 text-sm leading-relaxed md:text-[15px]">
          <Markdown>{f.description}</Markdown>
        </div>
      )}

      {/* cards: grid on desktop; expandable on mobile (images always shown) */}
      {f.cards && f.cards.length > 0 && (
        <>
          <div className="mt-3 hidden grid-cols-2 gap-3 md:grid md:grid-cols-4">
            {f.cards.map((c) => (
              <div key={c.title} className="overflow-hidden rounded-lg border border-border">
                {c.image && <TripMedia src={c.image} alt={c.title} className="h-24 w-full object-cover" fill />}
                <div className="p-2.5">
                  <p className="font-heading text-sm font-semibold uppercase leading-tight">{c.title}</p>
                  {c.value && <p className="text-xs font-semibold text-accent">{c.value}</p>}
                  {c.description && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.description}</p>}
                  {c.links?.map((l) => (
                    <ContentLink
                      key={l.url}
                      url={l.url}
                      className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-accent underline underline-offset-2"
                    >
                      {l.label}
                    </ContentLink>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="auto"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="mt-3 flex w-full items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5 md:hidden"
          >
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {open ? "Hide details" : `Show details (${f.cards.length})`}
            </span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
          {open && (
            <div className="mt-2 space-y-2.5 md:hidden">
              {f.cards.map((c) => (
                <div key={c.title} className="overflow-hidden rounded-lg border border-border">
                  {c.image && <TripMedia src={c.image} alt={c.title} className="h-28 w-full object-cover" fill />}
                  <div className="p-2.5">
                    <p className="font-heading text-sm font-semibold uppercase leading-tight">{c.title}</p>
                    {c.value && <p className="text-xs font-semibold text-accent">{c.value}</p>}
                    {c.description && <p className="mt-1 text-xs leading-snug text-muted-foreground">{c.description}</p>}
                    {c.links?.map((l) => (
                      <ContentLink
                        key={l.url}
                        url={l.url}
                        className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-accent underline underline-offset-2"
                      >
                        {l.label}
                      </ContentLink>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {f.links?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {f.links.map((l) => (
            <ContentLink
              key={l.url}
              url={l.url}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-primary hover:bg-primary/20"
            >
              {l.label} <ArrowRight className="h-3 w-3" />
            </ContentLink>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Trip title + subtitle, editable inline on the cover (#296) — the fix-a-typo
 * path that previously required opening chat. Editor+ only; everyone else
 * reads the same hero as before (InlineField's anon tree is display-only).
 */
function HeroTitleEdit() {
  const trip = useTrip();
  const { run, error } = useTripWrite();
  const canEdit = useCanEdit();
  return (
    <InlineField
      value={trip.title}
      label="Trip title"
      canEdit={canEdit}
      error={error}
      onSave={async (next) => {
        capture("trip_title_updated", { field: "title" });
        return (
          (await run(
            (token) => putTrip(trip.id, { title: next }, token),
            (t) => withTripFields(t, { title: next }),
          )) !== null
        );
      }}
      renderDisplay={(v) => (
        <h1 className="mt-3 font-display text-5xl uppercase leading-[0.95] text-white md:text-7xl">
          {v}
        </h1>
      )}
    />
  );
}

/**
 * Overview stat values are agent-written and sometimes arrive as sentences
 * ("Brussels → Batumi, one stop, then ~3h by road"). The strip renders them
 * BIG, so a long value blows its cell up. Two guards: the cell clamps + wraps
 * whatever arrives (this file), and the write path tells the agent to keep
 * values short (models.py `Stat`, api_write.py recipe). Either guard alone
 * holds the layout; together they hold the design.
 *
 * Font steps down with length so short numbers stay heroic while sentences
 * shrink instead of stretching the row. `min-w-0` lets the grid track win
 * over a long unbreakable token; `break-words` wraps it.
 */
export function statValueClass(value: string) {
  const len = value.length;
  if (len <= 10) return "font-display text-3xl leading-none tracking-wide tabular-nums text-foreground md:text-4xl";
  if (len <= 24) return "font-display text-xl leading-tight tracking-wide text-foreground md:text-2xl";
  return "text-sm font-semibold leading-snug text-foreground md:text-base";
}

function HeroSubtitleEdit() {
  const trip = useTrip();
  const { run, error } = useTripWrite();
  const canEdit = useCanEdit();
  return (
    <InlineField
      value={trip.subtitle ?? ""}
      label="Trip subtitle"
      canEdit={canEdit}
      error={error}
      placeholder="Add a subtitle"
      emptyLabel="Add a subtitle"
      onSave={async (next) => {
        capture("trip_title_updated", { field: "subtitle" });
        return (
          (await run(
            (token) => putTrip(trip.id, { subtitle: next }, token),
            (t) => withTripFields(t, { subtitle: next }),
          )) !== null
        );
      }}
      renderDisplay={(v) => (
        <p className="mt-2 max-w-xl text-sm font-medium uppercase tracking-wide text-white/85 md:text-base">
          {v}
        </p>
      )}
    />
  );
}

export function OverviewPage() {
  const trip = useTrip();
  const { tripId } = useParams();
  const doneTodos = (trip.practical.todos ?? []).filter((t) => t.done).length;
  const totalTodos = (trip.practical.todos ?? []).length;
  // Followers watch the trip; the crew is who is coming (#315). The overview
  // shows the crew as people and followers as a COUNT — the individual
  // followers live on the crew page, behind the link.
  const { members, followers } = splitCrew(trip.crew);

  return (
    <div className="space-y-6">
      {/* hero */}
      <div className="relative overflow-hidden rounded-2xl">
        {trip.cover && (
          <img src={trip.cover} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-black/20" />
        <div className="relative flex min-h-[280px] flex-col justify-end p-5 md:min-h-[360px] md:p-8">
          <div className="flex flex-wrap items-center gap-2">
            {/* the floating recipe is StageBadge's own now — only the text
                colour needs forcing against the cover photo */}
            <StageBadge stage={trip.stage} className="text-foreground" />
            <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-white/80">
              <CalendarDays className="h-3.5 w-3.5" />
              {trip.startDate && formatDay(trip.startDate)} → {trip.endDate && formatDay(trip.endDate)}
              {trip.days.length > 0 && ` · ${trip.days.length} days`}
            </span>
          </div>
          <HeroTitleEdit />
          <HeroSubtitleEdit />
          {trip.coverCredit && <p className="mt-3 text-[10px] uppercase tracking-widest text-white/50">© {trip.coverCredit}</p>}
        </div>
      </div>

      {/* at a glance — values are agent-written and sometimes long, so the
          cell clamps + wraps and the font steps down with length (see
          statValueClass above) instead of stretching the row. */}
      {trip.stats?.length ? (
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-6">
          {trip.stats.map((s) => (
            <div key={s.label} className="flex min-w-0 flex-col justify-center bg-card px-3 py-4 text-center">
              <p className={`${statValueClass(s.value)} line-clamp-3 break-words text-balance`}>
                {s.value}
              </p>
              <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {s.label}
              </p>
              <span className="mx-auto mt-2 block h-0.5 w-6 rounded-full bg-accent/60" />
            </div>
          ))}
        </div>
      ) : null}

      {/* features — editorial cards (centerpiece / road trip) */}
      {trip.features && trip.features.length > 0 && (
        <div className="space-y-5">
          {trip.features.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </div>
      )}

      {/* summary */}
      {trip.summary && (
        <Card className="p-5">
          <p className="kicker mb-2">The trip</p>
          <div className="text-[15px] leading-relaxed">
            <Markdown>{trip.summary}</Markdown>
          </div>
        </Card>
      )}

      {/* sections strip — each chapter is now a navigable surface */}
      {trip.sections?.length ? (
        <Card className="p-5">
          <p className="kicker mb-3">The loop</p>
          <ol className="space-y-2">
            {trip.sections.map((s, i) => (
              <li key={i} className="flex items-baseline gap-3">
                <span className="font-display text-2xl leading-none tabular-nums text-primary/70">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/t/${tripId}/itinerary#s-${i}`}
                    className="font-heading text-base font-medium text-foreground hover:text-primary"
                  >
                    {s.title}
                  </Link>
                  {sectionRange(s.days) && (
                    <span className="ml-2 text-xs tabular-nums text-muted-foreground">{sectionRange(s.days)}</span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {/* crew — the people coming. Followers are reduced to a count that links
          to the crew page's followers section (#315); no individual follower is
          listed on the trip's own surfaces. */}
      {(members.length > 0 || followers.length > 0) && (
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="kicker">The crew</p>
            <Link
              to={`/t/${tripId}/crew`}
              className="no-print inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {members.length > 0 && (
            <ul className="space-y-2.5">
              {members.map((p) => (
                <li key={p.name} className="flex items-center gap-3">
                  <span className="inline-flex aspect-square h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-heading text-sm font-semibold text-primary">
                    {p.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                  </span>
                  <div className="min-w-0">
                    <p className="font-heading text-sm font-semibold">{p.name}</p>
                    {p.note && <p className="truncate text-xs text-muted-foreground">{p.note}</p>}
                  </div>
                  <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" /> {p.role}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {followers.length > 0 && (
            <Link
              to={`/t/${tripId}/crew#followers`}
              className={`no-print flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground ${
                members.length > 0 ? "mt-3 border-t border-border pt-3" : ""
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              <span className="tabular-nums">
                {followers.length} {followers.length === 1 ? "follower" : "followers"}
              </span>
              <span className="ml-auto inline-flex items-center gap-1 font-medium text-accent">
                See who <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </Link>
          )}
        </Card>
      )}

      {/* practical preview */}
      {(totalTodos > 0 || (trip.practical.links?.length ?? 0) > 0) && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <p className="kicker">Practical</p>
            <Link to={`/t/${tripId}/practical`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
              Full list <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {totalTodos > 0 && (
            <>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${Math.round((doneTodos / totalTodos) * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">
                {doneTodos}/{totalTodos} done
              </p>
            </>
          )}
          {trip.practical.links?.length ? (
            <ul className="mt-3 space-y-1">
              {trip.practical.links.slice(0, 4).map((l) => (
                <li key={l.url} className="flex items-center gap-2 text-sm">
                  <MapPin className="h-3 w-3 text-muted-foreground" />
                  <ContentLink url={l.url} className="text-accent hover:underline">
                    {l.label}
                  </ContentLink>
                </li>
              ))}
            </ul>
          ) : null}
          <Separator className="my-4" />
          {trip.practical.notes && (
            <div className="text-sm leading-relaxed text-muted-foreground">
              <Markdown>{trip.practical.notes}</Markdown>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
