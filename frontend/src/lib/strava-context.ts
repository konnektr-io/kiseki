/**
 * The traveller's Strava rows, attached to the turn about to be sent (#459).
 *
 * Why this exists at all: the content agent can date and describe a day only
 * if it knows WHICH day a ride happened on, and the Strava credential is an
 * HttpOnly cookie scoped to `/api/integrations/strava` — the relay never sees
 * it, and `/api/chat` is not even inside its path. So the browser, which does
 * hold it, fetches the rows itself (the same call the import dialog makes) and
 * hands the RESULT to the turn. No token leaves the cookie, nothing is stored
 * server-side, and the agent receives data instead of a credential.
 *
 * The cost, stated plainly: this only works while a person is in the chat with
 * a connected browser. There is no scheduled or headless read — no credential
 * exists to make one with, and that trade was accepted (#459).
 *
 * Read at SEND time, like `deviceLocationForChat()`: the rows describe the turn
 * being submitted, not the composer that is still open. They stay attached
 * until the traveller removes the chip, so turn 2 of the same trip still has
 * them (the instructions are rebuilt per turn, so nothing is remembered
 * otherwise).
 */

import type { StravaActivity } from "./api";

/** One row as the wire wants it (`chat.StravaActivityContext`). */
export interface StravaContextRow {
  id: number;
  local_date: string;
  name?: string | null;
  sport_type?: string | null;
  distance_m?: number | null;
  moving_time_s?: number | null;
  elevation_gain_m?: number | null;
  start?: { lat: number; lng: number } | null;
  has_track?: boolean;
}

interface Attached {
  tripId: string;
  rows: StravaContextRow[];
}

let attached: Attached | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Attach these rows to every turn of this trip until they are cleared.
 *
 * Trip-scoped on purpose: the rows came from that trip's own window, so a chip
 * that survived a trip switch would hand one trip's rides to another.
 */
export function attachStravaContext(tripId: string, rows: StravaContextRow[]): void {
  attached = rows.length ? { tripId, rows } : null;
  emit();
}

/** Drop the attachment (the chip's ×, or leaving the trip). */
export function clearStravaContext(tripId?: string): void {
  if (tripId && attached && attached.tripId !== tripId) return;
  if (attached === null) return;
  attached = null;
  emit();
}

/** The rows for this trip's next turn, or null. */
export function stravaContextForChat(tripId: string | undefined): StravaContextRow[] | null {
  if (!tripId || attached === null) return null;
  if (attached.tripId !== tripId) return null;
  return attached.rows;
}

/**
 * The activity list the import dialog already fetches → the wire rows (#459).
 *
 * Only what the agent needs to date and describe a day, mapped field by field:
 * `start_latlng` becomes a bounded point, and `imported.has_track` becomes
 * `has_track` so the agent knows which rides still need the traveller's import.
 */
export function toStravaContextRows(activities: StravaActivity[]): StravaContextRow[] {
  return activities.map((activity) => {
    const latlng = activity.start_latlng;
    return {
      id: activity.id,
      local_date: activity.local_date,
      name: activity.name,
      sport_type: activity.sport_type,
      distance_m: activity.distance_m,
      moving_time_s: activity.moving_time_s,
      elevation_gain_m: activity.elevation_gain_m,
      start:
        Array.isArray(latlng) && latlng.length === 2
          ? { lat: latlng[0], lng: latlng[1] }
          : null,
      has_track: Boolean(activity.imported?.has_track),
    };
  });
}

/** What the composer chip renders: which trip, how many, still attached. */
export function stravaContextSnapshot(): Attached | null {
  return attached;
}

export function subscribeStravaContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
