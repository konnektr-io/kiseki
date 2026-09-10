import { useCallback, useEffect, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { ExternalLink, RefreshCw, Wallet, X } from "lucide-react";
import { useTrip } from "../components/theme";
import { Card, Button } from "../components/ui";
import {
  fetchTricountSnapshot,
  connectTricount,
  disconnectTricount,
  TripAccessError,
} from "../lib/api";
import { roleAtLeast } from "../lib/editing";
import { useTripWrite } from "../lib/useTripWrite";
import { isPostHogConfigured, posthog } from "../lib/posthog";
import type { TricountSnapshot } from "../lib/types";

const tricountAppUrl = (key: string) => `https://tricount.com/${key}`;

const fmt = (v: number, currency: string) =>
  new Intl.NumberFormat("nl-BE", { style: "currency", currency }).format(v);

const fmtAgo = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
};

/** Crew-only TriCount panel (#111) — last expenses + balances + the live
 *  Tricount link. Rendered only when the trip has `practical.tricount` AND
 *  the viewer holds a crew role (viewer+); followers/anonymous never see it
 *  (the server enforces the same gate, this is just render honesty). */
export function TricountPanel() {
  const trip = useTrip();
  const config = trip.practical.tricount;
  const isCrew = roleAtLeast(trip.myRole, "viewer");
  const isOwner = roleAtLeast(trip.myRole, "owner");
  const { getAccessTokenSilently } = useAuth0();
  const { busy, error, run } = useTripWrite();

  const [snap, setSnap] = useState<TricountSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      if (!config) return;
      setLoading(true);
      setLoadError(null);
      try {
        const token = await getAccessTokenSilently();
        setSnap(await fetchTricountSnapshot(trip.id, token, refresh));
      } catch (e) {
        setLoadError(
          e instanceof TripAccessError && e.status === 404
            ? "This trip has no Tricount connection."
            : e instanceof Error
              ? e.message
              : "Couldn't load Tricount data.",
        );
      } finally {
        setLoading(false);
      }
    },
    [config, trip.id, getAccessTokenSilently],
  );

  useEffect(() => {
    if (config && isCrew) void load();
  }, [config, isCrew, load]);

  if (!config) {
    // Owner setup affordance only — never rendered for crew without a
    // connection, never for followers/anonymous (isCrew is implicit here:
    // anonymous users don't reach an owner branch).
    if (!isOwner) return null;
    return (
      <Card className="p-5">
        <p className="kicker mb-2">TriCount</p>
        <p className="text-sm text-muted-foreground">
          Link the trip's shared expense pot to show balances and recent
          expenses here. Paste the sharing link (tricount.com/t…) or its key.
        </p>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!keyDraft.trim()) return;
            setConnectError(null);
            if (isPostHogConfigured) posthog.capture("tricount_connected");
            void run(
              (token) => connectTricount(trip.id, keyDraft.trim(), token),
              (t) => t, // canonical doc carries practical.tricount — effect refetches
            );
            setKeyDraft("");
          }}
        >
          <input
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="tricount.com/t… or tXXXXX"
            aria-label="Tricount sharing link or key"
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-card px-3 text-sm outline-none focus-visible:focus-ring"
          />
          <Button type="submit" size="sm" disabled={busy || !keyDraft.trim()}>
            <Wallet className="h-3.5 w-3.5" /> Connect
          </Button>
        </form>
        {connectError && (
          <p role="alert" className="mt-2 text-xs font-medium text-destructive">
            {connectError}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs font-medium text-destructive">
            {error}
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="kicker">TriCount{snap?.title ? ` · ${snap.title}` : ""}</p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh Tricount data"
            title="Refresh"
            onClick={() => {
              if (isPostHogConfigured) posthog.capture("tricount_refreshed");
              void load(true);
            }}
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {isOwner && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Disconnect Tricount"
              title="Disconnect"
              onClick={() => {
                setLoadError(null);
                if (isPostHogConfigured) posthog.capture("tricount_disconnected");
                void run((token) => disconnectTricount(trip.id, token), (t) => t);
              }}
              disabled={busy}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {loadError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {loadError}
        </p>
      ) : snap ? (
        <>
          {/* balances */}
          <ul className="mt-3 space-y-1.5">
            {snap.balances.map((b) => (
              <li key={b.member} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium">{b.member}</span>
                <span
                  className={`shrink-0 tabular-nums font-heading font-semibold ${
                    b.amount < 0 ? "text-destructive" : "text-accent"
                  }`}
                >
                  {fmt(b.amount, b.currency)}
                </span>
              </li>
            ))}
          </ul>

          {/* last expenses */}
          {snap.expenses.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Expenses
              </p>
              <ul className="space-y-1.5">
                {snap.expenses.slice(-5).reverse().map((e) => (
                  <li key={e.id} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="truncate font-medium">{e.description ?? "Expense"}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {e.date} · {e.whoPaid} paid
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">{fmt(e.amount, e.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-3 text-[11px] text-muted-foreground">
            Fetched {fmtAgo(snap.fetchedAt)}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {loading ? "Loading…" : "No data."}
        </p>
      )}

      <a
        href={tricountAppUrl(config.registryKey)}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
      >
        Open in Tricount <ExternalLink className="h-3 w-3" />
      </a>

      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}
