/**
 * Square-crop a profile photo client-side (issue #317).
 *
 * The preview renders the chosen file with `object-fit: cover` in a square
 * box plus a `scale(zoom)` transform; this module computes the matching
 * centered source square and draws it to a `size`×`size` canvas, exported
 * as JPEG. Cover + centered square is exactly what `object-fit: cover`
 * shows at zoom 1, so the bytes match the preview (WYSIWYG) — no
 * server-side crop, no new dependency. Panning is deliberately out of
 * scope for v1: center-crop + zoom only.
 */

export interface SourceSquare {
  sx: number;
  sy: number;
  side: number;
}

/** Centered source square for an image of `naturalWidth`×`naturalHeight`
 *  at `zoom` (≥1): the cover-fit square divided by the zoom, centered. */
export function avatarSourceSquare(
  naturalWidth: number,
  naturalHeight: number,
  zoom: number,
): SourceSquare {
  const z = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
  const base = Math.max(1, Math.min(naturalWidth, naturalHeight));
  const side = Math.max(1, base / z);
  return {
    sx: (naturalWidth - side) / 2,
    sy: (naturalHeight - side) / 2,
    side,
  };
}

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

/** Draw the zoomed center square onto `canvas` (resized to `size`) and
 *  export a JPEG blob. Throws a plain Error when the canvas has no 2d
 *  context or the encoder answers empty — the caller surfaces it as the
 *  upload error line, never a silent no-op. */
export async function cropAvatar(
  img: CroppableImage,
  zoom: number,
  canvas: CropCanvas,
  size = 512,
): Promise<Blob> {
  const { sx, sy, side } = avatarSourceSquare(
    img.naturalWidth,
    img.naturalHeight,
    zoom,
  );
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare that photo — try another file.");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
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
