import { useCallback, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { TripAccessError } from "./api";
import { useTripState } from "../components/theme";
import type { Trip } from "./types";

/** A write request: takes the session access token, returns the canonical
 *  trip document (every write endpoint does). */
export type WriteRequest = (token: string) => Promise<Trip>;

/** Map transport errors to a short human line. */
export function writeErrorMessage(e: unknown): string {
  if (e instanceof TripAccessError) {
    if (e.status === 401) return "Session expired — sign in again.";
    if (e.status === 403) return "Your role on this trip doesn't allow that change.";
    if (e.status === 404) return "That no longer exists — refreshed.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Couldn't save — check your connection.";
}

/**
 * Core optimistic-update loop, exposed standalone so TripLayout (which owns
 * the trip state itself) can reuse it without the hook.
 *
 * 1. Paint the optimistic snapshot immediately.
 * 2. Run the request.
 * 3. On success replace the snapshot with the canonical document.
 * 4. On failure roll back to the pre-write snapshot and rethrow.
 */
export async function runTripWrite(
  trip: Trip,
  apply: (t: Trip) => void,
  request: WriteRequest,
  token: string,
  optimistic?: (t: Trip) => Trip,
): Promise<Trip> {
  const prev = trip;
  if (optimistic) apply(optimistic(prev));
  try {
    const doc = await request(token);
    apply(doc);
    return doc;
  } catch (e) {
    apply(prev); // rollback
    throw e;
  }
}

/**
 * Bound version for components under TripProvider: owns busy/error state and
 * token acquisition. `run` returns null (with `error` set) on failure and the
 * canonical doc on success — call sites use the return to decide what to keep.
 */
export function useTripWrite() {
  const { trip, apply } = useTripState();
  const { isAuthenticated, getAccessTokenSilently } = useAuth0();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (request: WriteRequest, optimistic?: (t: Trip) => Trip): Promise<Trip | null> => {
      setError(null);
      if (!isAuthenticated) {
        setError("Sign in to edit this trip.");
        return null;
      }
      setBusy(true);
      try {
        const token = await getAccessTokenSilently();
        return await runTripWrite(trip, apply, request, token, optimistic);
      } catch (e) {
        setError(writeErrorMessage(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [trip, apply, isAuthenticated, getAccessTokenSilently],
  );

  return { trip, busy, error, clearError: () => setError(null), run };
}
