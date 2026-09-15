import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { isVideoSrc, posterFor } from "../lib/media";

/** Photo rendering for decision A+B (#190/#191, DESIGN.md §9).
 *
 * One shared image component for both mechanisms — the strip on a block
 * card (A, `Block.images` now N) and the day's `gallery` block (B) — so a
 * photo looks identical wherever it lands and captions stay per-image:
 *
 * - Fixed `aspect-[4/3]` box + `object-cover`, always (no intrinsic-size
 *   images — CLS on a photo-heavy mobile page is brutal).
 * - `loading="lazy"` on every photo (the cover is the only eager image).
 * - Text over an image always gets the scrim gradient, never drop-shadow.
 * - Galleries are 2-up mobile / 3-up desktop with a consistent gap —
 *   no masonry (masonry breaks print).
 *
 * Print caps are STATED here, not left to the browser (DESIGN.md §12):
 * the strip prints the first STRIP_PRINT_COUNT photos, the gallery the
 * first GALLERY_PRINT_COUNT, each followed by a "+N more in the online
 * album" line. Lightbox + overflow buttons are `no-print` chrome.
 *
 * Videos (#250) are the same slot with different chrome: a clip in a block's
 * `images` plays inline in its own cell instead of opening the lightbox, and
 * in print it becomes its poster plus a link. One dispatcher decides, so no
 * surface has to ask what it is holding.
 */

export const STRIP_SCREEN_COUNT = 4;
export const STRIP_PRINT_COUNT = 4;
export const GALLERY_PRINT_COUNT = 6;

/** One trip photo — the shared atom (mirrors the PlaceFacts figure pattern,
 *  #95: figure + cover img + credit only when present). */
export function TripPhoto({
  src,
  alt,
  credit,
  className = "",
}: {
  src: string;
  alt: string;
  credit?: string;
  className?: string;
}) {
  return (
    <figure className={`overflow-hidden rounded-lg border border-border ${className}`}>
      <img src={src} alt={alt} loading="lazy" className="aspect-[4/3] w-full object-cover" />
      {credit && (
        <figcaption className="px-2 py-1 text-right text-[11px] text-muted-foreground">
          {credit}
        </figcaption>
      )}
    </figure>
  );
}

/** One trip video — the moving sibling of TripPhoto (#250).
 *
 * Plays in place, with the poster the composer captured when the clip was
 * attached: `<stem>_poster.jpg`, stored beside the clip and derived from its
 * URL (`lib/media.ts`) — no second reference in the model, nothing to keep in
 * sync, and a video the agent attached straight through the write API simply
 * has no poster and falls back to the first frame the browser decodes.
 *
 * Print gets the poster plus a LINK, never the player (#250, stated in the
 * issue): a booklet page cannot play a clip, and a black rectangle where the
 * memory was is worse than a pointer to it.
 */
export function TripVideo({
  src,
  alt,
  className = "",
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <figure className={`overflow-hidden rounded-lg border border-border ${className}`}>
      <video
        src={src}
        poster={posterFor(src)}
        controls
        playsInline
        preload="metadata"
        aria-label={alt}
        className="no-print aspect-[4/3] w-full bg-black object-cover"
      />
      <figcaption className="hidden gap-2 px-2 py-1 text-[11px] text-muted-foreground print:flex">
        {/* A clip with no poster frame must not print a broken-image glyph —
            the link below still points at it either way. */}
        <img
          src={posterFor(src)}
          alt=""
          className="aspect-[4/3] w-1/3 rounded object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
        <a href={src} className="self-center underline underline-offset-2">
          Watch the video online
        </a>
      </figcaption>
    </figure>
  );
}

/** Trip media in one slot: a photo or a video, decided by the file name. */
export function TripMedia({
  src,
  alt,
  className = "",
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return isVideoSrc(src) ? (
    <TripVideo src={src} alt={alt} className={className} />
  ) : (
    <TripPhoto src={src} alt={alt} className={className} />
  );
}

/** Screen-only lightbox dialog (chrome — `no-print`, never in the booklet). */
export function PhotoLightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const prev = useCallback(() => onIndex((index - 1 + images.length) % images.length), [index, images.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % images.length), [index, images.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next]);

  const btn =
    "inline-flex h-11 w-11 items-center justify-center rounded-full bg-background/85 text-foreground backdrop-blur-md border border-border/60 shadow-[0_2px_12px_rgb(0_0_0/0.12)] focus-visible:focus-ring";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${index + 1} of ${images.length}`}
      className="no-print fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div className="relative max-h-full w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <img
          src={images[index]}
          alt={`Photo ${index + 1} of ${images.length}`}
          className="max-h-[80dvh] w-full rounded-lg object-contain"
        />
        <div className="mt-3 flex items-center justify-center gap-2">
          <button type="button" className={btn} onClick={prev} aria-label="Previous photo">
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <span className="min-w-16 text-center text-sm text-white tabular-nums" aria-live="polite">
            {index + 1} / {images.length}
          </span>
          <button type="button" className={btn} onClick={next} aria-label="Next photo">
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
          <button type="button" className={btn} onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Photo strip on a block card (decision A): N photos, screen-capped with a
 *  +N affordance into the lightbox; print-capped with an album line. */
export function PhotoStrip({ images, alt }: { images: string[]; alt: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!images.length) return null;
  const visible = images.slice(0, STRIP_SCREEN_COUNT);
  const overflow = images.length - visible.length;
  const printExtra = images.length - STRIP_PRINT_COUNT;
  // The lightbox walks photos only: a clip plays in its own cell (#250).
  const photos = images.filter((src) => !isVideoSrc(src));

  return (
    <div className="mb-3">
      <div className={`grid gap-2 ${visible.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {visible.map((src, i) => {
          const isOverflowCell = overflow > 0 && i === visible.length - 1;
          const countBadge = isOverflowCell ? (
            <span className="pointer-events-none absolute inset-0 grid place-items-center bg-gradient-to-t from-black/85 via-black/25 to-transparent">
              <span className="font-heading text-2xl font-semibold text-white tabular-nums">
                +{overflow}
              </span>
            </span>
          ) : null;
          // A clip keeps its own cell and its own controls: opening a
          // lightbox over a playing video helps nobody (#250).
          if (isVideoSrc(src)) {
            return (
              <div key={src} className="no-print relative">
                <TripVideo src={src} alt={alt} />
                {countBadge}
              </div>
            );
          }
          const photoIndex = photos.indexOf(src);
          return (
            <button
              key={src}
              type="button"
              onClick={() => setOpen(photoIndex)}
              aria-label={
                isOverflowCell
                  ? `Show all ${images.length} photos`
                  : `Open photo ${photoIndex + 1} of ${photos.length}`
              }
              className="no-print relative overflow-hidden rounded-lg border border-border text-left focus-visible:focus-ring"
            >
              <img
                src={src}
                alt={isOverflowCell ? "" : alt}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
              {countBadge}
            </button>
          );
        })}
        {/* Print takes the stated cap as plain figures (buttons never print);
            beyond-cap photos get no print node at all — they print nothing. */}
        {images.slice(0, STRIP_PRINT_COUNT).map((src) => (
          <TripMedia key={`p-${src}`} src={src} alt={alt} className="hidden print:block" />
        ))}
      </div>
      {printExtra > 0 && (
        <p className="mt-1 hidden text-xs text-muted-foreground print:block">
          +{printExtra} more in the online album
        </p>
      )}
      {open !== null && (
        <PhotoLightbox images={photos} index={open} onClose={() => setOpen(null)} onIndex={setOpen} />
      )}
    </div>
  );
}

/** Day photo card (decision B): the `gallery` block at its chronological
 *  position — full grid on screen, stated cap + album line in print. */
export function PhotoGallery({ items, title }: { items: string[]; title?: string }) {
  if (!items.length) return null;
  const printExtra = items.length - GALLERY_PRINT_COUNT;
  return (
    <div>
      {title && <h4 className="kicker mb-2">{title}</h4>}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {items.map((src, i) => (
          // TripMedia, not TripPhoto: a clip in the gallery plays in place
          // (#250) — a <video> URL in an <img> renders nothing at all.
          <TripMedia
            key={src}
            src={src}
            alt=""
            className={i >= GALLERY_PRINT_COUNT ? "print:hidden" : ""}
          />
        ))}
      </div>
      {printExtra > 0 && (
        <p className="mt-1 hidden text-xs text-muted-foreground print:block">
          +{printExtra} more in the online album
        </p>
      )}
    </div>
  );
}
