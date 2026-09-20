import { useState } from "react";
import { Instagram, Play } from "lucide-react";
import {
  extractInstagramRef,
  instagramEmbedUrl,
  instagramWatchUrl,
  type BlockLink,
  type InstagramRef,
} from "../lib/instagram";

/**
 * An Instagram reel/post link as an inline player (#358).
 *
 * Click-to-play facade, same pattern as the YouTube player (#283): nothing
 * third-party loads until the traveler presses play — then the public
 * `/embed` iframe mounts (no token needed). Instagram offers no token-free
 * poster frame, so the facade is a neutral tile instead of a thumbnail.
 * Print gets a LINK, never the player (a booklet page cannot play a clip —
 * same rule the trip-video blocks follow, #250).
 */
export function InstagramEmbed({
  ref,
  title,
  url,
}: {
  ref: InstagramRef;
  title: string;
  url: string;
}) {
  const [playing, setPlaying] = useState(false);
  const watch = instagramWatchUrl(ref);

  if (playing) {
    return (
      <figure className="instagram-embed mt-2 overflow-hidden rounded-lg border border-border">
        <iframe
          src={instagramEmbedUrl(ref)}
          title={title}
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          className="no-print mx-auto aspect-[9/16] w-full max-w-[360px]"
        />
        <figcaption className="hidden gap-2 px-2 py-1.5 text-xs text-muted-foreground print:flex">
          <a href={url} target="_blank" rel="noreferrer" className="self-center underline underline-offset-2">
            View on Instagram
          </a>
        </figcaption>
      </figure>
    );
  }

  return (
    <figure className="instagram-embed mt-2 overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setPlaying(true)}
        aria-label={`Play Instagram reel: ${title}`}
        className="relative block aspect-[9/16] w-full cursor-pointer bg-gradient-to-br from-purple-500/15 via-pink-500/15 to-amber-500/15"
      >
        <span aria-hidden className="absolute inset-0 grid place-items-center">
          <span className="grid h-16 w-16 place-items-center rounded-2xl bg-black/70 text-white">
            <Instagram className="h-7 w-7" />
          </span>
        </span>
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center bg-black/10 transition-colors hover:bg-black/20 print:hidden"
        >
          <span className="mt-24 grid h-12 w-12 place-items-center rounded-full bg-black/70 text-white">
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          </span>
        </span>
      </button>
      <figcaption className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
        <Instagram className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <a
          href={watch}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="truncate font-medium hover:underline"
        >
          {title}
        </a>
      </figcaption>
    </figure>
  );
}

/** Every Instagram reel/post link on the block, in link order — null when there are none. */
export function InstagramEmbeds<T extends BlockLink>({ links }: { links?: T[] | null }) {
  const entries = (links ?? [])
    .map((link) => ({ link, ref: extractInstagramRef(link?.url) }))
    .filter((e): e is { link: T; ref: InstagramRef } => e.ref != null);
  if (!entries.length) return null;
  return (
    <>
      {entries.map(({ link, ref }) => (
        <InstagramEmbed
          key={link.url}
          ref={ref}
          title={link.label || "Instagram reel"}
          url={link.url}
        />
      ))}
    </>
  );
}
