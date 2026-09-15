import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import {
  ArrowRight,
  Check,
  Compass,
  ExternalLink,
  Globe,
  Link2,
  Lock,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { useTripState } from "../components/theme";
import { Card, STAGE_LABELS } from "../components/ui";
import {
  clearTripCache,
  connectTricount,
  createFollowLink,
  deleteTrip,
  disableCrewInvite,
  fetchFollowLink,
  fetchJoinLink,
  putTrip,
  TripAccessError,
} from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { isPostHogConfigured, posthog } from "../lib/posthog";
import {
  roleAtLeast,
  stageOptions,
  STAGES,
  withTripDiscoverable,
  withTripStage,
  withTripTheme,
  withTripVisibility,
} from "../lib/editing";
import { DEFAULT_PRESET_ID, PRESET_IDS, presetById } from "../lib/theme-presets";
import { useTripWrite } from "../lib/useTripWrite";
import type { Stage, Visibility } from "../lib/types";

/**
 * Trip settings (#248) — the trip-level actions that used to be crammed into
 * the header's overflow menu have a page of their own now: stage, theme,
 * sharing, the crew invite links, the TriCount connection and the destructive
 * delete, each with room to say what it does.
 *
 * Why a page: the overflow menu existed to keep the header to a single row
 * (#231), and it had grown into a scrolling panel of eight unrelated things —
 * a per-visit action (the booklet) next to a two-step delete next to the stage
 * switch. The menu now keeps what is per-visit and points here.
 *
 * Gating is editor+: every row on this page is editor+ or an owner-only
 * section, so a viewer/follower has nothing to read. Hiding a control is
 * presentation only — the server stays the enforcement point for every write
 * made from here, and nothing on this page claims the client is the gate.
 */
export function SettingsPage() {
  const { trip, apply } = useTripState();
  const navigate = useNavigate();
  const { getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const { busy, error, run } = useTripWrite();

  const [joinCopied, setJoinCopied] = useState(false);
  const [followCopied, setFollowCopied] = useState(false);
  const [inviteOff, setInviteOff] = useState(false);
  // #231 — TriCount link. Local busy/error: `busy`/`error` from useTripWrite
  // belong to the stage/theme/sharing writes above, and a failed connect has to
  // say so next to the field that caused it.
  const [tricountKey, setTricountKey] = useState("");
  const [tricountBusy, setTricountBusy] = useState(false);
  const [tricountError, setTricountError] = useState<string | null>(null);
  // Delete is a two-step arm→confirm (same pattern as the menu it moved out
  // of): the first click arms (3s timeout de-arms), the second click fires the
  // irreversible owner-only DELETE.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isOwner = trip.myRole === "owner";
  const canEdit = roleAtLeast(trip.myRole, "editor");

  const changeStage = (stage: Stage) => {
    if (isPostHogConfigured) {
      posthog.capture("trip_stage_changed", { from_stage: trip.stage, to_stage: stage });
    }
    void run(
      (token) => putTrip(trip.id, { stage }, token),
      (t) => withTripStage(t, stage),
    );
  };

  const changeVisibility = (visibility: Visibility) => {
    if (isPostHogConfigured) {
      posthog.capture("trip_visibility_changed", {
        from_visibility: trip.visibility,
        to_visibility: visibility,
      });
    }
    void run(
      (token) => putTrip(trip.id, { visibility }, token),
      (t) => withTripVisibility(t, visibility),
    );
  };

  const changeDiscoverable = (discoverable: boolean) => {
    if (isPostHogConfigured) {
      posthog.capture("trip_discoverable_changed", { discoverable });
    }
    void run(
      (token) => putTrip(trip.id, { discoverable }, token),
      (t) => withTripDiscoverable(t, discoverable),
    );
  };

  const changeTheme = (preset: string) => {
    if (isPostHogConfigured) {
      posthog.capture("trip_theme_changed", { from_preset: trip.theme?.preset, to_preset: preset });
    }
    void run(
      (token) => putTrip(trip.id, { theme: { preset } }, token),
      (t) => withTripTheme(t, preset),
    );
  };

  const copyJoinLink = async () => {
    try {
      const at = await getAccessTokenSilently();
      const joinUrl = await fetchJoinLink(trip.id, at);
      await navigator.clipboard.writeText(window.location.origin + joinUrl);
      setJoinCopied(true);
      window.setTimeout(() => setJoinCopied(false), 2000);
    } catch (e) {
      // Owner-only action: a session that can no longer be renewed must not
      // fail silently — this button is the only way to reach the join link.
      if (isSessionExpiredError(e)) {
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      setJoinCopied(false);
    }
  };

  const copyFollowLink = async () => {
    try {
      const at = await getAccessTokenSilently();
      // Mint on first use, reuse after that: the link stays stable for the
      // people already holding it. Rotating is a deliberate act (#197), never
      // a side effect of copying.
      const existing = await fetchFollowLink(trip.id, at);
      const followUrl = existing ?? (await createFollowLink(trip.id, at));
      await navigator.clipboard.writeText(window.location.origin + followUrl);
      setFollowCopied(true);
      window.setTimeout(() => setFollowCopied(false), 2000);
    } catch (e) {
      if (isSessionExpiredError(e)) {
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      setFollowCopied(false);
    }
  };

  const turnOffInvite = async () => {
    try {
      const at = await getAccessTokenSilently();
      await disableCrewInvite(trip.id, at);
      setInviteOff(true);
    } catch (e) {
      // Owner-only action: a dead session must not fail silently.
      if (isSessionExpiredError(e)) {
        loginWithRedirect({ appState: { returnTo: window.location.pathname } });
      }
    }
  };

  // Owner-only TriCount link (#231). Success lands the canonical doc in the
  // trip context, so `practical.tricount` goes truthy here and on the
  // practical page's connected panel — nothing to reload.
  const connectTriCount = async () => {
    const registryKey = tricountKey.trim();
    if (!registryKey) return;
    setTricountBusy(true);
    setTricountError(null);
    if (isPostHogConfigured) posthog.capture("tricount_connected");
    try {
      const token = await getAccessTokenSilently();
      apply(await connectTricount(trip.id, registryKey, token));
      setTricountKey("");
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setTricountError("Session expired — sign in again.");
      } else if (e instanceof TripAccessError && e.status === 403) {
        setTricountError("Only the trip owner can link a Tricount.");
      } else {
        setTricountError(e instanceof Error ? e.message : "Couldn't link that Tricount.");
      }
    } finally {
      setTricountBusy(false);
    }
  };

  // Owner-only, irreversible (#163): DELETE /api/trips/{id} takes the whole
  // trip with it. On 204 there is no document left — clear the session cache
  // the layout fetched into and leave for the landing. A 403 means the
  // resolved actor lost the owner role meanwhile; 404 means another window
  // already deleted it (the goal is met — navigate exactly like a success).
  const removeTrip = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const token = await getAccessTokenSilently();
      await deleteTrip(trip.id, token);
      clearTripCache();
      navigate("/");
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setDeleteError("Session expired — sign in again.");
      } else if (e instanceof TripAccessError && e.status === 403) {
        setDeleteError("Only the trip owner can delete this trip.");
      } else if (e instanceof TripAccessError && e.status === 404) {
        clearTripCache();
        navigate("/");
      } else {
        setDeleteError(e instanceof Error ? e.message : "Couldn't delete the trip.");
      }
    } finally {
      setDeleteBusy(false);
      setDeleteArmed(false);
    }
  };

  const options = stageOptions(trip.stage, trip.myRole);
  const currentIdx = STAGES.indexOf(trip.stage);
  const currentPreset = trip.theme?.preset ?? DEFAULT_PRESET_ID;

  // Past this point nothing renders for a viewer/follower — every row is
  // editor+ or owner-only, and there is nothing here for them to read.
  if (!canEdit) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          Trip settings are for this trip's editors.
        </p>
        <Link
          to={`/t/${trip.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowRight className="h-3.5 w-3.5 rotate-180" aria-hidden /> Back to the trip
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Trip-level settings for <span className="font-medium">{trip.title}</span>.
        </p>
      </div>

      <Section
        title="Trip identity"
        hint="Stage drives the app's own view of the trip (the header badge, the live-day surface, the itinerary's emphasis)."
      >
        {options.length > 0 && (
          <div>
            <label className={labelCls} htmlFor="settings-stage">
              Stage
            </label>
            <select
              id="settings-stage"
              value={trip.stage}
              disabled={busy}
              onChange={(e) => changeStage(e.target.value as Stage)}
              className={inputCls}
            >
              {STAGES.map((s, i) => (
                <option key={s} value={s} disabled={i === currentIdx || !options.includes(s)}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Editors move a trip forward, one step at a time; the owner can move it anywhere,
              archive included.
            </p>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="settings-theme">
            Theme
          </label>
          <select
            id="settings-theme"
            value={currentPreset}
            disabled={busy}
            onChange={(e) => changeTheme(e.target.value)}
            className={inputCls}
          >
            {PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {id.charAt(0).toUpperCase() + id.slice(1)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{presetById(currentPreset).blurb}</p>
        </div>
        {error && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {error}
          </p>
        )}
      </Section>

      {/* Sharing is an owner decision — `visibility` and `discoverable` are
          owner-only fields on the trip write route, exactly as the menu
          treated them. */}
      {isOwner && (
        <Section
          title="Sharing"
          hint="Who can read this trip at all, and whether it can be found without a link."
        >
          <div>
            <span className={labelCls}>Visibility</span>
            <div
              className="flex overflow-hidden rounded-md border border-border"
              role="group"
              aria-label="Trip visibility"
            >
              <button
                type="button"
                disabled={busy}
                aria-pressed={trip.visibility === "public"}
                onClick={() => changeVisibility("public")}
                className={`flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
                  trip.visibility === "public"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <Globe className="h-3.5 w-3.5" aria-hidden /> Public
              </button>
              <button
                type="button"
                disabled={busy}
                aria-pressed={trip.visibility === "private"}
                onClick={() => changeVisibility("private")}
                className={`flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
                  trip.visibility === "private"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <Lock className="h-3.5 w-3.5" aria-hidden /> Private
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              A public trip is readable by anyone holding the link; a private one only by its crew.
            </p>
          </div>

          {/* #196: being LISTED is a second, independent decision from being
              readable — discoverable is what puts a public trip in the
              discovery list and on profiles. */}
          <label className="flex cursor-pointer items-start gap-2.5" htmlFor="settings-discoverable">
            <input
              id="settings-discoverable"
              type="checkbox"
              checked={Boolean(trip.discoverable)}
              disabled={busy}
              onChange={(e) => changeDiscoverable(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border focus-visible:focus-ring"
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Compass className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> List in
                discovery
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Signed-in travellers can find this trip without a link. Only affects a public trip.
              </span>
            </span>
          </label>
        </Section>
      )}

      {/* Crew & invite — the join link and its revocation are owner-only (they
          hand out access); the link to the crew page is useful to editors too,
          which is why the section itself is not owner-gated. */}
      <Section
        title="Crew & invite"
        hint="Who is on this trip, and the two links that let someone in."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/t/${trip.id}/crew`} className={actionCls}>
            <Users className="h-3.5 w-3.5" aria-hidden /> Open the crew page
          </Link>
          {isOwner && (
            <>
              <button type="button" className={actionCls} onClick={() => void copyJoinLink()}>
                {joinCopied ? (
                  <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
                ) : (
                  <Link2 className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className={joinCopied ? "text-accent" : ""}>
                  {joinCopied ? "Join link copied" : "Copy crew join link"}
                </span>
              </button>
              <button
                type="button"
                className={actionCls}
                onClick={() => void turnOffInvite()}
                disabled={inviteOff}
              >
                {inviteOff ? (
                  <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
                ) : (
                  <Link2 className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className={inviteOff ? "text-accent" : ""}>
                  {inviteOff ? "Crew invite disabled" : "Disable crew invite"}
                </span>
              </button>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {isOwner ? (
            <>
              The join link makes whoever holds it a crew member; disabling it retires the link
              without touching anyone already on the trip or the follow link.
            </>
          ) : (
            <>
              Edits to the invite links are the owner's — ask them for a join link, or to change
              your role.
            </>
          )}
        </p>

        {/* #197: the two links are separate secrets with separate revokes. The
            follow link never grants a claim, so it is the one to hand to people
            who should read the trip but not join the crew. */}
        {isOwner && (
          <div className="border-t border-border pt-3">
            <button type="button" className={actionCls} onClick={() => void copyFollowLink()}>
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              <span className={followCopied ? "text-accent" : ""}>
                {followCopied ? "Follow link copied" : "Copy follow link"}
              </span>
            </button>
            <p className="mt-1 text-xs text-muted-foreground">
              Read-only, and structurally unable to claim a crew identity — for people who should
              follow the trip but not join the crew.
            </p>
          </div>
        )}
      </Section>

      {/* Integrations — owner-only, and only while this trip has nothing
          connected. A trip that doesn't use TriCount gets no connected panel
          and no empty balance sheet; just this one field (#231). Future
          integrations land in this group. */}
      {isOwner && (
        <Section title="Integrations" hint="Trip-level services this trip reads from.">
          {trip.practical.tricount ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">TriCount · connected</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Balances and recent expenses render on the practical page, where the connection
                  can also be disconnected.
                </p>
              </div>
              <Link to={`/t/${trip.id}/practical`} className={actionCls}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Practical page
              </Link>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void connectTriCount();
              }}
            >
              <label className={labelCls} htmlFor="settings-tricount">
                TriCount
              </label>
              <input
                id="settings-tricount"
                value={tricountKey}
                onChange={(e) => setTricountKey(e.target.value)}
                placeholder="tricount.com/t… or tXXXXX"
                disabled={tricountBusy}
                className={inputCls}
              />
              <button
                type="submit"
                disabled={tricountBusy || !tricountKey.trim()}
                className={`${actionCls} mt-2`}
              >
                <Wallet className="h-3.5 w-3.5" aria-hidden />
                {tricountBusy ? "Linking…" : "Link TriCount"}
              </button>
              <p className="mt-1 text-xs text-muted-foreground">
                Paste the sharing link of the trip's expense pot to show balances and recent
                expenses on this trip's practical page.
              </p>
            </form>
          )}
          {tricountError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {tricountError}
            </p>
          )}
        </Section>
      )}

      {/* Danger zone — owner-only, terminal (#163). Two-step arm→confirm with a
          3s de-arm and its own cancel, so a single stray click can never take
          the trip with it. */}
      {isOwner && (
        <Section title="Danger zone" tone="danger">
          {deleteArmed ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm leading-snug text-foreground">
                Delete <span className="font-semibold">{trip.title}</span> and everything in it —
                days, sections, blocks and the crew list?
                <span className="font-medium text-destructive"> This cannot be undone.</span>
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  disabled={deleteBusy}
                  onClick={() => void removeTrip()}
                  aria-label={`Permanently delete ${trip.title}`}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md bg-destructive px-2.5 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors hover:opacity-90 focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  {deleteBusy ? "Deleting…" : "Delete trip"}
                </button>
                <button
                  type="button"
                  disabled={deleteBusy}
                  onClick={() => setDeleteArmed(false)}
                  aria-label="Cancel delete"
                  className={actionCls}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Delete this trip</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Its days, sections, blocks and crew list go with it. Cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteArmed(true);
                  // Auto-de-arm: an armed destructive control must not sit
                  // waiting on a page the user left open.
                  window.setTimeout(() => setDeleteArmed(false), 3000);
                }}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-destructive/50 bg-card px-2.5 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 focus-visible:focus-ring"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete trip…
              </button>
            </div>
          )}
          {/* The failure line lives OUTSIDE the armed panel: a rejected delete
              de-arms (the pattern's own `finally`), and an error that vanished
              with the panel would leave the owner staring at a trip that is
              still there with no word about why. */}
          {deleteError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {deleteError}
            </p>
          )}
        </Section>
      )}

      <p className="pt-1">
        <Link
          to={`/t/${trip.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowRight className="h-3.5 w-3.5 rotate-180" aria-hidden /> Back to the trip
        </Link>
      </p>
    </div>
  );
}

const labelCls =
  "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:focus-ring disabled:opacity-50";
const actionCls =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50";

/** One settings group. The card is the unit — a page of nine bare controls
 *  reads as a form dump; grouping them says which decisions belong together. */
function Section({
  title,
  hint,
  tone = "default",
  children,
}: {
  title: string;
  hint?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <Card className={`p-5${tone === "danger" ? " border-destructive/40" : ""}`}>
      <h2 className="kicker">{title}</h2>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </Card>
  );
}
