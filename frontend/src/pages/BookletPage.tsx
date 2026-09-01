import { useTrip } from "../components/theme";
import { DayBlocks, BlockGlyph, useLocationMarkers } from "../components/blocks";
import { StaticMapImg } from "../components/MapView";
import { locatedPlaces } from "../lib/maps";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";
import { expandSectionDays } from "../lib/sections";
import type { Day, Feature } from "../lib/types";

function SectionHeading({ title, part }: { title: string; part?: string }) {
  return (
    <div className="mb-4 mt-2 border-b-2 border-foreground pb-2">
      {part && <p className="kicker mb-1">Part {part}</p>}
      <h2 className="font-heading text-2xl font-semibold uppercase tracking-wide text-foreground">{title}</h2>
    </div>
  );
}

function FeatureBlock({ f }: { f: Feature }) {
  const marker = useLocationMarkers();
  const trip = useTrip();
  const all = locatedPlaces(trip);
  return (
    <div className="mb-5 break-inside-avoid">
      <p className="kicker mb-1">{f.kicker || "Feature"}</p>
      <h3 className="font-heading text-xl font-semibold uppercase tracking-wide text-foreground">{f.title}</h3>

      {f.map && all.length >= 2 ? (
        <div className="mt-3">
          <StaticMapImg places={all.map((l) => l.name)} loop />
        </div>
      ) : f.images && f.images.length > 1 ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {f.images.map((src) => (
            <img key={src} src={src} alt="" className="h-40 w-full rounded object-cover" />
          ))}
        </div>
      ) : f.image && !f.map ? (
        <img src={f.image} alt="" className="mt-3 max-h-64 w-full rounded object-cover" />
      ) : null}

      {f.chips?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {f.chips.map((c) => (
            <span key={c} className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {c}
            </span>
          ))}
        </div>
      ) : null}

      {f.cards?.length ? (
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {f.cards.map((c) => (
            <div key={c.title} className="overflow-hidden rounded border border-border">
              {c.image && <img src={c.image} alt="" className="h-24 w-full object-cover" />}
              <div className="p-2.5">
                <p className="font-heading text-sm font-semibold uppercase leading-tight">
                  {marker(c.title) !== "•" ? `${marker(c.title)} ` : ""}
                  {c.title}
                </p>
                {c.value && <p className="text-xs font-semibold text-accent">{c.value}</p>}
                {c.description && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.description}</p>}
                {c.links?.map((l) => (
                  <a key={l.url} href={l.url} className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-accent underline underline-offset-2">
                    {l.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {f.description && (
        <div className="mt-3 text-sm leading-relaxed text-muted-foreground">
          <Markdown>{f.description}</Markdown>
        </div>
      )}

      {f.links?.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {f.links.map((l) => (
            <a key={l.url} href={l.url} className="text-xs font-semibold uppercase tracking-wide text-accent underline underline-offset-2">
              {l.label} →
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DayCard({ day, no }: { day: Day; no: number }) {
  return (
    <div className="booklet-day mb-4">
      <div className="booklet-day-head mb-2 flex items-baseline gap-3">
        <span className="font-display text-3xl leading-none tabular-nums text-primary">{no}</span>
        <div>
          <p className="kicker">{formatDay(day.date)}</p>
          <h3 className="font-heading text-lg font-semibold uppercase leading-tight text-foreground">
            {day.title || formatDay(day.date)}
          </h3>
        </div>
      </div>
      {day.map && <img src={day.map} alt="" className="mb-3 w-full rounded border border-border" />}
      {day.meta?.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {day.meta.map((m, i) => (
            <span key={i} className="rounded border border-border bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
              <span className="font-bold uppercase tracking-wide">{m.label}:</span> {m.value}
            </span>
          ))}
        </div>
      ) : null}
      {day.notes && (
        <div className="mb-3 text-sm leading-relaxed text-muted-foreground">
          <Markdown>{day.notes}</Markdown>
        </div>
      )}
      <div className="space-y-2">
        <DayBlocks blocks={day.blocks} />
      </div>
    </div>
  );
}

export function BookletPage() {
  const trip = useTrip();

  // group days: use sections when present, else all days
  const groups = trip.sections?.length
    ? trip.sections.map((s, si) => ({
        title: s.title,
        part: String(si + 1).padStart(2, "0"),
        days: expandSectionDays(s.days)
          .map((idx) => ({ day: trip.days[idx], no: idx + 1 }))
          .filter((d) => d.day),
      }))
    : [{ title: "Itinerary", part: undefined, days: trip.days.map((day, i) => ({ day, no: i + 1 })) }];

  // bookings & status: booked/done blocks with codes + costs, then every open to-do
  const bookedBlocks = trip.days.flatMap((day, di) =>
    day.blocks
      .filter((b) => b.status === "booked" || b.status === "done" || b.bookingCode)
      .map((b) => ({ dayNo: di + 1, block: b })),
  );
  const openTodos = (trip.practical.todos ?? []).filter((t) => !t.done);
  const coverStats = trip.coverStats?.length ? trip.coverStats : [];

  return (
    <div className="mx-auto max-w-3xl print:max-w-none">
      {/* cover — full-bleed page in print */}
      <div className="booklet-cover relative overflow-hidden">
        {trip.cover && <img src={trip.cover} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/25" />
        <div className="relative flex h-[420px] flex-col justify-end p-6 md:h-[520px] md:p-10 print:h-[297mm] print:w-[210mm] print:p-8">
          <p className="kicker !text-white/70">Kiseki · trip booklet</p>
          <h1 className="mt-2 font-display text-5xl uppercase leading-[0.9] text-white md:text-7xl">
            {trip.title}
          </h1>
          {trip.subtitle && <p className="mt-3 text-sm font-medium uppercase tracking-wide text-white/80">{trip.subtitle}</p>}
          <div className="mt-5 space-y-1.5">
            {coverStats.map((line, i) => (
              <p key={i} className="font-heading text-xs font-medium tracking-[0.16em] text-white/90 md:text-[13px]">
                {line}
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* features — one per page, borderless */}
      {trip.features?.length ? (
        trip.features.map((f, i) => (
          <div key={i} className={i === 0 ? "pt-6" : "booklet-section"}>
            <FeatureBlock f={f} />
          </div>
        ))
      ) : null}

      {/* itinerary by section */}
      {groups.map((g, gi) => (
        <div key={gi} className="booklet-section">
          <SectionHeading title={g.title} part={g.part} />
          {g.days.map(({ day, no }) => (
            <DayCard key={no} day={day} no={no} />
          ))}
        </div>
      ))}

      {/* bookings & status — booked blocks + everything still to book */}
      {(bookedBlocks.length > 0 || openTodos.length > 0) && (
        <div className="booklet-section">
          <SectionHeading title="Bookings & status" />
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-foreground text-left">
                <th className="kicker pb-1 pr-3">Day / When</th>
                <th className="kicker pb-1 pr-3">What</th>
                <th className="kicker pb-1 pr-3">Status</th>
                <th className="kicker pb-1">Code / cost</th>
              </tr>
            </thead>
            <tbody>
              {bookedBlocks.map(({ dayNo, block }, i) => (
                <tr key={`b${i}`} className="border-b border-border">
                  <td className="py-1.5 pr-3 font-heading font-semibold tabular-nums">{dayNo}</td>
                  <td className="py-1.5 pr-3">
                    <span className="mr-1.5 inline-flex align-middle">
                      <BlockGlyph kind={block.kind} />
                    </span>
                    {block.title ?? "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-xs uppercase tracking-wide">
                    <span className="font-semibold">{block.status ?? "booked"}</span>
                  </td>
                  <td className="py-1.5 font-mono text-xs tabular-nums">
                    {block.bookingCode ?? ""}{block.cost != null ? ` ${block.cost.toLocaleString("de-DE", { maximumFractionDigits: 0 })} ${block.currency ?? ""}` : ""}
                  </td>
                </tr>
              ))}
              {openTodos.map((t, i) => (
                <tr key={`t${i}`} className="border-b border-border">
                  <td className="py-1.5 pr-3 font-heading font-semibold">{t.when ?? "—"}</td>
                  <td className="py-1.5 pr-3">
                    {t.label}
                    {t.links?.length ? (
                      <span className="block text-[10px] leading-snug text-muted-foreground">
                        {t.links.map((l) => l.label).join(" · ")}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 text-xs uppercase tracking-wide text-muted-foreground">to book</td>
                  <td className="py-1.5 font-mono text-xs text-muted-foreground">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* key info — contacts / dates / group / essentials (booklet 'At a glance') */}
      {(trip.practical.contacts?.length || trip.practical.notes || trip.crew.length > 0) && (
        <div className="booklet-section">
          <SectionHeading title="Key info" />
          <div className="grid grid-cols-2 gap-4">
            {trip.practical.contacts?.length ? (
              <div>
                <p className="kicker mb-2">Contacts</p>
                <ul className="space-y-2">
                  {trip.practical.contacts.map((c, i) => (
                    <li key={i} className="text-xs leading-relaxed">
                      <p className="font-heading font-semibold">{c.label}</p>
                      {c.value && <p className="text-muted-foreground">{c.value}</p>}
                      {c.link && (
                        <a href={c.link} className="text-accent underline underline-offset-2">{c.link.replace(/^https?:\/\//, "")}</a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {trip.crew.length > 0 && (
              <div>
                <p className="kicker mb-2">Group</p>
                <ul className="space-y-1.5">
                  {trip.crew.map((p) => (
                    <li key={p.name} className="text-xs">
                      <span className="font-heading font-semibold">{p.name}</span>
                      {p.note && <span className="text-muted-foreground"> — {p.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {trip.startDate && (
              <div>
                <p className="kicker mb-2">Dates</p>
                <p className="text-xs text-muted-foreground">
                  {formatDay(trip.startDate)} → {trip.endDate && formatDay(trip.endDate)}
                  {trip.days.length > 0 && ` (${trip.days.length} days)`}
                </p>
              </div>
            )}
            {trip.practical.notes && (
              <div>
                <p className="kicker mb-2">Essentials</p>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  <Markdown>{trip.practical.notes}</Markdown>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
