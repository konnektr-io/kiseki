import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { EllipsisVertical, FileDown, Pencil, Settings } from "lucide-react";
import { useTripState } from "./theme";
import { useEditMode } from "./edit-mode";
import { roleAtLeast } from "../lib/editing";

/**
 * Trip header actions — ONE overflow menu in the top-right corner so the
 * header stays a single row (issue #46 follow-up). Since #248 it holds only
 * what is per-visit or per-app:
 *
 *   everyone      → Booklet PDF
 *   editor+       → Edit mode toggle (reading/editor split — the surfaces
 *                   read clean until an editor opts into the pencils,
 *                   ghost buttons and block chrome for this trip)
 *   editor+       → Trip settings  →  /t/<id>/settings
 *
 * Everything that configures the TRIP (stage, theme, sharing, the crew invite
 * links, the TriCount connection, delete) moved to that page — the menu had
 * grown into a scrolling panel of eight unrelated rows, most of them settings.
 * The settings row is a LINK, not an action: the page is the single home for
 * trip-level settings, and hiding the row for a viewer/follower is
 * presentation only — the page and the server both gate on the same editor+
 * rule. (The settings page itself stays ungated: it IS the edit home, reached
 * explicitly — edit mode only quiets the surfaces that are read first.)
 */
export function TripActionsMenu({
  pdfBusy = false,
  onDownloadPdf,
}: {
  pdfBusy?: boolean;
  onDownloadPdf: () => void;
}) {
  const { trip } = useTripState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const canEdit = roleAtLeast(trip.myRole, "editor");
  const { editMode, setEditMode } = useEditMode();

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

  const item =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50";

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
          className="absolute right-0 top-full z-30 mt-1.5 w-56 rounded-xl border border-border bg-card p-1.5 shadow-lg"
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

          {/* Edit mode — editor+ (reading/editor split: the surfaces read
              clean until an editor opts into the chrome for this trip) */}
          {canEdit && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={editMode}
              className={item}
              onClick={() => setEditMode(!editMode)}
            >
              <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>Edit mode</span>
              <span className="ml-auto text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {editMode ? "On" : "Off"}
              </span>
            </button>
          )}

          {/* Trip settings — editor+ (the page's own gate is the same rule) */}
          {canEdit && (
            <Link
              to={`/t/${trip.id}/settings`}
              role="menuitem"
              className={item}
              onClick={() => setOpen(false)}
            >
              <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>Trip settings</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
