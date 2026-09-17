/**
 * Square-crop geometry for profile photos (issues #317, #320) — pure
 * arithmetic, no DOM, so node-env vitest reaches it.
 *
 * The editor renders a FIXED square viewport (`viewport` px) with
 * `overflow-hidden`, and positions the photo inside it as an absolutely
 * positioned element of `displayedSize(...)` px offset by `Offset`. The user
 * drags to pan and slides to zoom; `cropRect` turns that on-screen state into
 * the source rectangle to draw, so the stored photo is exactly what the
 * viewport showed (WYSIWYG).
 *
 * #320 fixed the first version of this: it scaled the <img> with a CSS
 * `transform` inside NO clipping box (so any zoom spilled the photo over the
 * page) and had no pan at all (so a subject at the edge of the frame could
 * never be brought into the square). Clipping lives in the component; the
 * clamp here is what makes the viewport always fully covered by the photo —
 * no blank corners, ever.
 */

export interface Displayed {
  /** On-screen size of the whole photo, in CSS px. */
  width: number;
  height: number;
  /** Photo pixels → screen px factor (= coverScale × zoom). */
  scale: number;
}

export interface Offset {
  /** Photo's top-left, relative to the viewport's top-left. Always ≤ 0. */
  x: number;
  y: number;
}

export interface CropRect {
  sx: number;
  sy: number;
  /** Source square side, in PHOTO pixels. */
  side: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

/** Zoom is clamped to [1, 3]: below 1 the photo would not cover the
 *  viewport (blank corners), above 3 it is a pixel hunt. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Photo pixels → screen factor at zoom 1: the smallest scale at which the
 *  photo still covers the square viewport (CSS `object-fit: cover`). */
export function coverScale(naturalWidth: number, naturalHeight: number, viewport: number): number {
  const w = Math.max(1, naturalWidth);
  const h = Math.max(1, naturalHeight);
  return Math.max(viewport / w, viewport / h);
}

export function displayedSize(
  naturalWidth: number,
  naturalHeight: number,
  viewport: number,
  zoom: number,
): Displayed {
  const scale = coverScale(naturalWidth, naturalHeight, viewport) * clampZoom(zoom);
  return { width: Math.max(1, naturalWidth) * scale, height: Math.max(1, naturalHeight) * scale, scale };
}

/** Clamp a pan so the photo still covers the viewport on both axes. */
export function clampOffset(
  x: number,
  y: number,
  dispWidth: number,
  dispHeight: number,
  viewport: number,
): Offset {
  const loX = Math.min(0, viewport - dispWidth);
  const loY = Math.min(0, viewport - dispHeight);
  return {
    x: Math.min(0, Math.max(loX, Number.isFinite(x) ? x : 0)),
    y: Math.min(0, Math.max(loY, Number.isFinite(y) ? y : 0)),
  };
}

/** The starting pan: the photo centred in the viewport (what the old
 *  zoom-only control could only ever do). */
export function centeredOffset(
  naturalWidth: number,
  naturalHeight: number,
  viewport: number,
  zoom: number,
): Offset {
  const d = displayedSize(naturalWidth, naturalHeight, viewport, zoom);
  return clampOffset((viewport - d.width) / 2, (viewport - d.height) / 2, d.width, d.height, viewport);
}

/** The source square the viewport currently shows. */
export function cropRect(
  offset: Offset,
  naturalWidth: number,
  naturalHeight: number,
  viewport: number,
  zoom: number,
): CropRect {
  const d = displayedSize(naturalWidth, naturalHeight, viewport, zoom);
  const side = Math.min(viewport / d.scale, Math.min(naturalWidth, naturalHeight));
  const maxSx = Math.max(0, naturalWidth - side);
  const maxSy = Math.max(0, naturalHeight - side);
  return {
    sx: Math.min(maxSx, Math.max(0, -offset.x / d.scale)),
    sy: Math.min(maxSy, Math.max(0, -offset.y / d.scale)),
    side,
  };
}

/** Re-zoom while keeping whatever the viewport currently shows centred on
 *  the SAME point of the photo (zoom-about-centre), then re-clamp. */
export function zoomAbout(
  offset: Offset,
  naturalWidth: number,
  naturalHeight: number,
  viewport: number,
  fromZoom: number,
  toZoom: number,
): Offset {
  const from = displayedSize(naturalWidth, naturalHeight, viewport, fromZoom);
  const to = displayedSize(naturalWidth, naturalHeight, viewport, toZoom);
  const centre = viewport / 2;
  // Photo-space point under the viewport centre before the zoom change.
  const ux = (centre - offset.x) / from.scale;
  const uy = (centre - offset.y) / from.scale;
  return clampOffset(centre - ux * to.scale, centre - uy * to.scale, to.width, to.height, viewport);
}

/* ------------------------------------------------------------- drawing ---- */

export interface CroppableImage {
  naturalWidth: number;
  naturalHeight: number;
}

export interface CropCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): CropContext | null;
}

export interface CropContext {
  drawImage(
    image: CroppableImage,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** Draw the cropped square onto `canvas` (resized to `size`×`size`) and
 *  export a JPEG blob. Throws a plain Error when the canvas has no 2d
 *  context or the encoder answers empty — the caller surfaces it as the
 *  upload error line, never a silent no-op. */
export async function cropAvatar(
  img: CroppableImage,
  rect: CropRect,
  canvas: CropCanvas,
  size = 512,
): Promise<Blob> {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare that photo — try another file.");
  ctx.drawImage(img, rect.sx, rect.sy, rect.side, rect.side, 0, 0, size, size);
  const toBlob = (canvas as unknown as {
    toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number): void;
  }).toBlob;
  if (typeof toBlob !== "function") {
    throw new Error("Couldn't prepare that photo — try another file.");
  }
  return new Promise<Blob>((resolve, reject) => {
    toBlob.call(canvas, (blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't prepare that photo — try another file."));
    }, "image/jpeg", 0.9);
  });
}
