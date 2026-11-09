import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { MountainSnow, X } from "lucide-react";
import { useTripState } from "./theme";
import {
  fetchStravaActivities,
  importStravaActivity,
  TripAccessError,
  type StravaActivity,
  type StravaImportResult,
} from "../lib/api";
import { isSessionExpiredError } from "../lib/auth";

/**
 * Trip ⋮ menu → "Import from Strava" (#449) — deliberately quiet.
 *
 * One row in the overflow menu, an editor+ action (it writes content), nothing
 * on the overview: no badge, no banner, no "new!" dot. That is the whole point
 * of the scope decision — a Strava import is a chore you do after the ride, not
 * a feature the trip advertises.
 *
 * What the dialog refuses to do:
 *  * guess a day. The date is a hard filter server-side; if the activity's own
 *    local date is not a day of this trip, the row simply is not here.
 *  * import without the consent line. The tick defaults ON (defaults-on rule)
 *    but it is a real gate: the track and the photos become part of the trip —
 *    visible to the crew, to anyone holding the link if the trip is public, and
 *    printed in the booklet.
 *  * hide a conflict. "This block already has a track" (a crewmate's recording)
 *    and "already imported" are stated, never silently resolved.
 */
export function StravaImportDialog({ onClose }: { onClose: () => void }) {
  const { trip, apply } = useTripState();
  const { getAccessTokenSilently } = useAuth0();

  const [activities, setActivities] = useState<StravaActivity[] | null>(null);
  // Whether the trip's first day has begun. An empty list means two different
  // things — "nothing recorded yet" vs "you have not been there yet" — and
  // saying which is the difference between a dead end and an explanation.
  const [tripStarted, setTripStarted] = useState(true);
  const [consent, setConsent] = useState(true);
  const [withPhotos, setWithPhotos] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // day_id per activity, seeded from the server's suggestion.
  const [days, setDays] = useState<Record<number, string>>({});

  const dayOptions = useMemo(
    () => trip.days.map((day) => ({ id: day.id, label: day.date, title: day.title })),
    [trip.days],
  );
  // Day ids are opaque GUIDs — never show one. The date is what the human reads.
  const dayDate = useCallback(
    (dayId: string) => trip.days.find((day) => day.id === dayId)?.date ?? "",
    [trip.days],
  );

  const load = useCallback(async () => {
    try {
      const token = await getAccessTokenSilently();
      const payload = await fetchStravaActivities(trip.id, token);
      setActivities(payload.activities);
      setTripStarted(payload.tripStarted);
      setDays((current) => {
        const next = { ...current };
        for (const activity of payload.activities) {
          if (!next[activity.id]) {
            next[activity.id] = activity.suggested?.day_id ?? "";
          }
        }
        return next;
      });
    } catch (e) {
      if (e instanceof TripAccessError && e.status === 401) {
        setError("Strava is not connected in this browser. Connect it on your profile, then retry.");
      } else if (isSessionExpiredError(e)) {
        setError("Your session expired — reload the page and try again.");
      } else {
        setError(e instanceof Error ? e.message : "Couldn't read your Strava activities.");
      }
    }
  }, [getAccessTokenSilently, trip.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runImport = async (activity: StravaActivity) => {
    const dayId = days[activity.id];
    if (!dayId || busyId !== null) return;
    setBusyId(activity.id);
    setError(null);
    setNotice(null);
    try {
      const token = await getAccessTokenSilently();
      const { doc, result } = await importStravaActivity(trip.id, token, {
        activity_id: activity.id,
        day_id: dayId,
        block_id: activity.suggested?.block_id ?? null,
        include_photos: withPhotos,
        consent,
      });
      apply(doc);
      setActivities((current) =>
        current
          ? current.map((item) =>
              item.id === activity.id
                ? {
                    ...item,
                    imported: {
                      day_id: result.day_id,
                      block_id: result.block_id ?? "",
                      has_photos: result.photos.written > 0,
                    },
                  }
                : item,
            )
          : current,
      );
      setNotice(describe(result, withPhotos));
    } catch (e) {
      if (e instanceof TripAccessError && e.status === 401) {
        setError("Strava refused the connection — reconnect it on your profile, then retry.");
      } else {
        setError(e instanceof Error ? e.message : "The import failed. Nothing was written.");
      }
    } finally {
      setBusyId(null);
    }
  };

  // Portalled to <body> on purpose: this dialog is mounted from the trip
  // header's overflow menu, and the header carries a backdrop-filter — which
  // makes it the containing block for `position: fixed` descendants. Rendered
  // in place, the overlay would be clipped to the header's 60 px box (measured:
  // overlay rect 430×60, panel at y = −545). A portal is the fix, not a
  // different position.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import from Strava"
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-t-2xl border border-border bg-card p-4 shadow-xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Import from Strava</h2>
            <p className="text-xs text-muted-foreground">
              Pick the recording that belongs to this trip. The track lands on the day you say.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-accent focus-visible:focus-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* One sentence, both facts — this is the consent the API records. */}
        <div className="mt-3 rounded-lg border border-border p-3 text-xs">
          <label className="flex items-start gap-2 font-medium">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I understand the track and its photos become part of this trip — visible to the crew,
              to anyone holding the link if the trip is public, and printed in the booklet.
            </span>
          </label>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={withPhotos}
              disabled={!consent}
              onChange={(e) => setWithPhotos(e.target.checked)}
              className="mt-0.5"
            />
            <span>Also import the activity's photos</span>
          </label>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs font-medium text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {notice}
          </p>
        )}

        <div className="mt-3 space-y-2">
          {activities === null && !error && (
            <p className="py-6 text-center text-sm text-muted-foreground">Reading Strava…</p>
          )}
          {activities !== null && activities.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {tripStarted
                ? "No Strava activity falls on a day of this trip. Nothing to import."
                : "This trip hasn't started yet — there is nothing recorded for its days."}
            </p>
          )}
          {activities?.map((activity) => {
            const imported = activity.imported;
            const dayId = days[activity.id] ?? "";
            const suggestions = activity.suggested;
            const willReplaceBlock = Boolean(suggestions?.block_id) && !imported;
            return (
              <div
                key={activity.id}
                className="rounded-lg border border-border p-3"
                data-testid={`strava-activity-${activity.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{activity.name ?? "Activity"}</p>
                    <p className="text-xs text-muted-foreground">
                      {[activity.local_date, activity.sport_type, formatDistance(activity.distance_m)]
                        .filter(Boolean)
                        .join(" · ")}
                      {activity.elevation_gain_m
                        ? ` · ${Math.round(activity.elevation_gain_m)} m up`
                        : ""}
                      {activity.photo_count > 0 ? ` · ${activity.photo_count} photo` + (activity.photo_count === 1 ? "" : "s") : ""}
                    </p>
                  </div>
                  <MountainSnow className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </div>

                {imported ? (
                  <p className="mt-2 text-xs font-medium text-muted-foreground">
                    Already on {dayDate(imported.day_id) || "this trip"} — importing again changes
                    nothing.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="flex-1 text-xs">
                      <span className="sr-only">Day</span>
                      <select
                        value={dayId}
                        onChange={(e) =>
                          setDays((current) => ({ ...current, [activity.id]: e.target.value }))
                        }
                        className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
                      >
                        <option value="">Pick a day…</option>
                        {dayOptions.map((day) => (
                          <option key={day.id} value={day.id}>
                            {day.label}
                            {day.title ? ` — ${day.title}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => void runImport(activity)}
                      disabled={!consent || !dayId || busyId !== null}
                      title={
                        consent ? undefined : "Tick the consent line first — it is a real gate"
                      }
                      className="h-9 shrink-0 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:focus-ring disabled:opacity-50"
                    >
                      {busyId === activity.id ? "Importing…" : "Import"}
                    </button>
                  </div>
                )}
                {willReplaceBlock && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Will attach to the planned block for that day.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          Activity data from Strava ·{" "}
          <a
            className="underline"
            href="https://www.strava.com"
            target="_blank"
            rel="noreferrer"
          >
            View on Strava
          </a>{" "}
          opens the activity from the block's link.
        </p>
      </div>
    </div>,
    document.body,
  );
}

function formatDistance(meters: number | null): string | null {
  if (meters === null || Number.isNaN(meters)) return null;
  return `${(meters / 1000).toFixed(1)} km`;
}

function describe(result: StravaImportResult, withPhotos: boolean): string {
  if (!result.written) {
    if (result.conflict === "already_imported") return "Already imported — nothing changed.";
    if (result.conflict === "track_exists") {
      return "That block already has a track (someone else's recording) — nothing was replaced.";
    }
    return "Nothing was written.";
  }
  const parts = ["Track added to the day"];
  if (withPhotos) {
    if (result.photos.written > 0) {
      parts.push(`${result.photos.written} photo${result.photos.written === 1 ? "" : "s"}`);
    }
    if (result.photos.failed > 0) {
      parts.push(`${result.photos.failed} photo${result.photos.failed === 1 ? "" : "s"} failed`);
    }
  }
  return `${parts.join(" · ")}.`;
}
