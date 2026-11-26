import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

/**
 * The booklet takes ~30 s to render on the server, and the header menu that
 * starts it closes on click — so the only sign of life used to be inside a
 * menu the reader had just dismissed (Niko, 2026-11-26).
 *
 * This is that sign, outside the menu: a small status pill pinned above the
 * mobile bottom nav, with a live elapsed counter so a slow render looks like
 * work instead of a dead click. It is `role="status"` + `aria-live="polite"`
 * (not an alert): nothing failed, and a screen reader should hear it once.
 *
 * `error` lingers long enough to be read (TripLayout clears it after 8 s) and
 * says what to do — the menu row is the retry.
 */
export type BookletState = "idle" | "busy" | "error";

export function BookletProgress({ state, detail }: { state: BookletState; detail?: string }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (state !== "busy") {
      setSeconds(0);
      return;
    }
    const tick = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(tick);
  }, [state]);

  if (state === "idle") return null;

  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-[4.75rem] z-40 flex justify-center px-4 md:bottom-6">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex items-center gap-2.5 rounded-full border bg-card px-4 py-2 shadow-lg ${
          state === "error" ? "border-destructive/40" : "border-border"
        }`}
      >
        {state === "busy" ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" aria-hidden="true" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
          {state === "busy" ? "Preparing the booklet" : "The booklet could not be prepared"}
        </span>
        {state === "busy" ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">{seconds}s</span>
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              — this takes about half a minute
            </span>
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">{detail || "Try again from the menu."}</span>
        )}
      </div>
    </div>
  );
}
