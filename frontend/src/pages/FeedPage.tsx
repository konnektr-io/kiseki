/**
 * Activity feed (#199).
 *
 * Two streams in one list, newest write first: your own trips, and the
 * DISCOVERABLE trips of the people you follow. Every row is a stamp the graph
 * itself wrote (`$metadata.<property>.$lastUpdateTime|$lastUpdatedBy`), so this
 * page renders what was written and when — it never re-derives the order.
 *
 * Item rows are the point of the item granularity: a followed trip reports the
 * write ("4 photos added") with its photos inline, so a follower sees the
 * picture here instead of opening the trip to find it.
 *
 * Routes are trip ids, never slugs: `$dtId` is the durable identity, while the
 * slug is the repo-folder name — organizational, editable, and able to collide.
 *
 * Cost: one request per load, and the server reuses its 60s trip bundle for the
 * item walk. Refresh happens on window focus only — never on an interval.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { TripAccessError, fetchFeed } from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";
import { usePageTitle } from "../lib/seo";
import type { FeedDoc, FeedEntry } from "../lib/types";
import { AppHeader } from "../components/AppHeader";
import { AuthButton } from "../components/AuthButton";
import { FeedRow } from "../components/FeedRow";
import { Button, Card } from "../components/ui";

/* ---------------- pure helpers (kept exported for the tests) ---------------- */

// `relativeTime` lives in `lib/dates` since FeedRow was lifted into components/
// (#249); re-exported here so existing imports keep working.
export { relativeTime } from "../lib/dates";

export interface FeedGroup {
  tripId: string;
  title: string;
  entries: FeedEntry[];
}

/** One block per trip. The server's order is kept verbatim: a trip's block sits
 *  where its newest write sits, and the rows inside it stay newest-first. */
export function groupByTrip(entries: FeedEntry[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  const byId = new Map<string, FeedGroup>();
  for (const entry of entries) {
    let group = byId.get(entry.tripId);
    if (!group) {
      group = { tripId: entry.tripId, title: entry.tripTitle, entries: [] };
      byId.set(entry.tripId, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/* ---------------- states ---------------- */

type Failure = "expired" | "unavailable" | "error";

function failureFor(err: unknown): Failure {
  if (isSessionExpiredError(err)) return "expired";
  if (
    err instanceof TripAccessError &&
    (err.status === 401 || err.status === 403)
  ) {
    return "expired";
  }
  if (
    err instanceof TripAccessError &&
    (err.status === 502 || err.status === 503 || err.status === 504)
  ) {
    return "unavailable";
  }
  return "error";
}

const FAILURE_COPY: Record<Failure, string> = {
  expired: "Your session expired. Sign in again to pick the feed back up.",
  unavailable:
    "The graph is unreachable right now. Your feed will be here when it is back.",
  error: "Couldn’t load your feed.",
};

function FailurePanel({
  failure,
  onRetry,
  onSignIn,
}: {
  failure: Failure;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  return (
    <Card className="p-6">
      <p className="text-sm text-muted-foreground">{FAILURE_COPY[failure]}</p>
      <div className="mt-4 flex gap-2">
        {failure === "expired" ? (
          <Button onClick={onSignIn}>Sign in again</Button>
        ) : (
          <Button onClick={onRetry}>Try again</Button>
        )}
      </div>
    </Card>
  );
}

/* ---------------- the page ---------------- */

export function FeedPage() {
  usePageTitle("Feed");
  const { isAuthenticated, isLoading, getAccessTokenSilently, loginWithRedirect } = useAuth0();
  const [doc, setDoc] = useState<FeedDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyOlder, setBusyOlder] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(
    async (before?: string | null) => {
      try {
        const token = await getAccessTokenSilently();
        const next = await fetchFeed(token, before ?? null);
        setFailure(null);
        setDoc((prev) =>
          before && prev
            ? { ...next, items: [...prev.items, ...next.items] }
            : next,
        );
      } catch (err) {
        setFailure(failureFor(err));
      } finally {
        setLoading(false);
        setBusyOlder(false);
      }
    },
    [getAccessTokenSilently],
  );

  // First load, once the SDK knows whether we are signed in. `reloadKey` is the
  // "Try again" handle — an explicit user action, never a render-time retry.
  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    void load(null);
  }, [isLoading, isAuthenticated, load, reloadKey]);

  // Refresh on window focus only (a returning tab picks up new writes); no
  // interval polling, so an idle tab costs nothing.
  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    const onFocus = () => {
      void load(null);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isLoading, isAuthenticated, load]);

  // The bar is the shared one (#239) and lives outside <main> — a sticky,
  // full-width bar cannot sit inside a padded, width-capped content column.
  // The feed's own description is page content, so it stays in the column.
  const bar = (
    <AppHeader home={{ to: "/", label: "Home" }} title="Feed" actions={<AuthButton />} />
  );
  const intro = (
    <p className="text-sm text-muted-foreground">
      Your trips and the trips you follow, newest write first.
    </p>
  );

  if (!isLoading && !isAuthenticated) {
    return (
      <>
        {bar}
        <main className="mx-auto max-w-2xl px-4 py-10">
          {intro}
          <Card className="mt-6 p-6">
          <p className="text-sm text-muted-foreground">
            The feed is private to you. Sign in to see your trips and the people
            you follow.
          </p>
          <Button className="mt-4" onClick={() => loginWithRedirect()}>
            Sign in
          </Button>
          </Card>
        </main>
      </>
    );
  }

  const items = doc?.items ?? [];
  const now = Date.now();

  return (
    <>
      {bar}
      <main className="mx-auto max-w-2xl px-4 py-10">
        {intro}

      <div className="mt-6">
        {failure ? (
          <FailurePanel
            failure={failure}
            onRetry={() => {
              setLoading(true);
              setReloadKey((k) => k + 1);
            }}
            onSignIn={() => loginWithRedirect()}
          />
        ) : loading && !doc ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading your feed…
          </p>
        ) : items.length === 0 ? (
          <Card className="p-6">
            <p className="text-sm text-muted-foreground">
              Nothing written yet. Follow people to see their public trips — anything
              they keep discoverable shows up in this feed.
            </p>
          </Card>
        ) : (
          <ul className="space-y-4">
            {groupByTrip(items).map((group) => (
              <li key={group.tripId}>
                <Card className="overflow-hidden">
                  <div className="border-b border-border px-4 py-3">
                    <Link
                      to={`/t/${group.tripId}`}
                      className="font-semibold hover:underline"
                    >
                      {group.title}
                    </Link>
                  </div>
                  <ul className="divide-y divide-border">
                    {group.entries.map((entry, i) => (
                      <FeedRow
                        key={`${entry.kind}-${entry.at ?? "?"}-${entry.href}-${i}`}
                        entry={entry}
                        now={now}
                      />
                    ))}
                  </ul>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {doc?.nextBefore && (
          <div className="mt-6 flex justify-center">
            <Button
              variant="outline"
              disabled={busyOlder}
              onClick={() => {
                setBusyOlder(true);
                void load(doc.nextBefore);
              }}
            >
              {busyOlder ? "Loading…" : "Load older"}
            </Button>
          </div>
        )}
      </div>
      </main>
    </>
  );
}
