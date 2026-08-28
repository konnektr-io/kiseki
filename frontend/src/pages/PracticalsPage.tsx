import { ExternalLink, ListChecks, Phone } from "lucide-react";
import { useTrip } from "../components/theme";
import { Card } from "../components/ui";
import { Markdown } from "../lib/markdown";

export function PracticalsPage() {
  const trip = useTrip();
  const todos = trip.practical.todos ?? [];
  const links = trip.practical.links ?? [];
  const contacts = trip.practical.contacts ?? [];
  const done = todos.filter((t) => t.done).length;

  return (
    <div className="space-y-5">
      {todos.length > 0 && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <p className="kicker">Checklist</p>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5" /> {done}/{todos.length}
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((done / todos.length) * 100)}%` }} />
          </div>
          <ul className="mt-4 space-y-2">
            {todos.map((t, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <span
                  className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                    t.done ? "bg-accent text-accent-foreground" : "border border-border"
                  }`}
                >
                  {t.done && <span className="text-[10px]">✓</span>}
                </span>
                <span className={t.done ? "text-muted-foreground line-through" : ""}>{t.label}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {contacts.length > 0 && (
        <Card className="p-5">
          <p className="kicker mb-3">Contacts</p>
          <ul className="space-y-3">
            {contacts.map((c, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Phone className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <p className="font-heading text-sm font-semibold">{c.label}</p>
                  {c.value && <p className="text-xs text-muted-foreground">{c.value}</p>}
                  {c.link && (
                    <a href={c.link} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                      {c.link.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {links.length > 0 && (
        <Card className="p-5">
          <p className="kicker mb-3">Important links</p>
          <ul className="space-y-1.5">
            {links.map((l) => (
              <li key={l.url}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> {l.label}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {trip.practical.notes && (
        <Card className="p-5">
          <p className="kicker mb-2">At a glance</p>
          <div className="text-sm leading-relaxed text-muted-foreground">
            <Markdown>{trip.practical.notes}</Markdown>
          </div>
        </Card>
      )}
    </div>
  );
}
