import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "./ui";

/**
 * The ONE inline-edit control for #296 — every title/note that renders on a
 * trip page edits through this component, so the interaction (display →
 * pencil → field → save/cancel) is identical everywhere.
 *
 * Surface class: the DISPLAY is document content (it prints); every control
 * around it is chrome (`no-print`). The component never fetches and never
 * knows the write route — the call site owns the exact payload + optimistic
 * snapshot (Settings-page pattern) and hands this component an `onSave` that
 * resolves `true` when the canonical doc landed.
 *
 * Role gating is a render contract with two trees (#104 pitfall): `canEdit`
 * false renders the display with NO chrome at all (and fires no request —
 * there is nothing to click); `canEdit` true adds the pencil. Both halves are
 * asserted in `inline-edit.test.tsx`.
 */
export function InlineField({
  value,
  label,
  canEdit,
  onSave,
  renderDisplay,
  multiline = false,
  placeholder,
  emptyLabel,
  error,
  className,
}: {
  /** Current value (empty string when unset). */
  value: string;
  /** Field name for aria labels, e.g. "Day title". */
  label: string;
  /** `roleAtLeast(myRole, "editor")` from the call site. */
  canEdit: boolean;
  /** Persist the draft; `true` closes the editor, `false` keeps it open. */
  onSave: (next: string) => Promise<boolean>;
  /** Document rendering of the value (what prints). */
  renderDisplay: (value: string) => ReactNode;
  /** Textarea instead of input. */
  multiline?: boolean;
  /** Editor placeholder, e.g. "Add a subtitle". */
  placeholder?: string;
  /** Empty-state CTA for editors, e.g. "Add notes" — when set and the value
   *  is empty, an editor sees a dashed ghost button instead of pencil-less
   *  nothing. Anonymous/viewer with an empty value sees nothing at all. */
  emptyLabel?: string;
  /** Write error from the call site's `useTripWrite` (rendered under the field). */
  error?: string | null;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    // Anonymous/viewer tree: the value, or nothing when there is none.
    if (!value) return null;
    return <div className={className}>{renderDisplay(value)}</div>;
  }

  if (!editing) {
    if (!value && emptyLabel) {
      return (
        <div className={className}>
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            aria-label={`${emptyLabel} — ${label}`}
            className="no-print inline-flex min-h-11 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:focus-ring"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {emptyLabel}
          </button>
        </div>
      );
    }
    return (
      <div className={className}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">{renderDisplay(value)}</div>
          {value ? (
            <button
              type="button"
              onClick={() => {
                setDraft(value);
                setEditing(true);
              }}
              aria-label={`Edit ${label}`}
              title={`Edit ${label}`}
              className="no-print inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const unchanged = draft === value;
  const fieldId = `inline-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  const save = async () => {
    if (unchanged || saving) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const ok = await onSave(draft);
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={className}>
      <label className="no-print mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor={fieldId}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={fieldId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          placeholder={placeholder}
          disabled={saving}
          rows={3}
          autoFocus
          className="no-print min-h-20 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-relaxed text-foreground focus-visible:focus-ring disabled:opacity-50"
        />
      ) : (
        <input
          id={fieldId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          placeholder={placeholder}
          disabled={saving}
          autoFocus
          className="no-print w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:focus-ring disabled:opacity-50"
        />
      )}
      {error && (
        <p role="alert" className="no-print pt-1 text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="no-print mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            setDraft(value);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
        <Button type="button" variant="accent" size="sm" disabled={saving || unchanged} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
