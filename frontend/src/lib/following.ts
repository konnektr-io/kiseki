import { useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { fetchUserFollowing } from "./api";
import type { ProfilePerson } from "./types";

/**
 * The people the viewer follows (#196) — the Crew page's "add someone you
 * already follow" source (#198 follow-up).
 *
 * `enabled` gates the fetch: the Crew page passes `owner && the add panel is
 * open`, so a visitor never triggers a profile read they have no use for.
 * A failed fetch yields an empty list and is swallowed on purpose — the
 * manual placeholder path must keep working when the follow graph is
 * unreachable, and an empty picker is exactly the pre-existing behaviour.
 *
 * `getAccessTokenSilently` is read through a ref: the hook gets a fresh
 * identity on route transitions (pitfall #20 in the kiseki skill), and a
 * re-fetch loop here would fire a profile read on every render.
 */
export function useFollowing(
  sub: string | undefined,
  enabled: boolean,
): { people: ProfilePerson[]; loading: boolean } {
  const { getAccessTokenSilently } = useAuth0();
  const tokenGetter = useRef(getAccessTokenSilently);
  tokenGetter.current = getAccessTokenSilently;
  const [people, setPeople] = useState<ProfilePerson[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !sub) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const accessToken = await tokenGetter.current();
        const list = await fetchUserFollowing(sub, accessToken);
        if (!cancelled) setPeople(list.people ?? []);
      } catch {
        if (!cancelled) setPeople([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sub, enabled]);

  return { people, loading };
}
