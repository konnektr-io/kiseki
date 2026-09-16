/** YouTube link recognition + player URLs (#283).
 *
 * ONE definition per rule, shared by every block renderer: a YouTube URL in a
 * block's existing `links` field plays inline — no new model field, no DTDL
 * change, no write-API change (the content agent just attaches a link like
 * any other). The iframe `src` is always DERIVED from the validated video id
 * on the `youtube-nocookie` host — the pasted URL never reaches an iframe
 * attribute, so a non-YouTube link can never become an embed.
 *
 * Hosts recognised: youtube.com (watch/embed/shorts/live), m.youtube.com,
 * youtube-nocookie.com (embed) and youtu.be. Anything else → null.
 */

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** A YouTube video id is 11 chars of `[A-Za-z0-9_-]`. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extract the video id from a URL, or null when it is not a YouTube watch URL. */
export function extractYouTubeId(raw: string | undefined | null): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");

  if (host === "youtu.be") {
    // https://youtu.be/<id>[?t=…]
    const id = path.slice(1).split("/")[0] ?? "";
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  // https://www.youtube.com/watch?v=<id>[&…]
  if (path === "/watch") {
    const id = url.searchParams.get("v") ?? "";
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  // /embed/<id>, /shorts/<id>, /live/<id>
  const m = /^\/(?:embed|shorts|live)\/([^/?#]+)/.exec(path);
  if (m) return VIDEO_ID_RE.test(m[1]) ? m[1] : null;
  return null;
}

/** True when this link URL is a playable YouTube video. */
export function isYouTubeUrl(raw: string | undefined | null): boolean {
  return extractYouTubeId(raw) != null;
}

/** Privacy-hardened player URL — the nocookie host sets no tracking cookies,
 *  and the iframe is only mounted after the traveler presses play. */
export function youtubeEmbedUrl(id: string, autoplay = false): string {
  return `https://www.youtube-nocookie.com/embed/${id}${autoplay ? "?autoplay=1" : ""}`;
}

/** Canonical watch URL for the print fallback (booklet pages cannot play). */
export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Stock poster frame — the facade thumbnail and the booklet print image. */
export function youtubeThumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export interface BlockLink {
  label: string;
  url: string;
}

/** Split a block's links into inline players + remaining pill links.
 *  Order is preserved on both sides; non-YouTube links are untouched. */
export function partitionYouTubeLinks<T extends BlockLink>(
  links: T[] | undefined | null,
): { youtube: { link: T; id: string }[]; rest: T[] } {
  const youtube: { link: T; id: string }[] = [];
  const rest: T[] = [];
  for (const link of links ?? []) {
    const id = extractYouTubeId(link?.url);
    if (id) youtube.push({ link, id });
    else rest.push(link);
  }
  return { youtube, rest };
}
