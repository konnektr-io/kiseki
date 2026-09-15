/** Media classification + the poster-frame convention (#250).
 *
 * ONE definition per rule, shared by every surface that renders trip media
 * (the trip document's strips and galleries, the feed, the chat bubble):
 *
 * - Videos are recognised by the URL's extension, exactly like the backend
 *   decides them (`VIDEO_EXTS` in `backend/app/media.py`) — the object is
 *   content-addressed, so the extension is the only type signal there is.
 * - A video's poster frame is stored at `<stem>_poster.jpg`, beside the video
 *   in the same media namespace (`poster_name_for` server-side). Every surface
 *   derives it from the video URL rather than storing a second reference, so
 *   the data model keeps ONE media field per item and a poster-less video
 *   (nothing captured one) degrades to a caption instead of a broken image.
 */

/** Extensions the backend serves as video (`media.py` → `VIDEO_EXTS`). */
const VIDEO_RE = /\.(mp4|m4v|mov|webm)(?:$|[?#])/i;

/** True when this URL (or bare filename) is a trip video. */
export function isVideoSrc(src: string | undefined | null): boolean {
  return typeof src === "string" && VIDEO_RE.test(src);
}

/** The poster-frame URL for a video URL/name — `…/<stem>_poster.jpg`.
 *
 * Derived, never stored: `<stem>` is the content-addressed name the server
 * assigned, so the poster inherits the video's unguessability. Returns
 * undefined for non-video sources so callers can branch on it. */
export function posterFor(src: string | undefined | null): string | undefined {
  if (!isVideoSrc(src)) return undefined;
  return (src as string).replace(/(\.[A-Za-z0-9]+)(?=$|[?#])/, "_poster.jpg");
}

/** The poster's own upload filename for a video name — `<stem>_poster.jpg`.
 *
 * Only a label: the SERVER derives the stored key from ``poster_of`` (#250),
 * so the client cannot name the object. Kept here so the naming rule has one
 * definition on this side too. */
export function posterNameFor(videoName: string): string {
  return posterFor(videoName) ?? "poster.jpg";
}

/** True when a MIME type (the upload response's `contentType`) is a video. */
export function isVideoType(mediaType: string | undefined | null): boolean {
  return typeof mediaType === "string" && mediaType.startsWith("video/");
}

/** Human-readable byte size ("1.2 MB", "840 kB"), or null when not known.
 *
 * Lives here so the attachment chip, the video chip and any future surface
 * spell size the same way — one formatter, not one per component. */
export function formatBytes(bytes: number | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Grab a still from a just-picked clip, to store as its poster frame (#250).
 *
 * Client-side on purpose: the alternative is transcoding server-side, which
 * means ffmpeg in the API image to produce one JPEG per clip. The browser has
 * already decoded the video it is about to play, so the frame costs nothing
 * extra and no new dependency.
 *
 * Loads the clip, seeks about a second in (frame 0 of a phone clip is often
 * black or mid-fade), draws it onto a canvas and encodes JPEG. Resolves null
 * on anything unexpected — a codec this browser cannot decode, a clip that
 * never becomes ready — because a video without a poster still plays, and a
 * poster is never worth failing the attach it belongs to.
 */
export async function capturePosterFrame(file: File | Blob): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  try {
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("cannot decode this video"));
      window.setTimeout(() => reject(new Error("video never became ready")), 5000);
    });
    // Seek only when there is something to seek to (a 0s clip, or a stream
    // whose duration is not known, draws frame 0 instead).
    const target = Number.isFinite(video.duration)
      ? Math.min(1, video.duration / 2)
      : 0;
    if (target > 0.05) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = target;
        window.setTimeout(resolve, 2000);
      });
    }
    const { videoWidth: width, videoHeight: height } = video;
    if (!width || !height) return null;
    // Cap the still on its long edge: it is a preview, and a full-resolution
    // frame would land a multi-MB "photo" in the media namespace.
    const scale = Math.min(1, 1280 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.82),
    );
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
