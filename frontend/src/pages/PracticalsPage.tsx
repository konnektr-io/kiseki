import { ExternalLink, ListChecks } from "lucide-react";
import { useTrip } from "../components/theme";
import { Card } from "../components/ui";
import { Markdown } from "../lib/markdown";

export function PracticalsPage() {
  const trip = useTrip();
  const todos = trip.practical?.todos ?? [];
  const links = trip.practical?.links ?? [];
  const done = todos.filter((t) => t.done).length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Practical</h1>

      {todos.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <ListChecks className="h-4 w-4" />
            To-do · {done}/{todos.length}
          </h2>
          <ul className="space-y-1.5">
            {todos.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
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
        </Card>
      )}

      {links.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Important links
          </h2>
          <ul className="space-y-2">
            {links.map((l) => (
              <li key={l.url}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {trip.practical?.notes && (
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h2>
          <Markdown>{trip.practical.notes}</Markdown>
        </Card>
      )}

      {!todos.length && !links.length && !trip.practical?.notes && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          Nothing here yet.
        </p>
      )}
    </div>
  );
}
