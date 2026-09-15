import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { isVideoSrc, posterFor } from "../lib/media";
import { relativeTime } from "../lib/dates";
import type { FeedEntry } from "../lib/types";
import { Badge } from "./ui";

/**
 * One feed row (#249).
 *
 * Lifted verbatim from `pages/FeedPage.tsx` when the signed-in home started
 * reusing it: the issue forbids a second feed ("No second feed: `/feed` stays
 * the paged archive"), so reuse means moving the row into `components/`, not
 * copying it. `FeedPage` renders this same component — the home shows the
 * newest rows, `/feed` keeps `?before=` paging.
 */
function Thumbs({ thumbs }: { thumbs: string[] }) {
  if (!thumbs.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {thumbs.map((src) => {
        // A clip's thumbnail is its poster frame with a play badge (#250): a
        // <video> here would be a heavier preview that does not scrub, and this
        // row shows what was written, not a player.
        if (isVideoSrc(src)) {
          const poster = posterFor(src);
          return (
            <span
              key={src}
              className="relative block h-20 w-20 overflow-hidden rounded-lg border border-border bg-black/85"
            >
              {poster && (
                <img
                  src={poster}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-20 w-20 object-cover opacity-80"
                />
              )}
              <span className="absolute inset-0 grid place-items-center">
                <Play className="h-6 w-6 text-white" aria-hidden="true" />
              </span>
              <span className="sr-only">Video</span>
            </span>
          );
        }
        return (
          <img
            key={src}
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-20 w-20 rounded-lg border border-border object-cover"
          />
        );
      })}
    </div>
  );
}

/** The properties the graph stamped, in words: "Updated title, cover photo". */
function changesLabel(entry: FeedEntry): string {
  const changes = entry.changes ?? [];
  if (!changes.length) return "Updated";
  return `Updated ${changes.join(", ")}`;
}

export function FeedRow({ entry, now }: { entry: FeedEntry; now: number }) {
  const isItem = entry.kind === "item";
  return (
    <li className="px-4 py-3">
      <Link to={entry.href} className="block focus-visible:focus-ring">
        {isItem && (
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {entry.dayTitle || `Day ${(entry.dayIndex ?? 0) + 1}`}
          </span>
        )}
        <p className="text-sm">
          <span className="font-medium">
            {isItem ? entry.blockTitle || entry.label : changesLabel(entry)}
          </span>
          <span className="text-muted-foreground">
            {isItem && entry.blockTitle ? ` · ${entry.label}` : ""}
            {" · "}
            {relativeTime(entry.at, now)}
          </span>
          {entry.source === "my-trip" && (
            <Badge variant="outline" className="ml-2 align-middle">
              You
            </Badge>
          )}
        </p>
        {isItem && <Thumbs thumbs={entry.thumbs ?? []} />}
      </Link>
    </li>
  );
}
