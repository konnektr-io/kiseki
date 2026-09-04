import { useEffect, useRef, useState } from "react";
import {
  EllipsisVertical,
  FileDown,
  Globe,
  Link2,
  Lock,
} from "lucide-react";
import { useTripState } from "./theme";
import { useTripWrite } from "../lib/useTripWrite";
import { putTrip } from "../lib/api";
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
 *   owner         → Copy crew join link · Sharing (public/private)
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
}: {
  pdfBusy?: boolean;
  onDownloadPdf: () => void;
  joinCopied?: boolean;
  /** Present when the caller can offer it (owner) — row is hidden otherwise. */
  onCopyJoinLink?: () => void;
}) {
  const { trip } = useTripState();
  const { busy, error, run } = useTripWrite();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const changeStage = (stage: Stage) => {
    void run(
      (token) => putTrip(trip.id, { stage }, token),
      (t) => withTripStage(t, stage),
    );
  };
  const changeVisibility = (visibility: Visibility) => {
    void run(
      (token) => putTrip(trip.id, { visibility }, token),
      (t) => withTripVisibility(t, visibility),
    );
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
        </div>
      )}
    </div>
  );
}
