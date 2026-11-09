import { useCallback, useEffect, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { Link2, PlugZap } from "lucide-react";
import { Card } from "../components/ui";
import {
  disconnectStrava,
  fetchStravaStatus,
  stravaAuthorizeUrl,
  TripAccessError,
  type StravaStatus,
} from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";

/**
 * Settings → Connections (#449): the ACCOUNT-level Strava link.
 *
 * Deliberately the only prominent surface — per-trip import lives in the trip's
 * ⋮ menu, and nothing here is per-trip. The link carries no server state: the
 * refresh token sits in one HttpOnly cookie scoped to
 * `/api/integrations/strava`, so "disconnect" really is "drop the cookie" and
 * losing it (a cleared browser, another device) costs a 30-second reconnect
 * rather than an account-level failure.
 *
 * The scope row is not decoration: a crew member who unticks `activity:read_all`
 * on Strava's consent screen still connects, but only sees activities visible
 * to Everyone/Followers — which reads as "I recorded nothing" unless we say so.
 */
export function StravaConnections() {
  const { getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const [status, setStatus] = useState<StravaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The OAuth round trip lands back on /me?strava=… — one line, then the row.
  const outcome =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("strava");

  const load = useCallback(async () => {
    try {
      const token = await getAccessTokenSilently();
      setStatus(await fetchStravaStatus(token));
    } catch (e) {
      if (isSessionExpiredError(e)) {
        void loginWithRedirect({ appState: { returnTo: window.location.pathname } });
        return;
      }
      setError(e instanceof Error ? e.message : "Couldn't read the Strava connection.");
    }
  }, [getAccessTokenSilently, loginWithRedirect]);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessTokenSilently();
      window.location.assign(await stravaAuthorizeUrl(token));
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Couldn't start the Strava connection.");
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessTokenSilently();
      await disconnectStrava(token);
      await load();
    } catch (e) {
      setError(
        e instanceof TripAccessError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Couldn't disconnect Strava.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (status && !status.configured) {
    return null; // a deployment without a Strava app has no row to show
  }

  const missingReadAll =
    status?.connected && status.scopes !== "" && !status.scopes.includes("activity:read_all");

  return (
    <Card className="mt-4 p-4 sm:p-6" aria-live="polite">
      <h2 className="kicker mb-3">Connections</h2>

      {outcome === "connected" && (
        <p className="mb-3 text-sm font-medium text-emerald-600 dark:text-emerald-400">
          Strava connected — you can import an activity from any trip's menu.
        </p>
      )}
      {outcome === "denied" && (
        <p className="mb-3 text-sm text-muted-foreground">
          Strava access was not granted. Nothing was connected.
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-primary"
          >
            <Link2 className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-medium">
              {status?.connected
                ? `Strava — connected as ${status.athlete?.name ?? "an athlete"}`
                : "Strava"}
            </p>
            <p className="text-xs text-muted-foreground">
              {status?.connected
                ? "The connection lives in this browser only; disconnecting revokes it at Strava."
                : "Import a recorded activity's track and photos onto the day it happened. Nothing is stored on our side."}
            </p>
            {missingReadAll && (
              <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                Your Strava consent excluded “Only You” activities — they will not appear in the
                import list. Reconnect and keep the activity box ticked to see them.
              </p>
            )}
          </div>
        </div>

        {status?.connected ? (
          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={busy}
            className="h-9 shrink-0 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:focus-ring disabled:opacity-60"
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy || !status}
            // 48 px tall: Strava's brand guidelines for the connect button.
            className="flex h-12 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#fc4c02] px-4 text-sm font-semibold text-white hover:brightness-95 focus-visible:focus-ring disabled:opacity-60"
          >
            <PlugZap className="h-4 w-4" aria-hidden />
            {busy ? "Opening Strava…" : "Connect with Strava"}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}
