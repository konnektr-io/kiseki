import { putTrip } from "./api";
import { isPastTrip } from "./dates";
import type { Trip } from "./types";

/**
 * Persist the calendar's auto-archive (#396) — the write-back half of the
 * derived stage.
 *
 * `effectiveStage` fixes what a trip READS as, but `stage` is also what
 * followers' feed entries, the stage facet and the owner's Settings stage
 * machine key off. A finished trip whose stored stage is still `live` keeps
 * announcing itself as live everywhere the derivation doesn't reach, so the
 * derived `archive` gets written once, on first load, by the owner.
 *
 * Three rules, all load-bearing:
 *
 * 1. **Owner-only.** `_validate_stage` in `write.py` gates `archive` to the
 *    owner, and rightly: archiving is the one transition that shelves a trip.
 *    A viewer or follower opening a finished trip must never mutate it, so
 *    this is a no-op below `myRole === "owner"` rather than a 403 the page
 *    then has to swallow.
 * 2. **One-directional.** Only `live`/`planned`/`booked` → `archive` is
 *    written. It never writes the auto-live promotion and never writes a
 *    demotion, so a deliberate manual change (moving a trip back to `booked`
 *    to keep editing it) is never reverted by this — the #362 acceptance
 *    criterion "a manual demote is not re-flipped" holds by construction,
 *    because the only thing this does is finish a trip.
 * 3. **Idempotent and fire-and-forget.** `isPastTrip` gates the write, so a
 *    second load of the same trip sends nothing. The promise is deliberately
 *    not awaited by callers: a failed reconcile must never break navigation,
 *    and the derived `effectiveStage` already renders correctly without it.
 */

/** The stages a reconcile is allowed to retire. Mirrors
 *  `_AUTO_ARCHIVE_FROM` in `backend/app/stage.py`. */
const RETIRABLE: readonly Trip["stage"][] = ["live", "planned", "booked"];

/** True when this trip is finished, auto-archiveable and awaiting the write. */
export function archiveReconcilePending(trip: Trip): boolean {
  if (trip.myRole !== "owner") return false;
  if (!RETIRABLE.includes(trip.stage)) return false;
  // The server's own verdict wins when present: it already applied the
  // trip-local timezone, and a `true` here with `stage === "archive"` stored
  // means the write landed and this is a stale in-memory document.
  if (trip.effectiveStage && trip.effectiveStage !== "archive") return false;
  return isPastTrip(trip);
}

/**
 * Write the derived `archive` if it is due. Returns the canonical document
 * when it wrote (so the caller can re-render from it) and `null` when it did
 * nothing — not due, or the write failed.
 */
export async function reconcileArchivedStage(
  trip: Trip,
  accessToken: string,
): Promise<Trip | null> {
  if (!archiveReconcilePending(trip)) return null;
  try {
    return await putTrip(trip.id, { stage: "archive" }, accessToken);
  } catch {
    // A reconcile is housekeeping, never a blocker: the derived stage already
    // renders the trip correctly, so a failure here costs a follow-feed entry
    // and the stored stage, both of which the next load retries. Swallowing
    // keeps a 403/timeout/500 from blanking a trip page.
    return null;
  }
}
