import { useState } from "react";
import { Play, Youtube } from "lucide-react";
import { extractYouTubeId, youtubeEmbedUrl, youtubeThumbnailUrl, type BlockLink } from "../lib/youtube";

/**
 * A YouTube link as an inline player (#283).
 *
 * Click-to-play facade: nothing third-party loads until the traveler presses
 * play (thumbnail is the only remote fetch, and it comes from YouTube's
 * cookieless image host) — then the `youtube-nocookie` iframe mounts with
 * autoplay. Print gets the thumbnail plus a LINK, never the player (a booklet
 * page cannot play a clip — same rule the trip-video blocks follow, #250).
 */
export function YouTubeEmbed({ id, title, url }: { id: string; title: string; url: string }) {
  const [playing, setPlaying] = useState(false);
  const thumb = youtubeThumbnailUrl(id);

  if (playing) {
    return (
      <figure className="youtube-embed mt-2 overflow-hidden rounded-lg border border-border">
        <iframe
          src={youtubeEmbedUrl(id, true)}
          title={title}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          className="no-print aspect-video w-full"
        />
        <figcaption className="hidden gap-2 px-2 py-1.5 text-xs text-muted-foreground print:flex">
          <img src={thumb} alt="" loading="lazy" className="aspect-video w-1/3 rounded object-cover" />
          <a href={url} target="_blank" rel="noreferrer" className="self-center underline underline-offset-2">
            Watch on YouTube
          </a>
        </figcaption>
      </figure>
    );
  }

  return (
    <figure className="youtube-embed mt-2 overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setPlaying(true)}
        aria-label={`Play video: ${title}`}
        className="relative block w-full cursor-pointer"
      >
        <img src={thumb} alt="" loading="lazy" className="aspect-video w-full object-cover" />
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center bg-black/20 transition-colors hover:bg-black/30 print:hidden"
        >
          <span className="grid h-12 w-12 place-items-center rounded-full bg-black/70 text-white">
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          </span>
        </span>
      </button>
      <figcaption className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
        <Youtube className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <a
          href={url}
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

/** Every YouTube link on the block, in link order — null when there are none. */
export function YouTubeEmbeds<T extends BlockLink>({ links }: { links?: T[] | null }) {
  const entries = (links ?? [])
    .map((link) => ({ link, id: extractYouTubeId(link?.url) }))
    .filter((e): e is { link: T; id: string } => e.id != null);
  if (!entries.length) return null;
  return (
    <>
      {entries.map(({ link, id }) => (
        <YouTubeEmbed key={link.url} id={id} title={link.label || "YouTube video"} url={link.url} />
      ))}
    </>
  );
}
