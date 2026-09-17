/**
 * Square-crop geometry for profile photos (issue #317) — pure arithmetic,
 * no DOM, so node-env vitest reaches it.
 *
 * Gates:
 * - zoom 1 on a landscape photo is the cover-fit center square;
 * - zooming divides the side around the same center (WYSIWYG with the
 *   `object-fit: cover` + `scale(zoom)` preview);
 * - portrait photos and degenerate inputs stay centered and non-empty;
 * - `cropAvatar` draws exactly that square onto the canvas and exports a
 *   JPEG blob (stub canvas/context — jsdom has no 2d context).
 */
import { describe, expect, it, vi } from "vitest";
import {
  avatarSourceSquare,
  cropAvatar,
  type CropCanvas,
  type CroppableImage,
} from "./avatar-crop";

describe("avatarSourceSquare", () => {
  it("zoom 1 on landscape is the cover-fit center square", () => {
    expect(avatarSourceSquare(800, 600, 1)).toEqual({ sx: 100, sy: 0, side: 600 });
  });

  it("zoom 2 halves the side around the same center", () => {
    expect(avatarSourceSquare(800, 600, 2)).toEqual({ sx: 250, sy: 150, side: 300 });
  });

  it("portrait photos center the other way", () => {
    expect(avatarSourceSquare(600, 800, 1)).toEqual({ sx: 0, sy: 100, side: 600 });
  });

  it("degenerate zoom clamps to 1 and the side never empties", () => {
    expect(avatarSourceSquare(800, 600, 0)).toEqual({ sx: 100, sy: 0, side: 600 });
    expect(avatarSourceSquare(800, 600, NaN)).toEqual({ sx: 100, sy: 0, side: 600 });
    const tiny = avatarSourceSquare(800, 600, 10_000);
    expect(tiny.side).toBeGreaterThan(0);
    expect(tiny.sx).toBeCloseTo((800 - tiny.side) / 2);
  });
});

describe("cropAvatar", () => {
  const img = { naturalWidth: 800, naturalHeight: 600 } as CroppableImage;

  function stubCanvas() {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn(
        (cb: (b: Blob | null) => void) => cb(new Blob(["x"], { type: "image/jpeg" })),
      ),
    } as unknown as CropCanvas & {
      toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number): void;
    };
    return { canvas, drawImage };
  }

  it("draws the zoomed square at the export size and resolves the blob", async () => {
    const { canvas, drawImage } = stubCanvas();
    const blob = await cropAvatar(img, 2, canvas, 512);
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(img, 250, 150, 300, 300, 0, 0, 512, 512);
    expect(blob).toBeInstanceOf(Blob);
  });

  it("a missing 2d context rejects instead of uploading nothing", async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as CropCanvas;
    await expect(cropAvatar(img, 1, canvas)).rejects.toThrow(/prepare that photo/);
  });
});
