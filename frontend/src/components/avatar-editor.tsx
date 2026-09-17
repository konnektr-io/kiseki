import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "./ui";
import {
  centeredOffset,
  clampOffset,
  clampZoom,
  cropAvatar,
  cropRect,
  displayedSize,
  zoomAbout,
  type CropCanvas,
  type Offset,
} from "../lib/avatar-crop";

/**
 * The profile-photo editor (issues #317, #320): pick a photo → pan + zoom it
 * inside a FIXED SQUARE viewport → the square is what gets stored.
 *
 * #320 fixed two defects of the first cut: the preview was an `<img>` scaled
 * by a CSS transform in no clipping box (any zoom spilled the photo over the
 * page), and there was no pan, so a face at the frame's edge could never be
 * brought into the square. Here the viewport is `overflow-hidden` at a fixed
 * size and the photo is positioned in px (not scaled by a transform), so the
 * pixels the maths computes are the pixels on screen.
 *
 * The component never talks to the API: it hands the parent a cropped JPEG
 * blob, and the parent owns the request, the busy flag and the error line.
 */

/** The square the user crops into — ONE constant, read by both the render and
 *  the crop maths, so the stored photo is exactly what was on screen. */
export const AVATAR_VIEWPORT = 256;
/** Stored photo size (square, JPEG). */
const EXPORT_SIZE = 512;

export function AvatarEditor({
  file,
  hasPhoto,
  busy,
  error,
  onUpload,
  onRemove,
  onClose,
}: {
  /** The freshly picked file to crop (the dialog's whole reason to exist). */
  file: File;
  /** Whether the profile already has a photo → offers "Remove photo". */
  hasPhoto: boolean;
  /** A request is in flight: every control is inert. */
  busy: boolean;
  /** Upload/remove failure from the parent, rendered under the preview. */
  error: string | null;
  onUpload: (blob: Blob) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; offset: Offset } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Object URL for the picked file; revoked when the file (or dialog) goes.
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Escape closes — unless a request is in flight (never lose a save mid-air).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const displayed = dims ? displayedSize(dims.w, dims.h, AVATAR_VIEWPORT, zoom) : null;

  const onImageLoad = (el: HTMLImageElement) => {
    const next = { w: el.naturalWidth || 1, h: el.naturalHeight || 1 };
    setDims(next);
    setOffset(centeredOffset(next.w, next.h, AVATAR_VIEWPORT, zoom));
  };

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || !dims) return;
    dragRef.current = { pointerX: e.clientX, pointerY: e.clientY, offset };
    setDragging(true);
    try {
      // jsdom (and older browsers) do not implement pointer capture: losing it
      // is harmless, throwing mid-drag is not.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is an optimisation, never a requirement */
    }
  };

  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !dims) return;
    const d = displayedSize(dims.w, dims.h, AVATAR_VIEWPORT, zoom);
    setOffset(
      clampOffset(
        drag.offset.x + (e.clientX - drag.pointerX),
        drag.offset.y + (e.clientY - drag.pointerY),
        d.width,
        d.height,
        AVATAR_VIEWPORT,
      ),
    );
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* see startDrag */
    }
  };

  const changeZoom = (next: number) => {
    const z = clampZoom(next);
    if (dims) {
      // Keep the point under the viewport centre put — zooming must not throw
      // away the pan the user just chose.
      setOffset(zoomAbout(offset, dims.w, dims.h, AVATAR_VIEWPORT, zoom, z));
    }
    setZoom(z);
  };

  const save = async () => {
    const img = imgRef.current;
    if (!img || !dims || busy) return;
    setCropError(null);
    try {
      const rect = cropRect(offset, dims.w, dims.h, AVATAR_VIEWPORT, zoom);
      const blob = await cropAvatar(
        img,
        rect,
        document.createElement("canvas") as unknown as CropCanvas,
        EXPORT_SIZE,
      );
      onUpload(blob);
    } catch (e) {
      setCropError(e instanceof Error ? e.message : "Couldn't prepare that photo.");
    }
  };

  const shownError = cropError ?? error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-editor-title"
        className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-xl"
      >
        <h2
          id="avatar-editor-title"
          ref={headingRef}
          tabIndex={-1}
          className="font-heading text-lg font-semibold focus-visible:outline-none"
        >
          Profile photo
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Drag the photo to move it, slide to zoom. The square is what gets saved.
        </p>

        <div className="mt-3 flex justify-center">
          <div
            data-testid="avatar-viewport"
            data-dragging={dragging ? "true" : "false"}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="relative touch-none overflow-hidden rounded-xl bg-muted"
            style={{
              width: AVATAR_VIEWPORT,
              height: AVATAR_VIEWPORT,
              cursor: dragging ? "grabbing" : "grab",
            }}
          >
            {url ? (
              <img
                ref={imgRef}
                src={url}
                alt=""
                draggable={false}
                onLoad={(e) => onImageLoad(e.currentTarget)}
                data-testid="avatar-photo"
                className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
                style={
                  displayed
                    ? {
                        width: displayed.width,
                        height: displayed.height,
                        transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
                      }
                    : { width: 0, height: 0 }
                }
              />
            ) : null}
          </div>
        </div>

        <label htmlFor="avatar-zoom" className="mt-3 block text-xs font-medium text-muted-foreground">
          Zoom
        </label>
        <input
          id="avatar-zoom"
          type="range"
          min={1}
          max={3}
          step={0.05}
          value={zoom}
          disabled={busy}
          onChange={(e) => changeZoom(Number(e.target.value))}
          className="mt-1 w-full"
        />

        {shownError && (
          <p role="alert" className="mt-2 text-xs font-medium text-destructive">
            {shownError}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="accent"
            size="sm"
            onClick={() => void save()}
            disabled={busy || !dims}
            className="min-h-[44px]"
          >
            {busy ? "Uploading…" : "Save photo"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px]"
          >
            Cancel
          </Button>
          {hasPhoto && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              disabled={busy}
              className="ml-auto min-h-[44px] text-destructive hover:text-destructive"
            >
              Remove photo
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
