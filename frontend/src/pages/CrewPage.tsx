import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { Check, Link2, Pencil, Trash2, UserPlus, X } from "lucide-react";
import { useTrip } from "../components/theme";
import { Badge, Button, Card } from "../components/ui";
import {
  addCrewMember,
  fetchJoinLink,
  patchCrewMember,
  removeCrewMember,
  TripAccessError,
  type AddCrewMemberBody,
} from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { splitCrew } from "../lib/crew";
import { withAddedCrew, withCrewMember, withRemovedCrew } from "../lib/editing";
import { useCanEdit } from "../components/edit-mode";
import { useFollowing } from "../lib/following";
import { useTripWrite } from "../lib/useTripWrite";
import type { Person, ProfilePerson, Role } from "../lib/types";

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
  follower: "Follower",
};
const ROLE_ORDER: Role[] = ["owner", "editor", "viewer", "follower"];

/** How many "people you follow" chips the add panel shows before it switches to
 *  search-only (#198 follow-up): a follow list is unbounded, a row of pills is
 *  not. */
const MAX_FOLLOW_CHIPS = 8;

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
            placeholder="e.g. dietary needs, gear, arrival details…"
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

/** One selectable row in the "people you follow" picker (#198 follow-up). */
function FollowedChip({
  person,
  selected,
  busy,
  onPick,
}: {
  person: ProfilePerson;
  selected: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={busy}
      onClick={onPick}
      className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors focus-visible:focus-ring disabled:opacity-50 ${
        selected
          ? "border-primary bg-primary/10 font-medium text-foreground"
          : "border-border bg-background text-foreground hover:bg-muted"
      }`}
    >
      {person.avatar ? (
        <img
          src={person.avatar}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary"
        >
          {initials(person.name)}
        </span>
      )}
      <span className="max-w-[12rem] truncate">{person.name}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
    </button>
  );
}

/** The open add-crew panel (exported for the SSR test): pick someone you
 *  already follow — they become crew straight away, no placeholder and no
 *  invite link — or fall through to the manual name form for someone who is
 *  not on Kiseki yet.
 *
 *  Picking is an OWNER-only affordance, mirroring the server (attaching an
 *  existing account hands out access, so it is the owner's call — see
 *  `write.add_crew`). */
export function AddCrewPanel({
  busy,
  isOwner,
  following,
  crewIds,
  loadingFollowing,
  onAdd,
  onClose,
}: {
  busy: boolean;
  isOwner: boolean;
  following: ProfilePerson[];
  crewIds: string[];
  loadingFollowing: boolean;
  onAdd: (body: AddCrewMemberBody) => Promise<boolean>;
  onClose: () => void;
}) {
  const [sub, setSub] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [query, setQuery] = useState("");

  const onCrew = new Set(crewIds);
  const candidates = following.filter((p) => !onCrew.has(p.sub));
  // A long follow list is the normal case for anyone who uses the follow
  // graph, so the picker searches and caps: at most MAX_FOLLOW_CHIPS buttons,
  // with the rest behind the search box. The currently picked person stays
  // pinned — narrowing the list must never hide who is selected.
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? candidates.filter((p) => p.name.toLowerCase().includes(needle))
    : candidates;
  const picked = candidates.find((p) => p.sub === sub);
  const pinned = picked && !matches.includes(picked) ? [picked] : [];
  const shown = [...pinned, ...matches.filter((p) => p !== picked)]
    .slice(0, MAX_FOLLOW_CHIPS);
  const hiddenCount = matches.length - (shown.length - pinned.length);

  const pick = (person: ProfilePerson) => {
    if (sub === person.sub) {
      setSub(undefined);
      setName("");
      return;
    }
    setSub(person.sub);
    setName(person.name);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const body: AddCrewMemberBody = { name: trimmed, role };
    if (note.trim()) body.note = note.trim();
    if (sub) body.sub = sub;
    else if (contact.trim()) body.contact = contact.trim();
    const ok = await onAdd(body);
    if (ok) {
      setSub(undefined);
      setName("");
      setRole("viewer");
      setNote("");
      setContact("");
      onClose();
    }
  };

  return (
    <div data-crew-add-panel className="rounded-xl border border-border bg-card p-4">
      <p className="kicker mb-2">Add crew member</p>
      {isOwner && (
        <div className="mb-3">
          <p className={labelCls}>People you follow</p>
          {loadingFollowing ? (
            <p className="text-xs text-muted-foreground">Loading people you follow…</p>
          ) : candidates.length ? (
            <>
              {candidates.length > MAX_FOLLOW_CHIPS && (
                <input
                  id="crew-add-search"
                  type="search"
                  className={`${inputCls} mb-2`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={busy}
                  aria-label="Search people you follow"
                  placeholder={`Search ${candidates.length} people you follow`}
                />
              )}
              {shown.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {shown.map((p) => (
                    <FollowedChip
                      key={p.sub}
                      person={p}
                      selected={sub === p.sub}
                      busy={busy}
                      onPick={() => pick(p)}
                    />
                  ))}
                </div>
              )}
              {needle !== "" && matches.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No one you follow matches “{query.trim()}”.
                </p>
              )}
              {hiddenCount > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {hiddenCount} more — search to narrow the list.
                </p>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground">
                Pick someone and they join this trip right away — they already have an
                account, so there is no invite link to send.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              You don't follow anyone who isn't on this crew yet — add someone by name
              below and share the invite link.
            </p>
          )}
        </div>
      )}
      <div className="space-y-2.5">
        <div>
          <label className={labelCls} htmlFor="crew-add-name">
            {sub ? "Name on this trip" : "Name"}
          </label>
          <input
            id="crew-add-name"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="e.g. Alex Morgan"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="crew-add-role">
            Role on this trip
          </label>
          <select
            id="crew-add-role"
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
        <div>
          <label className={labelCls} htmlFor="crew-add-note">
            Note (optional)
          </label>
          <input
            id="crew-add-note"
            className={inputCls}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            placeholder="e.g. dietary needs, gear, arrival details…"
          />
        </div>
        {sub ? (
          <p className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs text-foreground">
            They have an account, so this adds them straight to the crew — they can read
            the trip as soon as you save.
          </p>
        ) : (
          <div>
            <label className={labelCls} htmlFor="crew-add-contact">
              Contact (optional)
            </label>
            <input
              id="crew-add-contact"
              className={inputCls}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              disabled={busy}
              placeholder="e.g. phone or email"
            />
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button variant="default" size="sm" onClick={() => void submit()} disabled={busy || !name.trim()}>
          <Check className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}

export function CrewPage() {
  const trip = useTrip();
  const { getAccessTokenSilently, isAuthenticated, loginWithRedirect, user } = useAuth0();
  const { busy, error, run } = useTripWrite();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [adding, setAdding] = useState(false);

  const canEdit = useCanEdit();
  const isOwner = trip.myRole === "owner";
  const hasPlaceholders = trip.crew.some((p) => !p.claimed);
  // A follower watches the trip; the crew is who is coming. Two sections —
  // and every other trip surface (overview, practicalities, booklet) renders
  // the crew only, with followers behind a count (#315).
  const { members, followers } = splitCrew(trip.crew);
  // Only an owner who opened the panel triggers the follow-list read.
  const { people, loading } = useFollowing(user?.sub, isOwner && adding);

  const saveMember = async (person: Person, patch: { note?: string | null; role?: Role }) => {
    setEditingId(null);
    await run(
      (token) => patchCrewMember(trip.id, person.id, patch, token),
      (t) => withCrewMember(t, person.id, patch),
    );
  };

  const addMember = async (body: AddCrewMemberBody): Promise<boolean> => {
    // Optimistic row — the canonical doc replaces it on success. An account
    // add carries the real sub, so the row is already the right identity and
    // renders as claimed (profile link included) before the round trip lands.
    const temp: Person = {
      id: body.sub ?? `pending-${body.name}`,
      name: body.name,
      role: body.role,
      ...(body.note ? { note: body.note } : {}),
      ...(body.contact ? { contact: body.contact } : {}),
      claimed: Boolean(body.sub),
    };
    const doc = await run(
      (token) => addCrewMember(trip.id, body, token),
      (t) => withAddedCrew(t, temp),
    );
    return doc !== null;
  };

  const removeMember = async (person: Person) => {
    setConfirmRemoveId(null);
    await run(
      (token) => removeCrewMember(trip.id, person.id, token),
      (t) => withRemovedCrew(t, person.id),
    );
  };

  /** Owner-only remove control per row. Never on the owner row (the trip
   *  must not go ownerless). A follower row is revocable only on a private
   *  trip — on a public trip the link alone grants read access, so revoking
   *  is not offered (the API stays unchanged). */
  const canRemove = (p: Person): boolean => {
    if (!isOwner || p.role === "owner") return false;
    if (p.role === "follower" && trip.visibility !== "private") return false;
    return true;
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

  /** Add affordance (editor+) — the trigger stays in the title row, but the
   *  PANEL it opens renders below the title at the crew cards' full width
   *  (a form squeezed next to the title next to "Copy invite link" read as
   *  chrome, not as part of the page). */
  const addButton = canEdit && !adding && (
    <Button
      variant="outline"
      size="sm"
      className="whitespace-nowrap"
      onClick={() => setAdding(true)}
      disabled={busy}
    >
      <UserPlus className="h-3.5 w-3.5" /> Add crew member
    </Button>
  );
  const addPanel = canEdit && adding && (
    <AddCrewPanel
      busy={busy}
      isOwner={isOwner}
      following={people}
      crewIds={trip.crew.map((p) => p.id)}
      loadingFollowing={loading}
      onAdd={addMember}
      onClose={() => setAdding(false)}
    />
  );

  /** One member card. The follower rows are the SAME card with the role badge
   *  suppressed — the section heading already says what they are. */
  const personRow = (p: Person, opts?: { showRole?: boolean }) => {
    const showRole = opts?.showRole ?? true;
    return (
      <Card key={p.id} className="p-4">
        <div className="flex items-center gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
            {initials(p.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {p.claimed ? (
                <Link
                  to={`/u/${encodeURIComponent(p.id)}`}
                  className="font-semibold text-primary underline underline-offset-2 focus-visible:focus-ring"
                >
                  {p.name}
                </Link>
              ) : (
                <p className="font-semibold">{p.name}</p>
              )}
              {showRole && (
                <Badge variant={p.role === "owner" ? "default" : "outline"}>
                  {ROLE_LABELS[p.role]}
                </Badge>
              )}
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
            {p.role === "follower" && isOwner && (
              <p className="mt-1 text-xs text-muted-foreground">
                Promote to Viewer or Editor to grant crew access — no need to claim anything.
              </p>
            )}
            {p.role === "follower" && !canRemove(p) && isOwner && (
              <p className="mt-1 text-xs text-muted-foreground">
                This trip is public, so it stays readable by anyone holding the link —
                removing this follower is not offered.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
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
            {canEdit && canRemove(p) && (
              <button
                type="button"
                className="no-print inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-destructive focus-visible:focus-ring disabled:opacity-40"
                disabled={busy}
                onClick={() => setConfirmRemoveId(confirmRemoveId === p.id ? null : p.id)}
                aria-label={`Remove ${p.name} from the crew`}
                title="Remove from crew"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
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
        {confirmRemoveId === p.id && (
          <div className="mt-3 rounded-xl border border-border bg-muted/40 p-3">
            <p className="text-sm">
              Remove {p.name} from this trip's crew?{" "}
              {p.claimed === true
                ? "They keep their account — only this trip's crew entry goes."
                : "Their placeholder entry is deleted."}{" "}
              This can't be undone.
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemoveId(null)} disabled={busy}>
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => void removeMember(p)}
                disabled={busy}
                aria-label={`Confirm removing ${p.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </div>
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      {/* The title row wraps as ONE unit: on a phone the actions drop to their
       *  own line instead of breaking their labels mid-word. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Crew</h1>
        <div className="flex flex-wrap items-center gap-2">
          {addButton}
          {canEdit && isOwner && hasPlaceholders && (
            <Button
              variant="outline"
              size="sm"
              className="whitespace-nowrap"
              onClick={() => void copyInviteLink()}
              disabled={busy}
            >
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
      </div>
      {addPanel}
      {members.length ? (
        members.map((p) => personRow(p))
      ) : (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          Crew not announced yet.
        </p>
      )}
      {/* Followers are a section of their own — they watch the trip, they are
          not on the crew. The anchor is what the trip surfaces link to. */}
      {followers.length > 0 && (
        <section id="followers" className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="kicker">Followers</h2>
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {followers.length}
            </span>
          </div>
          {followers.map((p) => personRow(p, { showRole: false }))}
        </section>
      )}
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
