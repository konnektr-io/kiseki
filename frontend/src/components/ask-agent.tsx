import { useAuth0 } from "@auth0/auth0-react";
import { MessageCircle } from "lucide-react";
import { useTripState } from "./theme";
import { roleAtLeast } from "../lib/editing";
import { requestAskAgent, type AskAgentContext } from "../lib/ask-agent";
import { logEditIntent } from "../lib/edit-intent";

/**
 * "Ask the agent about this" (#296, phase 2) — the bridge from any
 * day/block/section into the trip chat drawer, pre-scoped with the entity
 * context (ids + current field values) so the user stops hand-copying
 * "on day 4, the second block…".
 *
 * Gating (acceptance: anon/viewer see no chrome): editor+ AND signed in.
 * Chat itself is signed-in-only (there is no anonymous chat), and every role
 * below editor keeps the header chat button for general questions — this
 * button is the EDITORS' shortcut into an edit conversation, matching the
 * phase-1 edit chrome it sits beside. The server stays the enforcement point
 * for anything the agent then writes.
 */
export function AskAgentButton({
  context,
  variant = "icon",
}: {
  /** Pre-built by `dayAskContext` / `sectionAskContext` / `blockAskContext`
   *  (null when the entity is missing — renders nothing). */
  context: AskAgentContext | null;
  /** "icon": a 44px round button for tight rows (block chrome, section bar).
   *  "full": a labelled button for roomy headers (day level). */
  variant?: "icon" | "full";
}) {
  const { trip } = useTripState();
  const { isAuthenticated } = useAuth0();
  if (!context) return null;
  if (!isAuthenticated || !roleAtLeast(trip.myRole, "editor")) return null;

  const label = `Ask the agent about ${context.label}`;
  const onClick = () => {
    // Phase-3 intent signal FIRST (entity + field names only — never the
    // draft values), then the bridge itself. `capture` is consent-gated and a
    // no-op without PostHog, so this never blocks the drawer.
    logEditIntent(context.entity, context.fields);
    requestAskAgent(context);
  };

  if (variant === "full") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="no-print inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:focus-ring"
      >
        <MessageCircle className="h-3.5 w-3.5" aria-hidden />
        Ask agent about this
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="no-print inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
    >
      <MessageCircle className="h-4 w-4" aria-hidden />
    </button>
  );
}
