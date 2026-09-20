/** Instagram link recognition + player URLs (#358).
 *
 * ONE definition per rule, shared by every block renderer: an Instagram
 * reel/post URL in a block's existing `links` field plays inline — no new
 * model field, no DTDL change, no write-API change (the content agent just
 * attaches a link like any other). The iframe `src` is always DERIVED from
 * the validated kind + shortcode on the `www.instagram.com/.../embed` path —
 * the pasted URL never reaches an iframe attribute, so a non-Instagram link
 * can never become an embed.
 *
 * Hosts recognised: instagram.com, www.instagram.com. Kinds recognised:
 * reel, p (post), tv. Profile (`/<user>/`), stories, explore and every other
 * Instagram surface carry no embeddable media and → null.
 *
 * No token, no oEmbed proxy: the public `/embed` player endpoint needs
 * neither, so the click-to-play facade keeps the same privacy shape as the
 * YouTube player (#283) — nothing third-party loads until the traveler
 * presses play. (There is no token-free poster frame, so the facade is a
 * neutral tile instead of a thumbnail.)
 */

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

const INSTAGRAM_KINDS = new Set(["reel", "p", "tv"]);

/** An Instagram shortcode is base64-ish `[A-Za-z0-9_-]`, ~11 chars in
 *  practice. The floor rejects `/p/x`-style junk without pinning a length
 *  Meta never promised. */
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,}$/;

export interface InstagramRef {
  kind: "reel" | "p" | "tv";
  shortcode: string;
}

/** Extract the embed ref from a URL, or null when it is not an Instagram
 *  reel/post URL. A pasted `/embed` sufflix is accepted (same media). */
export function extractInstagramRef(raw: string | undefined | null): InstagramRef | null {
  if (typeof raw !== "string" || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const [kind, shortcode, extra] = segments;
  if (!kind || !INSTAGRAM_KINDS.has(kind)) return null;
  if (!shortcode || !SHORTCODE_RE.test(shortcode)) return null;
  // Exactly /<kind>/<code>[/] — or the same with a pasted /embed suffix.
  if (extra !== undefined && extra !== "embed") return null;
  if (segments.length > 3) return null;
  return { kind: kind as InstagramRef["kind"], shortcode };
}

/** True when this link URL is a playable Instagram reel/post. */
export function isInstagramUrl(raw: string | undefined | null): boolean {
  return extractInstagramRef(raw) != null;
}

/** Public embed player — needs no token. Only mounted after play. */
export function instagramEmbedUrl(ref: InstagramRef): string {
  return `https://www.instagram.com/${ref.kind}/${ref.shortcode}/embed`;
}

/** Canonical watch URL for the caption link + the print fallback (booklet
 *  pages cannot play). */
export function instagramWatchUrl(ref: InstagramRef): string {
  return `https://www.instagram.com/${ref.kind}/${ref.shortcode}/`;
}

export interface BlockLink {
  label: string;
  url: string;
}

/** Split a block's links into inline Instagram players + remaining pill links.
 *  Order is preserved on both sides; non-Instagram links are untouched. */
export function partitionInstagramLinks<T extends BlockLink>(
  links: T[] | undefined | null,
): { instagram: { link: T; ref: InstagramRef }[]; rest: T[] } {
  const instagram: { link: T; ref: InstagramRef }[] = [];
  const rest: T[] = [];
  for (const link of links ?? []) {
    const ref = extractInstagramRef(link?.url);
    if (ref) instagram.push({ link, ref });
    else rest.push(link);
  }
  return { instagram, rest };
}
