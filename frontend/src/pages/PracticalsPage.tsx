import { ExternalLink, ListChecks, Phone, Users } from "lucide-react";
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
            <span className="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-muted-foreground">
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
                <span className={`min-w-0 flex-1 ${t.done ? "text-muted-foreground line-through" : ""}`}>
                  {t.label}
                  {t.links?.length ? (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {t.links.map((l) => (
                        <a
                          key={l.url}
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-muted"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {l.label}
                        </a>
                      ))}
                    </span>
                  ) : null}
                </span>
                {t.when && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t.when}
                  </span>
                )}
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

      {trip.crew.length > 0 && (
        <Card className="p-5">
          <p className="kicker mb-3">Group</p>
          <ul className="space-y-3">
            {trip.crew.map((p) => (
              <li key={p.name} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex aspect-square h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 font-heading text-xs font-semibold text-primary">
                  {p.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                </span>
                <div className="min-w-0">
                  <p className="font-heading text-sm font-semibold">{p.name}</p>
                  {p.note && <p className="text-xs text-muted-foreground">{p.note}</p>}
                  {p.contact && (
                    <a href={`tel:${p.contact.replace(/\s/g, "")}`} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                      <Phone className="h-3 w-3" /> {p.contact}
                    </a>
                  )}
                </div>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Users className="h-3 w-3" /> {p.role}
                </span>
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
