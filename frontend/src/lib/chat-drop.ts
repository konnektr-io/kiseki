/**
 * Drag-and-drop onto the chat composer (issue #291).
 *
 * The drop target is the picker's EQUAL, never its replacement: drag-and-drop
 * is meaningless on touch, so the file picker stays the primary path and
 * nothing becomes drop-only. Both paths hand a `FileList` to the same
 * `attach()` in `chat-panel.tsx` — same `POST /api/files`, same per-file
 * progress and per-file errors. There is no drop-specific endpoint and no
 * second upload path to keep honest.
 *
 * One consequence worth stating: the accept list below is the ONLY one. The
 * picker's `accept` attribute and the drop zone's copy are both derived from
 * it, so adding a family (`.fit`, see #290) changes the picker, the zone and
 * the attach button's tooltip together, and cannot drift.
 */

/** What the chat composer takes — the picker's `accept` AND the drop zone's
 *  vocabulary. Extensions first-class because the server keys its
 *  per-family caps off the extension (image 64 MB, video 1024 MB,
 *  document 32 MB), and `image/*`/`video/*` because a phone's photo picker
 *  only offers those families then. `.gpx` is the track export every
 *  Slopes/Strava/Garmin workflow ends with (#193/#279). */
export const CHAT_FILE_ACCEPT =
  "image/*,.heic,.heif,video/*,.mp4,.mov,.m4v,.webm,.pdf,.doc,.docx,.txt,.md,.gpx";

/** Human labels for the accept tokens, keyed by the token. Tokens that are
 *  extensions of a family already named (`image/*` + a list of image
 *  extensions) carry no label of their own: the family is what the user
 *  thinks in, and naming `photos` twice would read as a stutter. */
const KIND_LABELS: Record<string, string> = {
  "image/*": "photos",
  ".heic": "photos",
  ".heif": "photos",
  "video/*": "videos",
  ".mp4": "videos",
  ".mov": "videos",
  ".m4v": "videos",
  ".webm": "videos",
  ".pdf": "documents",
  ".doc": "documents",
  ".docx": "documents",
  ".txt": "text notes",
  ".md": "text notes",
  ".gpx": "GPX tracks",
};

/** The kinds named by an accept list, in the list's own order, deduped. A
 *  token with no label is kept verbatim (`.fit` → `.fit`): an unknown family
 *  must still be stated, never quietly dropped from the copy. */
export function acceptKinds(accept: string = CHAT_FILE_ACCEPT): string[] {
  const kinds: string[] = [];
  for (const raw of accept.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const kind = KIND_LABELS[token] ?? token;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/** The accept list as prose — what the drop zone states it takes. English
 *  list join: `a`, `a and b`, `a, b and c`. */
export function acceptSummary(accept: string = CHAT_FILE_ACCEPT): string {
  const kinds = acceptKinds(accept);
  if (kinds.length === 0) return "files";
  if (kinds.length === 1) return kinds[0];
  return `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}`;
}

/** Whether a drag carries files at all. `DataTransfer.types` is the only
 *  thing readable from a `dragover` (the files themselves are hidden until
 *  the drop), and it lists `Files` for a file drag from the desktop, Finder,
 *  Explorer, or another browser window. A drag of selected TEXT does not list
 *  it, and the composer must not light up for that one — the draft textarea
 *  owns it. */
export function dropCarriesFiles(
  types: readonly string[] | ArrayLike<string> | null | undefined,
): boolean {
  if (!types) return false;
  return Array.from(types).includes("Files");
}
