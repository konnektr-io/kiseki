import { describe, expect, it } from "vitest";

/**
 * Where a cluster badge DRAWS (#402).
 *
 * A venue cluster inside a re-base town has its members' centroid ON that
 * town's numbered stop pin, and the stacking ladder (correctly, #388) keeps the
 * pin on top — so the count painted underneath and was unreadable. Measured live
 * on the Japan trip: badge "8" and pin "1" one pixel apart, with
 * `elementFromPoint` at the badge's centre returning the pin's 28px dot.
 *
 * This is the pure geometry of that offset, factored out of the component so it
 * is testable without a WebGL context — and, more importantly, so the two guards
 * that keep it safe are pinned:
 *
 *  1. **One coordinate space.** `map.project()` returns MAP-CONTAINER-relative
 *     coordinates; `getBoundingClientRect()` returns VIEWPORT-relative ones.
 *     Mixing them silently offsets every pin by where the map sits on the page.
 *     The reverted first attempt did exactly that, and the resulting nudge fired
 *     the wrong way and walked the badge off the map: `unproject` returned a
 *     latitude outside ±90, MapLibre threw on `setLngLat`, and the whole surface
 *     hit the error boundary. That crash is the reason these are pinned here.
 *  2. **Clamped, never off-map.** A nudge that leaves the container is the same
 *     crash by another route, so the result is clamped — and when the clamped
 *     position still does not clear the pin, the badge stays put. A badge under
 *     a pin is a cosmetic miss; a dead map is not.
 */

/** CLUSTER_PX from lib/marker-cluster.ts — the radius, and the nudge distance. */
const CLUSTER_PX = 44;

/** Mirror of `drawPosition` in RouteMap.tsx. */
function drawPosition(
  centroid: [number, number],
  pins: Array<[number, number]>,
  box: { w: number; h: number },
): [number, number] {
  const clamp = (x: number, y: number): [number, number] =>
    box.w > 0 && box.h > 0
      ? [
          Math.min(Math.max(x, CLUSTER_PX / 2), box.w - CLUSTER_PX / 2),
          Math.min(Math.max(y, CLUSTER_PX / 2), box.h - CLUSTER_PX / 2),
        ]
      : [x, y];
  let [x, y] = clamp(centroid[0], centroid[1]);
  for (const [px, py] of pins) {
    if (Math.hypot(x - px, y - py) >= CLUSTER_PX) continue;
    const d = Math.hypot(centroid[0] - px, centroid[1] - py);
    const angle = d < 1 ? -Math.PI / 2 : Math.atan2(centroid[1] - py, centroid[0] - px);
    const moved = clamp(
      px + Math.cos(angle) * CLUSTER_PX,
      py + Math.sin(angle) * CLUSTER_PX,
    );
    if (Math.hypot(moved[0] - px, moved[1] - py) >= CLUSTER_PX / 2) [x, y] = moved;
  }
  return [x, y];
}

const BOX = { w: 390, h: 380 };

describe("cluster badge placement (#402)", () => {
  it("leaves a cluster alone when it is not sitting on a pin", () => {
    // The common case, and every cluster on a sparse trip: nothing moves.
    expect(drawPosition([200, 150], [[40, 40]], BOX)).toEqual([200, 150]);
    expect(drawPosition([200, 150], [], BOX)).toEqual([200, 150]);
  });

  it("moves a badge off the pin it lands on", () => {
    // The live case: badge "8" centred on pin "1", one pixel apart.
    const [x, y] = drawPosition([195, 160], [[195, 160]], BOX);
    expect(Math.hypot(x - 195, y - 160)).toBeGreaterThanOrEqual(CLUSTER_PX / 2);
  });

  it("NEVER leaves the map — the crash guard", () => {
    // A pin in the corner: the naive nudge walks off the container, `unproject`
    // then yields a latitude outside ±90 and MapLibre throws on setLngLat. Every
    // result must stay inside, for pins at every edge and corner.
    const edges: Array<[number, number]> = [
      [0, 0], [BOX.w, 0], [0, BOX.h], [BOX.w, BOX.h],
      [0, BOX.h / 2], [BOX.w, BOX.h / 2], [BOX.w / 2, 0], [BOX.w / 2, BOX.h],
    ];
    for (const pin of edges) {
      const [x, y] = drawPosition([pin[0], pin[1]], [pin], BOX);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(BOX.w);
      expect(y).toBeLessThanOrEqual(BOX.h);
      // And it is a real position, not NaN — the other half of the crash.
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
  });

  it("clamps rather than nudging when the pin is too near an edge to clear", () => {
    // A pin hard against the top-left: any outward nudge is off-map, so the
    // badge stays at its clamped centroid instead of jumping or dying.
    const [x, y] = drawPosition([2, 2], [[2, 2]], BOX);
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it("tolerates an unmeasured map (0x0 box) without producing NaN", () => {
    // Before the container has a size there is nothing to clamp against, and the
    // guard must pass the coordinates through rather than divide by zero.
    const [x, y] = drawPosition([10, 10], [[10, 10]], { w: 0, h: 0 });
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });

  it("keeps the badge near the cluster it stands for, not in a fixed corner", () => {
    // The nudge follows the line from the pin, so two clusters in different
    // towns do not both end up in the same place.
    const left = drawPosition([195, 160], [[195, 160]], BOX);
    const right = drawPosition([195, 160], [[194, 160]], BOX);
    expect(Math.hypot(left[0] - right[0], left[1] - right[1])).toBeGreaterThan(1);
  });

  it("handles a cluster centred exactly on the pin (zero-length direction)", () => {
    // d === 0 makes atan2(0,0) undefined; the fallback direction must be finite.
    const [x, y] = drawPosition([100, 100], [[100, 100]], BOX);
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });
});
