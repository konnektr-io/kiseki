import { useTrip } from "../components/theme";
import { DayBlocks, BlockGlyph } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";
import type { Day } from "../lib/types";

function SectionHeading({ title, part }: { title: string; part?: string }) {
  return (
    <div className="mb-4 mt-2 border-b-2 border-foreground pb-2">
      {part && <p className="kicker mb-1">Part {part}</p>}
      <h2 className="font-heading text-2xl font-semibold uppercase tracking-wide text-foreground">{title}</h2>
    </div>
  );
}

function DayCard({ day, no }: { day: Day; no: number }) {
  return (
    <div className="booklet-day mb-4">
      <div className="mb-2 flex items-baseline gap-3">
        <span className="font-display text-3xl leading-none text-primary">{no}</span>
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
        days: s.days.map((idx) => ({ day: trip.days[idx], no: idx + 1 })).filter((d) => d.day),
      }))
    : [{ title: "Itinerary", part: undefined, days: trip.days.map((day, i) => ({ day, no: i + 1 })) }];

  // bookings & status: every block that is booked or has a booking code
  const bookings = trip.days.flatMap((day, di) =>
    day.blocks
      .filter((b) => b.status === "booked" || b.status === "done" || b.bookingCode)
      .map((b) => ({ dayNo: di + 1, block: b })),
  );

  return (
    <div className="mx-auto max-w-3xl">
      {/* cover — fills the page in print */}
      <div className="booklet-cover relative overflow-hidden rounded-lg print:min-h-[269mm] print:rounded-none">
        {trip.cover && <img src={trip.cover} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/30" />
        <div className="relative flex min-h-[420px] flex-col justify-end p-8 print:min-h-[269mm]">
          <p className="kicker !text-white/70">Kiseki · trip booklet</p>
          <h1 className="mt-2 font-display text-6xl uppercase leading-[0.9] text-white print:text-7xl">{trip.title}</h1>
          {trip.subtitle && <p className="mt-3 text-sm font-medium uppercase tracking-wide text-white/80">{trip.subtitle}</p>}
          <p className="mt-4 text-sm text-white/80">
            {trip.startDate && formatDay(trip.startDate)} → {trip.endDate && formatDay(trip.endDate)}
            {trip.days.length > 0 && ` · ${trip.days.length} days`} · {trip.crew.length} crew
          </p>
        </div>
      </div>

      {/* at a glance */}
      {trip.stats?.length ? (
        <div className="booklet-section">
          <SectionHeading title="At a glance" />
          <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
            {trip.stats.map((s) => (
              <div key={s.label} className="rounded border border-border p-3 text-center">
                <p className="font-display text-2xl leading-none">{s.value}</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
          {trip.map && <img src={trip.map} alt="Route overview" className="mt-4 w-full rounded border border-border" />}
        </div>
      ) : null}

      {/* summary */}
      {trip.summary && (
        <div className="booklet-section">
          <SectionHeading title="The trip" />
          <div className="text-[15px] leading-relaxed">
            <Markdown>{trip.summary}</Markdown>
          </div>
        </div>
      )}

      {/* features — centerpiece / road trip */}
      {trip.features?.length ? (
        <div className="booklet-section">
          <SectionHeading title="The plan" />
          <div className="space-y-5">
            {trip.features.map((f, i) => (
              <div key={i} className="break-inside-avoid rounded border border-border p-4">
                <p className="kicker mb-1">{f.kicker || "Feature"}</p>
                <h3 className="font-heading text-xl font-semibold uppercase tracking-wide">{f.title}</h3>
                {f.image && <img src={f.image} alt="" className="my-3 w-full rounded border border-border" />}
                {f.description && (
                  <div className="text-sm leading-relaxed text-muted-foreground">
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
            ))}
          </div>
        </div>
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

      {/* bookings & status */}
      {bookings.length > 0 && (
        <div className="booklet-section">
          <SectionHeading title="Bookings & status" />
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-foreground text-left">
                <th className="kicker pb-1 pr-3">Day</th>
                <th className="kicker pb-1 pr-3">What</th>
                <th className="kicker pb-1 pr-3">Status</th>
                <th className="kicker pb-1">Code / cost</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map(({ dayNo, block }, i) => (
                <tr key={i} className="border-b border-border">
                  <td className="py-1.5 pr-3 font-heading font-semibold">{dayNo}</td>
                  <td className="py-1.5 pr-3">
                    <span className="mr-1.5 inline-flex align-middle">
                      <BlockGlyph kind={block.kind} />
                    </span>
                    {block.title ?? "—"}
                  </td>
                  <td className="py-1.5 pr-3 uppercase tracking-wide text-xs">
                    <span className={block.status === "booked" || block.status === "done" ? "font-semibold" : ""}>
                      {block.status ?? "—"}
                    </span>
                  </td>
                  <td className="py-1.5 font-mono text-xs">{block.bookingCode ?? ""}{block.cost != null ? ` ${block.cost.toLocaleString("de-DE", { maximumFractionDigits: 0 })} ${block.currency ?? ""}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
