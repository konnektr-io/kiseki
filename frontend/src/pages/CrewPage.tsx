import { useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Check, Link2, Pencil, UserPlus, X } from "lucide-react";
import { useTrip } from "../components/theme";
import { Badge, Button, Card } from "../components/ui";
import { fetchJoinLink, patchCrewMember, TripAccessError } from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { roleAtLeast, withCrewMember } from "../lib/editing";
import { useTripWrite } from "../lib/useTripWrite";
import type { Person, Role } from "../lib/types";

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
  follower: "Follower",
};
const ROLE_ORDER: Role[] = ["owner", "editor", "viewer", "follower"];

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:focus-ring disabled:opacity-50";
const labelCls = "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

/** Per-member inline editor: trip note (editor+) and role (owner-only). */
function MemberEditor({
  person,
  busy,
  isOwner,
  onCancel,
  onSave,
}: {
  person: Person;
  busy: boolean;
  isOwner: boolean;
  onCancel: () => void;
  onSave: (patch: { note?: string | null; role?: Role }) => void;
}) {
  const [note, setNote] = useState(person.note ?? "");
  const [role, setRole] = useState<Role>(person.role);

  const save = () => {
    const patch: { note?: string | null; role?: Role } = {};
    if (note !== (person.note ?? "")) patch.note = note === "" ? null : note;
    if (isOwner && role !== person.role) patch.role = role;
    if (Object.keys(patch).length) onSave(patch);
    else onCancel();
  };

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <p className="kicker mb-2">Edit {person.name.split(" ")[0]}</p>
      <div className="space-y-2.5">
        <div>
          <label className={labelCls} htmlFor={`crew-note-${person.id}`}>
            Note (trip-specific — gear, dietary, …)
          </label>
          <textarea
            id={`crew-note-${person.id}`}
            className={`${inputCls} min-h-16 resize-y`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            placeholder="e.g. Skis — Elan Playmaker 111 · touring bindings?"
          />
        </div>
        {isOwner && (
          <div>
            <label className={labelCls} htmlFor={`crew-role-${person.id}`}>
              Role on this trip
            </label>
            <select
              id={`crew-role-${person.id}`}
              className={inputCls}
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              disabled={busy}
            >
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button variant="default" size="sm" onClick={save} disabled={busy}>
          <Check className="h-3.5 w-3.5" /> Save
        </Button>
      </div>
    </div>
  );
}

export function CrewPage() {
  const trip = useTrip();
  const { getAccessTokenSilently, isAuthenticated, loginWithRedirect } = useAuth0();
  const { busy, error, run } = useTripWrite();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  const canEdit = roleAtLeast(trip.myRole, "editor");
  const isOwner = trip.myRole === "owner";
  const hasPlaceholders = trip.crew.some((p) => !p.claimed);

  const saveMember = async (person: Person, patch: { note?: string | null; role?: Role }) => {
    setEditingId(null);
    await run(
      (token) => patchCrewMember(trip.id, person.id, patch, token),
      (t) => withCrewMember(t, person.id, patch),
    );
  };

  const copyInviteLink = async () => {
    try {
      if (!isAuthenticated) {
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      const at = await getAccessTokenSilently();
      const joinUrl = await fetchJoinLink(trip.id, at);
      await navigator.clipboard.writeText(window.location.origin + joinUrl);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch (e) {
      if (isSessionExpiredError(e)) {
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      if (e instanceof TripAccessError && e.status === 403) setInviteCopied(false);
    }
  };

  if (!trip.crew.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
        Crew not announced yet.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Crew</h1>
        {isOwner && hasPlaceholders && (
          <Button variant="outline" size="sm" onClick={() => void copyInviteLink()} disabled={busy}>
            {inviteCopied ? (
              <>
                <Check className="h-3.5 w-3.5" /> Copied!
              </>
            ) : (
              <>
                <Link2 className="h-3.5 w-3.5" /> Copy invite link
              </>
            )}
          </Button>
        )}
      </div>
      {trip.crew.map((p) => (
        <Card key={p.id} className="p-4">
          <div className="flex items-center gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
              {initials(p.name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{p.name}</p>
                <Badge variant={p.role === "owner" ? "default" : "outline"}>
                  {ROLE_LABELS[p.role]}
                </Badge>
                {!p.claimed && (
                  <Badge variant="outline" className="border-dashed text-muted-foreground">
                    <UserPlus className="h-3 w-3" /> Not joined yet
                  </Badge>
                )}
              </div>
              {p.note ? (
                <p className="mt-0.5 text-sm text-muted-foreground">{p.note}</p>
              ) : (
                <p className="mt-0.5 text-sm italic text-muted-foreground/60">No note</p>
              )}
            </div>
            {canEdit && (
              <button
                type="button"
                className="no-print inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring disabled:opacity-40"
                disabled={busy || editingId !== null}
                onClick={() => setEditingId(editingId === p.id ? null : p.id)}
                aria-label={`Edit ${p.name}`}
                title="Edit note & role"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {editingId === p.id && (
            <div className="mt-3">
              <MemberEditor
                person={p}
                busy={busy}
                isOwner={isOwner}
                onCancel={() => setEditingId(null)}
                onSave={(patch) => void saveMember(p, patch)}
              />
            </div>
          )}
        </Card>
      ))}
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
