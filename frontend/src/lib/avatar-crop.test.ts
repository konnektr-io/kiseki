/**
 * Square-crop geometry + the pan/zoom editor's maths (issues #317, #320) —
 * pure arithmetic, no DOM, so node-env vitest reaches it.
 *
 * Gates:
 * - zoom 1 on a landscape photo is the cover-fit centre square (the numbers
 *   the first version produced, kept as a regression anchor);
 * - the viewport is ALWAYS fully covered: for any pan/zoom the crop rect
 *   stays inside the photo and the photo stays at least viewport-sized;
 * - pan is clamped (a drag can never expose a blank corner), pan actually
 *   moves the crop window, and zoom keeps the viewport centre's photo point;
 * - `cropAvatar` draws that rect onto the canvas at the export size and
 *   resolves a JPEG blob; a missing 2d context rejects instead of uploading
 *   nothing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  centeredOffset,
  clampOffset,
  clampZoom,
  coverScale,
  cropAvatar,
  cropRect,
  displayedSize,
  zoomAbout,
  type CropCanvas,
  type CroppableImage,
} from "./avatar-crop";

const V = 256;

describe("coverScale / displayedSize", () => {
  it("zoom 1 covers the viewport on the long axis (landscape)", () => {
    const scale = coverScale(800, 600, V);
    expect(scale).toBeCloseTo(V / 600);
    const d = displayedSize(800, 600, V, 1);
    expect(d.width).toBeCloseTo(341.333, 2);
    expect(d.height).toBeCloseTo(V);
  });

  it("zoom is clamped to [1, 3] and non-finite input falls back to 1", () => {
    expect(clampZoom(0.4)).toBe(1);
    expect(clampZoom(9)).toBe(3);
    expect(clampZoom(NaN)).toBe(1);
    expect(displayedSize(800, 600, V, 0.4).height).toBeCloseTo(V);
  });

  it("degenerate dimensions never divide by zero", () => {
    const d = displayedSize(0, 0, V, 1);
    expect(d.width).toBe(V);
    expect(d.scale).toBe(V);
  });
});

describe("centeredOffset + cropRect", () => {
  it("zoom 1 on landscape is the cover-fit centre square", () => {
    const offset = centeredOffset(800, 600, V, 1);
    expect(offset.x).toBeCloseTo(-42.667, 2);
    expect(offset.y).toBeCloseTo(0, 5);
    const rect = cropRect(offset, 800, 600, V, 1);
    expect(rect.sx).toBeCloseTo(100, 5);
    expect(rect.sy).toBeCloseTo(0, 5);
    expect(rect.side).toBeCloseTo(600, 5);
  });

  it("zoom 2 halves the side around the same centre", () => {
    const offset = centeredOffset(800, 600, V, 2);
    const rect = cropRect(offset, 800, 600, V, 2);
    expect(rect.sx).toBeCloseTo(250, 5);
    expect(rect.sy).toBeCloseTo(150, 5);
    expect(rect.side).toBeCloseTo(300, 5);
  });
  it("portrait photos centre the other way", () => {
    const rect = cropRect(centeredOffset(600, 800, V, 1), 600, 800, V, 1);
    expect(rect.sx).toBeCloseTo(0, 5);
    expect(rect.sy).toBeCloseTo(100, 5);
    expect(rect.side).toBeCloseTo(600, 5);
  });
});

describe("pan clamping — the viewport is always fully covered", () => {
  it("a drag is bounded by the photo's own edges", () => {
    const d = displayedSize(800, 600, V, 1);
    // Drag far right / far down: the photo's left/top edge pins to the viewport.
    expect(clampOffset(999, 999, d.width, d.height, V)).toEqual({ x: 0, y: 0 });
    // Drag far left / up: the photo's right/bottom edge pins instead.
    const other = clampOffset(-9999, -9999, d.width, d.height, V);
    expect(other.x).toBeCloseTo(V - d.width, 5);
    expect(other.y).toBeCloseTo(V - d.height, 5);
  });

  it("a square photo cannot be panned at zoom 1 (it exactly fills)", () => {
    const d = displayedSize(600, 600, V, 1);
    expect(clampOffset(-100, -100, d.width, d.height, V)).toEqual({ x: 0, y: 0 });
  });

  it("for any pan/zoom the crop rect stays inside the photo and covers the viewport", () => {
    const cases = [
      { w: 800, h: 600 },
      { w: 600, h: 800 },
      { w: 1600, h: 900 },
    ];
    for (const { w, h } of cases) {
      for (const zoom of [1, 1.5, 2.4, 3]) {
        const d = displayedSize(w, h, V, zoom);
        for (const [ox, oy] of [
          [0, 0],
          [-999, -999],
          [-37.5, -12.25],
          [42, -13],
        ]) {
          const offset = clampOffset(ox, oy, d.width, d.height, V);
          const rect = cropRect(offset, w, h, V, zoom);
          expect(rect.sx).toBeGreaterThanOrEqual(-1e-6);
          expect(rect.sy).toBeGreaterThanOrEqual(-1e-6);
          expect(rect.sx + rect.side).toBeLessThanOrEqual(w + 1e-6);
          expect(rect.sy + rect.side).toBeLessThanOrEqual(h + 1e-6);
          // A full square viewport's worth of photo is on screen.
          expect(rect.side).toBeGreaterThan(0);
          expect(rect.side * d.scale).toBeCloseTo(V, 6);
        }
      }
    }
  });

  it("panning really moves the crop window (the #320 defect: it could not)", () => {
    const centred = cropRect(centeredOffset(800, 600, V, 2), 800, 600, V, 2);
    const d = displayedSize(800, 600, V, 2);
    // Drag the photo up → the crop window moves down the photo.
    const up = cropRect(clampOffset(0, -999, d.width, d.height, V), 800, 600, V, 2);
    expect(up.sy).toBeGreaterThan(centred.sy + 10);
    // Drag it right → the crop window moves left, all the way to the edge.
    const right = cropRect(clampOffset(999, 0, d.width, d.height, V), 800, 600, V, 2);
    expect(centred.sx).toBeGreaterThan(right.sx);
    expect(right.sx).toBeCloseTo(0, 5);
  });
});

describe("zoomAbout", () => {
  it("keeps the photo point under the viewport centre", () => {
    const before = centeredOffset(800, 600, V, 1);
    const after = zoomAbout(before, 800, 600, V, 1, 2);
    // Both rects centre on the same photo point (400, 300).
    const r1 = cropRect(before, 800, 600, V, 1);
    const r2 = cropRect(after, 800, 600, V, 2);
    expect(r1.sx + r1.side / 2).toBeCloseTo(r2.sx + r2.side / 2, 5);
    expect(r1.sy + r1.side / 2).toBeCloseTo(r2.sy + r2.side / 2, 5);
  });

  it("a panned view stays on the same point when zooming", () => {
    const d1 = displayedSize(800, 600, V, 1);
    const panned = clampOffset(-80, 0, d1.width, d1.height, V);
    const zoomed = zoomAbout(panned, 800, 600, V, 1, 2);
    const r1 = cropRect(panned, 800, 600, V, 1);
    const r2 = cropRect(zoomed, 800, 600, V, 2);
    expect(r1.sx + r1.side / 2).toBeCloseTo(r2.sx + r2.side / 2, 5);
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

  it("draws the crop rect at the export size and resolves the blob", async () => {
    const { canvas, drawImage } = stubCanvas();
    const rect = cropRect(centeredOffset(800, 600, V, 2), 800, 600, V, 2);
    const blob = await cropAvatar(img, rect, canvas, 512);
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    expect(drawImage).toHaveBeenCalledTimes(1);
    const [, sx, sy, side] = drawImage.mock.calls[0];
    expect(sx).toBeCloseTo(250, 5);
    expect(sy).toBeCloseTo(150, 5);
    expect(side).toBeCloseTo(300, 5);
    expect(drawImage.mock.calls[0].slice(5)).toEqual([0, 0, 512, 512]);
    expect(blob).toBeInstanceOf(Blob);
  });

  it("a missing 2d context rejects instead of uploading nothing", async () => {
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as CropCanvas;
    await expect(cropAvatar(img, { sx: 0, sy: 0, side: 600 }, canvas)).rejects.toThrow(
      /prepare that photo/,
    );
  });
});
