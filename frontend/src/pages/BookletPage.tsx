import { useTrip } from "../components/theme";
import { DayBlocks } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay, formatDate } from "../lib/dates";

/**
 * Print-optimised booklet view (A4). This is what the backend's Playwright
 * PDF endpoint renders — keep it clean and page-break friendly.
 */
export function BookletPage() {
  const trip = useTrip();

  return (
    <div className="booklet text-sm">
      {/* Cover-ish header */}
      <section className="text-center">
        {trip.cover && (
          <img src={trip.cover} alt="" className="mb-4 max-h-64 w-full object-cover rounded-lg" />
        )}
        <h1 className="text-3xl font-bold">{trip.title}</h1>
        {trip.subtitle && <p className="mt-1 text-muted-foreground">{trip.subtitle}</p>}
        <p className="mt-2 text-sm text-muted-foreground">
          {trip.startDate && trip.endDate
            ? `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}`
            : "Dates TBD"}{" "}
          · {trip.stage}
        </p>
        {trip.crew.length > 0 && (
          <p className="mt-1 text-muted-foreground">
            {trip.crew.map((c) => c.name).join(" · ")}
          </p>
        )}
      </section>

      {trip.summary && (
        <section className="mt-6">
          <h2 className="mb-2 text-lg font-bold">Overview</h2>
          <Markdown>{trip.summary}</Markdown>
        </section>
      )}

      {/* Days */}
      {trip.days.map((day, idx) => (
        <section key={day.date} className="booklet-day">
          <h2 className="mb-1 text-lg font-bold">
            Day {idx + 1} — {formatDay(day.date)}
          </h2>
          {day.title && <p className="mb-2 font-medium">{day.title}</p>}
          {day.notes && (
            <div className="mb-3 rounded bg-muted p-3">
              <Markdown>{day.notes}</Markdown>
            </div>
          )}
          <DayBlocks blocks={day.blocks} />
        </section>
      ))}

      {/* Practical */}
      {(trip.practical?.todos?.length ||
        trip.practical?.links?.length ||
        trip.practical?.notes) && (
        <section className="booklet-day">
          <h2 className="mb-2 text-lg font-bold">Practical</h2>
          {trip.practical.todos && trip.practical.todos.length > 0 && (
            <ul className="mb-4 space-y-1">
              {trip.practical.todos.map((t, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                      t.done ? "border-accent bg-accent text-accent-foreground" : "border-border"
                    }`}
                  >
                    {t.done ? "✓" : ""}
                  </span>
                  <span className={t.done ? "text-muted-foreground line-through" : undefined}>
                    {t.label}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {trip.practical.links && trip.practical.links.length > 0 && (
            <ul className="mb-4 list-disc space-y-1 pl-5">
              {trip.practical.links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} className="underline underline-offset-2">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {trip.practical.notes && <Markdown>{trip.practical.notes}</Markdown>}
        </section>
      )}
    </div>
  );
}
