import { useEffect, useState } from "react";
import { Download, Route } from "lucide-react";
import {
  fetchTrack,
  formatTrackAscent,
  formatTrackDistance,
  formatTrackDuration,
  trackDataUrl,
  trackTracePath,
  type TrackFeature,
} from "../lib/tracks";

/**
 * A recorded track's own card (#193): the shape of the day as distance /
 * time / ascent plus a static SVG trace — NOT a letter-chip stop, so it
 * carries `data-track-card` and never `data-place-pill` (#90).
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
  const path =
    feature && feature.geometry.coordinates.length >= 2
      ? trackTracePath(feature.geometry.coordinates, 320, 96, 6)
      : null;

  return (
    <div
      data-track-card={track}
      role="img"
      aria-label={
        props
          ? `Recorded track: ${formatTrackDistance(props.distanceM)}, ${formatTrackAscent(props.ascentM)} ascent${duration ? `, ${duration}` : ""}`
          : "Recorded GPS track"
      }
      className="mt-2.5 overflow-hidden rounded-lg border border-border bg-muted/40"
    >
      {path ? (
        <svg
          viewBox="0 0 320 96"
          className="block h-24 w-full text-primary"
          aria-hidden="true"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Wide casing under a narrower body — the §8.4 grammar, in SVG.
              Colours ride CSS vars (tokens), never hex literals: presentation
              attributes cannot carry var(), so the stroke lives in style. */}
          <path d={path} fill="none" style={{ stroke: "var(--color-route-casing)" }} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
          <path d={path} fill="none" style={{ stroke: "var(--color-route)" }} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
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
              {formatTrackDistance(props.distanceM)}
            </span>
            {duration && (
              <span className="text-xs tabular-nums text-muted-foreground">{duration}</span>
            )}
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTrackAscent(props.ascentM)}
            </span>
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
          aria-label="Download the recorded GPX track"
        >
          <Download className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          GPX
        </a>
      </div>
    </div>
  );
}
