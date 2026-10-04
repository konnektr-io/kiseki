import { describe, expect, it } from "vitest";

/**
 * Can a cluster be drawn without lying about where it is? (#403)
 *
 * Niko's report (2026-10-04, Chili+Peru): the badge counting Lima's nine
 * activities drew next to Ica. Those places are not one spot — they span
 * **11.6 km** (Magisch Watercircuit 2.9 km north-east of the Lima pin, Pan Sal
 * Aire 11.6 km south), so their centroid sits **7.45 km** from Lima. At journey
 * zoom that is a few pixels and nobody notices; by z10 the same offset is 45px
 * and the badge reads as a town of its own.
 *
 * A centroid is only an honest position while the members are close enough
 * together, on THIS screen, for the middle of them to mean "here". The test is
 * therefore the members' own on-screen spread against the same 44px radius that
 * decided to cluster them: if they do not fit inside one cluster's worth of
 * pixels, they are not one place on this screen, and the honest answer is to
 * draw nothing until the traveler zooms in far enough for it to be.
 */

/** CLUSTER_PX from lib/marker-cluster.ts. */
const CLUSTER_PX = 44;

/** Mirror of `clusterIsHonest` in RouteMap.tsx. */
function clusterIsHonest(points: Array<[number, number]>): boolean {
  if (points.length < 2) return true;
  let widest = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      widest = Math.max(widest, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]));
    }
  }
  return widest <= CLUSTER_PX;
}

describe("cluster honesty (#403)", () => {
  it("draws a genuinely tight cluster", () => {
    // Revelstoke's venues: within a few px of each other at journey zoom.
    const tight: Array<[number, number]> = [[100, 100], [103, 102], [98, 105], [104, 99]];
    expect(clusterIsHonest(tight)).toBe(true);
  });

  it("HIDES a cluster whose members spread wider than the radius", () => {
    // Lima's nine venues at z10, in the real pixels: Magisch Watercircuit
    // 2.9 km NE of the pin and Pan Sal Aire 11.6 km S, which at that zoom is
    // ~5px and ~18px — and the outermost pair is 77px apart. That is wider than
    // the 44px radius that formed the cluster, so the centroid is not a place.
    const lima: Array<[number, number]> = [[195, 160], [200, 162], [185, 159], [272, 178]];
    expect(clusterIsHonest(lima)).toBe(false);
  });

  it("the boundary is the cluster radius itself", () => {
    const inside: Array<[number, number]> = [[0, 0], [CLUSTER_PX, 0]];
    const outside: Array<[number, number]> = [[0, 0], [CLUSTER_PX + 1, 0]];
    expect(clusterIsHonest(inside)).toBe(true);
    expect(clusterIsHonest(outside)).toBe(false);
  });

  it("measures the WIDEST pair, not the average or the first pair", () => {
    // A tight pair with one far outlier: averaging would hide it, and the
    // outlier is exactly the place that would be misplaced by the centroid.
    const withOutlier: Array<[number, number]> = [[100, 100], [102, 101], [400, 400]];
    expect(clusterIsHonest(withOutlier)).toBe(false);
    // Order must not matter either.
    const reordered: Array<[number, number]> = [[400, 400], [100, 100], [102, 101]];
    expect(clusterIsHonest(reordered)).toBe(false);
  });

  it("always draws a single-member cluster (nothing to disagree about)", () => {
    const one: Array<[number, number]> = [[10, 10]];
    expect(clusterIsHonest(one)).toBe(true);
    expect(clusterIsHonest([])).toBe(true);
  });

  it("reads Lima's nine venues at the real cameras, in real pixels", () => {
    // Measured from the live trip, not invented: those places span 11.57 km, and
    // at latitude -12 one screen pixel is 156543*cos(-12)/2^z metres. So their
    // on-screen width is 11.57 km expressed in px at each zoom.
    const spanKm = 11.57;
    const kmToPx = (z: number) => (spanKm * 1000) / (156543.03392 * Math.cos((-12 * Math.PI) / 180) / 2 ** z);
    // Wide: the members are a few px apart, so the centroid IS "here" and the
    // badge is honest — even though in kilometres it is 11.6 km wide.
    expect(clusterIsHonest(line(kmToPx(6)))).toBe(true);   // 5px
    expect(clusterIsHonest(line(kmToPx(9)))).toBe(true);   // 39px
    // Deep: past z9 the same places spread past a pin's width, the centroid
    // stops meaning anywhere, and the badge would sit 50px from Lima reading as
    // its own town. Hide it.
    expect(clusterIsHonest(line(kmToPx(10)))).toBe(false); // 77px
    expect(clusterIsHonest(line(kmToPx(12)))).toBe(false); // 310px
    /** Two places `width` px apart on screen. */
    function line(width: number): Array<[number, number]> {
      const pair: Array<[number, number]> = [[0, 0], [width, 0]];
      return pair;
    }
  });

  it("is the same rule at every zoom — no threshold, no magic number", () => {
    // The point of measuring spread instead of gating on a zoom constant: it
    // needs no re-tuning per trip. A dense city cluster is honest at z15 and a
    // country-spanning one is not at z6, and both fall out of the same test.
    const tight: Array<[number, number]> = [[100, 100], [112, 108], [95, 104]];   // 17px
    const spread: Array<[number, number]> = [[100, 100], [260, 100], [100, 240]]; // 160px
    expect(clusterIsHonest(tight)).toBe(true);
    expect(clusterIsHonest(spread)).toBe(false);
  });
});


describe("the numbers the Peru probe measured", () => {
  it("rejects the spreads the real journey-zoom probe recorded", () => {
    // z3.13: (21 venues, 203px) (9, 160px) (11, 411px) — all dishonest.
    expect(clusterIsHonest([[0, 0], [203, 0]])).toBe(false);
    expect(clusterIsHonest([[0, 0], [160, 0]])).toBe(false);
    expect(clusterIsHonest([[0, 0], [411, 0]])).toBe(false);
  });

  it("would accept them only if the radius were larger than the spread", () => {
    // Sanity on the constant: 411px is over 9x CLUSTER_PX.
    expect(CLUSTER_PX).toBe(44);
  });
});
