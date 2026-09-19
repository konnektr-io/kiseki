import { useEffect, useState } from "react";
import { Download, Route } from "lucide-react";
import type { BlockStatus } from "../lib/types";
import {
  fetchTrack,
  formatTrackAscent,
  formatTrackDistance,
  formatTrackDuration,
  trackDataUrl,
  trackRideSplit,
  type TrackFeature,
} from "../lib/tracks";

/**
 * A track block's stats strip (#193, #290, #305, #336): distance, duration,
 * ascent and lift splits beside the download link.
 *
 * The same `track` field carries two different claims, told apart by the
 * block's own `status` (#336):
 *
 * - **`status: "done"`** — the activity happened, the file is a RECORDING →
 *   "Recorded track", and the ride/lift split describes what was ridden;
 * - **anything else** — the file is the ROUTE the crew plans to walk (a
 *   signposted trail's GPX attached while planning, #194) → "Route", and no
 *   split: a plan has no riding in it. Without these two rules a planned
 *   hiking day read "Recorded track · 16.2 km ridden, 16.2 km tracked".
 *
 * NOT a letter-chip stop, so it carries `data-track-card` and never
 * `data-place-pill` (#90).
 *
 * Minimap behaviour (#305): in regular app mode the minimap is hidden
 * because the persistent map surface right beside the rail already frames
 * the track. In the booklet (print mode), the track is overlaid on a real
 * map with basemap tiles, terrain hillshade, and location pin via the
 * block's `CardMedia` minimap (`MapView` compact) — so `TrackCard` stays
 * focused on the stats and the file link across all surfaces.
 */
export function TrackCard({ track, status }: { track: string; status?: BlockStatus }) {
  const dataUrl = trackDataUrl(track);
  const [feature, setFeature] = useState<TrackFeature | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!dataUrl) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    setFeature(null);
    setFailed(false);
    (async () => {
      try {
        const parsed = await fetchTrack(dataUrl, abort.signal);
        if (!cancelled) setFeature(parsed);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [dataUrl]);

  const recorded = status === "done";
  const label = recorded ? "Recorded track" : "Route";
  const props = feature?.properties;
  const duration = formatTrackDuration(props?.durationS);
  const split = recorded ? trackRideSplit(props) : null;
  const liftCount = props?.legs?.filter((l) => l.type === "lift").length ?? 0;

  return (
    <div
      data-track-card={track}
      role="group"
      aria-label={
        props
          ? split
            ? `${label}: ${formatTrackDistance(split.rideM)} ridden, ${formatTrackDistance(split.totalM)} total with ${liftCount} lift ${liftCount === 1 ? "ride" : "rides"}${duration ? `, ${duration}` : ""}`
            : `${label}: ${formatTrackDistance(props.distanceM)}, ${formatTrackAscent(props.ascentM)} ascent${duration ? `, ${duration}` : ""}`
          : recorded
            ? "Recorded GPS track"
            : "Route file"
      }
      className="mt-2.5 overflow-hidden rounded-lg border border-border bg-muted/40"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Route className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          {label}
        </span>
        {props ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {split
                ? `${formatTrackDistance(split.rideM)} ridden`
                : formatTrackDistance(props.distanceM)}
            </span>
            {split && (
              <span
                className="text-xs tabular-nums text-muted-foreground/80"
                title="Trace total — includes the lift rides"
              >
                {formatTrackDistance(split.totalM)} tracked
              </span>
            )}
            {duration && (
              <span className="text-xs tabular-nums text-muted-foreground">{duration}</span>
            )}
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTrackAscent(props.ascentM)}
            </span>
            {split && liftCount > 0 && (
              <span
                className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
                title={`${liftCount} lift ${liftCount === 1 ? "ride" : "rides"}`}
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-0 w-4 border-t-2 border-dashed border-muted-foreground/60"
                />
                {liftCount} {liftCount === 1 ? "lift" : "lifts"}
                {split.liftVerticalM > 0 ? ` · +${Math.round(split.liftVerticalM).toLocaleString("en-US")} m` : ""}
              </span>
            )}
          </>
        ) : !failed ? (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Loading track…
          </span>
        ) : null}
        <a
          href={track}
          download
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
          aria-label={recorded ? "Download the recorded track file" : "Download the route file"}
        >
          <Download className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          {track.toLowerCase().endsWith(".fit") ? "FIT" : "GPX"}
        </a>
      </div>
    </div>
  );
}
