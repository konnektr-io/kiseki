import { useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import {
  EllipsisVertical,
  FileDown,
  Globe,
  Link2,
  Lock,
  Trash2,
} from "lucide-react";
import { useTripState } from "./theme";
import { useTripWrite } from "../lib/useTripWrite";
import { deleteTrip, putTrip, TripAccessError } from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { isPostHogConfigured, posthog } from "../lib/posthog";
import {
  roleAtLeast,
  stageOptions,
  STAGES,
  withTripStage,
  withTripVisibility,
} from "../lib/editing";
import type { Stage, Visibility } from "../lib/types";

/**
 * Trip header actions — ONE overflow menu in the top-right corner so the
 * header stays a single row (issue #46 follow-up). Contents are role-gated:
 *
 *   everyone      → Booklet PDF
 *   owner         → Copy crew join link · Sharing (public/private) · Delete trip
 *   editor+       → Stage (owner: any move; editor: forward minus archive)
 *
 * The server is always the enforcement point — the menu only gates what is
 * offered. Viewer/follower/anonymous see a single-item (PDF) menu, which is
 * exactly the previous PDF button, just tucked away.
 */
export function TripActionsMenu({
  pdfBusy = false,
  onDownloadPdf,
  joinCopied = false,
  onCopyJoinLink,
  onDeleted,
}: {
  pdfBusy?: boolean;
  onDownloadPdf: () => void;
  joinCopied?: boolean;
  /** Present when the caller can offer it (owner) — row is hidden otherwise. */
  onCopyJoinLink?: () => void;
  /** Owner-only: called after DELETE /api/trips/{id} succeeds (204) — the
   *  trip is gone, the caller navigates away (landing). */
  onDeleted?: () => void;
}) {
  const { trip } = useTripState();
  const { busy, error, run } = useTripWrite();
  const { getAccessTokenSilently } = useAuth0();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Delete is a two-step arm→confirm INSIDE the menu (same arm pattern as
  // block-edit): first click arms (3s timeout de-arms), second click fires
  // the irreversible owner-only DELETE. No dialog — the menu is the dialog.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isOwner = trip.myRole === "owner";
  const canEdit = roleAtLeast(trip.myRole, "editor");

  // Close on outside click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A closed menu never keeps an armed destructive control: reopen shows the
  // plain "Delete trip…" row again, and the confirm button can't outlive the
  // menu it lives in (the 3s auto-de-arm only covers the menu staying open).
  useEffect(() => {
    if (!open) {
      setDeleteArmed(false);
      setDeleteError(null);
    }
  }, [open]);

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

  // Owner-only, irreversible (#163): DELETE /api/trips/{id} takes the whole
  // trip with it. On 204 there is no document left — `onDeleted` sends the
  // caller away (landing). A 403 here means the resolved actor lost the
  // owner role meanwhile; anything else surfaces as a menu-line error.
  const removeTrip = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const token = await getAccessTokenSilently();
      await deleteTrip(trip.id, token);
      onDeleted?.();
    } catch (e) {
      if (isSessionExpiredError(e)) {
        setDeleteError("Session expired — sign in again.");
      } else if (e instanceof TripAccessError && e.status === 403) {
        setDeleteError("Only the trip owner can delete this trip.");
      } else if (e instanceof TripAccessError && e.status === 404) {
        // Already gone (another window beat us to it) — the goal is met;
        // navigate away exactly like a success.
        onDeleted?.();
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

  const item =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50";
  const menuLabel =
    "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
  const control =
    "h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:focus-ring disabled:opacity-50";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Trip actions"
        title="Trip actions"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground focus-visible:focus-ring"
      >
        <EllipsisVertical className="h-4 w-4" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Trip actions"
          className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-xl border border-border bg-card p-1.5 shadow-lg"
        >
          {/* Booklet PDF — everyone */}
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={pdfBusy}
            onClick={() => {
              onDownloadPdf();
              setOpen(false);
            }}
          >
            <FileDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span aria-live="polite">{pdfBusy ? "Preparing booklet…" : "Download booklet PDF"}</span>
          </button>

          {onCopyJoinLink && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={onCopyJoinLink}
              // stays open so the "copied" feedback is visible
            >
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className={joinCopied ? "text-accent" : ""}>
                {joinCopied ? "Join link copied" : "Copy crew join link"}
              </span>
            </button>
          )}

          {canEdit && (
            <>
              <div className="mx-1.5 my-1 h-px bg-border" role="separator" />
              <div className="px-1.5 pb-1">
                {options.length > 0 && (
                  <label className="mb-1.5 block">
                    <span className={menuLabel}>Stage</span>
                    <select
                      value={trip.stage}
                      disabled={busy}
                      onChange={(e) => changeStage(e.target.value as Stage)}
                      className={control}
                      aria-label="Trip stage"
                    >
                      {STAGES.map((s, i) => (
                        <option
                          key={s}
                          value={s}
                          disabled={i === currentIdx || !options.includes(s)}
                        >
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {isOwner && (
                  <div>
                    <span className={menuLabel}>Sharing</span>
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
                        className={`flex flex-1 items-center justify-center gap-1.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
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
                        className={`flex flex-1 items-center justify-center gap-1.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                          trip.visibility === "private"
                            ? "bg-primary text-primary-foreground"
                            : "bg-card text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <Lock className="h-3.5 w-3.5" aria-hidden /> Private
                      </button>
                    </div>
                  </div>
                )}
                {error && (
                  <p role="alert" className="pt-1.5 text-xs font-medium text-destructive">
                    {error}
                  </p>
                )}
              </div>
            </>
          )}

          {/* Delete trip — owner-only, terminal (#163). Two-step arm→confirm
              inside the menu: the first click arms (with the trip title and
              the irreversibility warning), the second click — within 3s —
              fires the DELETE. The armed row carries its own de-arm (×) so a
              misclick can always be walked back without waiting. */}
          {isOwner && onDeleted && (
            <>
              <div className="mx-1.5 my-1 h-px bg-border" role="separator" />
              {deleteArmed ? (
                <div className="px-1.5 pb-1.5">
                  <p className="mb-1.5 text-xs leading-snug text-foreground">
                    Delete <span className="font-semibold">{trip.title}</span> and
                    everything in it — days, sections, blocks and the crew list?
                    <span className="font-medium text-destructive"> This cannot be undone.</span>
                  </p>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      role="menuitem"
                      disabled={deleteBusy}
                      onClick={() => void removeTrip()}
                      aria-label={`Permanently delete ${trip.title}`}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-destructive px-2 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors hover:opacity-90 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {deleteBusy ? "Deleting…" : "Delete trip"}
                    </button>
                    <button
                      type="button"
                      disabled={deleteBusy}
                      onClick={() => setDeleteArmed(false)}
                      aria-label="Cancel delete"
                      className="rounded-md border border-border px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
                    >
                      Cancel
                    </button>
                  </div>
                  {deleteError && (
                    <p role="alert" className="pt-1.5 text-xs font-medium text-destructive">
                      {deleteError}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-muted focus-visible:focus-ring"
                  onClick={() => {
                    setDeleteArmed(true);
                    // Auto-de-arm: an armed destructive control must not sit
                    // waiting in a menu the user opened minutes ago.
                    window.setTimeout(() => setDeleteArmed(false), 3000);
                  }}
                >
                  <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                  <span>Delete trip…</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
