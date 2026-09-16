import { useEffect, useState } from "react";
import { Download, Route } from "lucide-react";
import {
  fetchTrack,
  formatTrackAscent,
  formatTrackDistance,
  formatTrackDuration,
  trackDataUrl,
  trackLegPaths,
  trackRideSplit,
  type TrackFeature,
} from "../lib/tracks";

/**
 * A recorded track's own card (#193): the shape of the day as distance /
 * time / ascent plus a static SVG trace — NOT a letter-chip stop, so it
 * carries `data-track-card` and never `data-place-pill` (#90).
 *
 * #290: the trace is drawn leg by leg — ridden runs solid, lift rides dashed
 * and lighter (the Slopes/Strava convention) — and the stats show the
 * riding-only distance beside the full trace distance instead of picking one,
 * because a tracked day legitimately reads two different numbers.
 *
 * The trace is DATA (the parsed polyline), not a screenshot: it prints in
 * the booklet through this same component. A fetch failure degrades to the
 * download link — never an empty card, never a silent drop (#251).
 */
export function TrackCard({ track }: { track: string }) {
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

  const props = feature?.properties;
  const duration = formatTrackDuration(props?.durationS);
  const legs = feature ? trackLegPaths(feature, 320, 96, 6) : [];
  const split = trackRideSplit(props);
  const liftCount = props?.legs?.filter((l) => l.type === "lift").length ?? 0;

  return (
    <div
      data-track-card={track}
      role="img"
      aria-label={
        props
          ? split
            ? `Recorded track: ${formatTrackDistance(split.rideM)} ridden, ${formatTrackDistance(split.totalM)} total with ${liftCount} lift ${liftCount === 1 ? "ride" : "rides"}${duration ? `, ${duration}` : ""}`
            : `Recorded track: ${formatTrackDistance(props.distanceM)}, ${formatTrackAscent(props.ascentM)} ascent${duration ? `, ${duration}` : ""}`
          : "Recorded GPS track"
      }
      className="mt-2.5 overflow-hidden rounded-lg border border-border bg-muted/40"
    >
      {legs.length ? (
        <svg
          viewBox="0 0 320 96"
          className="block h-24 w-full text-primary"
          aria-hidden="true"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Wide casing under a narrower body — the §8.4 grammar, in SVG.
              Colours ride CSS vars (tokens), never hex literals: presentation
              attributes cannot carry var(), so the stroke lives in style.
              Every casing draws FIRST so no body is buried under a neighbour's
              casing; lift legs then draw dashed and lighter (#290) — the same
              distinction Slopes and Strava make on their own maps. */}
          {legs.map((leg, i) => (
            <path
              key={`casing-${i}`}
              d={leg.d}
              fill="none"
              style={{ stroke: "var(--color-route-casing)" }}
              strokeWidth={7}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={leg.type === "lift" ? 0.6 : 0.9}
              strokeDasharray={leg.type === "lift" ? "2 2.2" : undefined}
            />
          ))}
          {legs.map((leg, i) => (
            <path
              key={`body-${i}`}
              d={leg.d}
              fill="none"
              style={{ stroke: "var(--color-route)" }}
              strokeWidth={4}
              strokeLinecap={leg.type === "lift" ? "butt" : "round"}
              strokeLinejoin="round"
              opacity={leg.type === "lift" ? 0.75 : 1}
              strokeDasharray={leg.type === "lift" ? "2 2.2" : undefined}
            />
          ))}
        </svg>
      ) : !failed ? (
        <div className="h-24 w-full animate-pulse bg-muted" aria-hidden="true" />
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Route className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          Recorded track
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
                title={`${liftCount} lift ${liftCount === 1 ? "ride" : "rides"} — dashed on the trace`}
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
          aria-label="Download the recorded track file"
        >
          <Download className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          {track.toLowerCase().endsWith(".fit") ? "FIT" : "GPX"}
        </a>
      </div>
    </div>
  );
}
