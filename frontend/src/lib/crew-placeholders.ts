import { useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { fetchReusablePlaceholders } from "./api";
import type { ReusablePlaceholder } from "./types";

/**
 * The unclaimed placeholders the viewer may LINK into this trip (#322).
 *
 * The source for the Crew page's "already in one of your trips" picker: an
 * unregistered person added to several trips is ONE Person twin (one `hasCrew`
 * edge per trip), so linking the same one again beats minting a second twin
 * per trip — a single claim then lands them on every linked trip.
 *
 * `enabled` gates the fetch: the Crew page passes `owner && the add panel is
 * open`, so only an owner who is actually adding someone triggers the read
 * (the endpoint is owner-only anyway — a 403 here would be noise, not data).
 * A failed fetch yields an empty list and is swallowed on purpose: the manual
 * placeholder path must keep working when the graph read fails, and an empty
 * picker is exactly the pre-existing behaviour.
 *
 * `getAccessTokenSilently` is read through a ref: the hook gets a fresh
 * identity on route transitions (pitfall #20 in the kiseki skill), and a
 * re-fetch loop here would fire the read on every render.
 */
export function useReusablePlaceholders(
  tripId: string,
  enabled: boolean,
): { placeholders: ReusablePlaceholder[]; loading: boolean } {
  const { getAccessTokenSilently } = useAuth0();
  const tokenGetter = useRef(getAccessTokenSilently);
  tokenGetter.current = getAccessTokenSilently;
  const [placeholders, setPlaceholders] = useState<ReusablePlaceholder[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !tripId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const accessToken = await tokenGetter.current();
        const list = await fetchReusablePlaceholders(tripId, accessToken);
        if (!cancelled) setPlaceholders(list);
      } catch {
        if (!cancelled) setPlaceholders([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tripId, enabled]);

  return { placeholders, loading };
}
