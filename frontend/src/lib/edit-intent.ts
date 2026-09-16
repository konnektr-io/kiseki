import { capture } from "./posthog";

/**
 * Edit-intent log (#296, phase 3) — which manual editor to build NEXT,
 * measured instead of guessed.
 *
 * The record is deliberately minimal: the event name plus the ENTITY type and
 * FIELD names the user asked about (`day` + `["title","notes"]`). Field
 * VALUES never leave the composer (they ride the chat message the user sends,
 * not this event), so there is no trip content to scrub, store or leak — the
 * analytics-privacy scrubber has nothing to find here by construction.
 *
 * Turn success/failure is NOT recorded: the outcome settles in the relay's
 * attach flow (`chatOutage`/`onTurnComplete`) with no per-entity attribution,
 * and joining the two would be new tracking plumbing — explicitly out of
 * scope per the issue ("only if free"). Request frequency alone answers the
 * phase-3 question (which editor is asked for most).
 */
export function logEditIntent(entity: string, fields: string[]): void {
  capture("agent_edit_requested", { entity, fields });
}
