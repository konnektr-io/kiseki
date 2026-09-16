import { ExternalLink, ListChecks, Phone, Users, ArrowRight } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useTrip } from "../components/theme";
import { Card } from "../components/ui";
import { TricountPanel } from "../components/TricountPanel";
import { ContentLink } from "../components/content-link";
import { Markdown } from "../lib/markdown";
import { toggleTodoItem } from "../lib/api";
import { roleAtLeast, withTodoDone } from "../lib/editing";
import { useTripWrite } from "../lib/useTripWrite";

export function PracticalsPage() {
  const trip = useTrip();
  const { tripId } = useParams();
  const canEdit = roleAtLeast(trip.myRole, "editor");
  const { busy, error, run } = useTripWrite();
  const todos = trip.practical.todos ?? [];
  const links = trip.practical.links ?? [];
  const blocks = trip.practical.blocks ?? [];
  const contacts = trip.practical.contacts ?? [];
  const done = todos.filter((t) => t.done).length;
  // #231: the TriCount card is only worth a slot here once the trip is
  // actually connected to one — an unlinked trip has nothing to show, and the
  // card was reading as a permanent, prominent fixture for trips that don't
  // use TriCount at all. The connect affordance lives in the trip actions
  // menu (owner-only, `trip-controls.tsx`), beside Stage/Theme/Sharing.
  const tricountLinked = Boolean(trip.practical.tricount);

  const toggle = (index: number, nextDone: boolean) => {
    void run(
      (token) => toggleTodoItem(trip.id, index, nextDone, token),
      (t) => withTodoDone(t, index, nextDone),
    );
  };

  return (
    <div className="space-y-5">
      {tricountLinked && <TricountPanel />}
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
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => toggle(i, !t.done)}
                    disabled={busy}
                    aria-pressed={!!t.done}
                    aria-label={`Mark "${t.label}" ${t.done ? "not done" : "done"}`}
                    className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-50 ${
                      t.done ? "bg-accent text-accent-foreground" : "border border-border hover:border-accent"
                    }`}
                  >
                    {t.done && <span className="text-[10px]">✓</span>}
                  </button>
                ) : (
                  <span
                    className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                      t.done ? "bg-accent text-accent-foreground" : "border border-border"
                    }`}
                  >
                    {t.done && <span className="text-[10px]">✓</span>}
                  </span>
                )}
                <span className={`min-w-0 flex-1 ${t.done ? "text-muted-foreground line-through" : ""}`}>
                  {t.label}
                  {t.links?.length ? (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {t.links.map((l) => (
                        <ContentLink
                          key={l.url}
                          url={l.url}
                          glyph="h-3 w-3"
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-muted"
                        >
                          {l.label}
                        </ContentLink>
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
          {error && (
            <p role="alert" className="mt-2 text-xs font-medium text-destructive">
              {error}
            </p>
          )}
        </Card>
      )}

      {/* #254 — the roadbook's practicalities under their OWN headings
          ("Driving times", "Money & tipping", "Water & health"). This is a
          document surface, so these render as heading + prose, deliberately
          WITHOUT card chrome: a wall of text becomes a readable, printable
          set of sections, and the page stays booklet-faithful (DESIGN §2.1). */}
      {blocks.map((b, i) => (
        <section key={`${b.title}-${i}`} className="space-y-1.5">
          <h2 className="font-heading text-lg font-semibold tracking-wide">{b.title}</h2>
          <div className="text-sm leading-relaxed text-muted-foreground">
            <Markdown>{b.body}</Markdown>
          </div>
        </section>
      ))}

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
          <div className="mb-3 flex items-center justify-between">
            <p className="kicker">Group</p>
            <Link
              to={`/t/${tripId}/crew`}
              className="no-print inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
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
