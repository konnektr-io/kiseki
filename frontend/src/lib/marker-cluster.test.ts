import { describe, expect, it } from "vitest";
import { CLUSTER_PX, clusterMarkers, type ProjectedPin } from "./marker-cluster";

/**
 * Screen-space clustering (#398) — the rule DESIGN.md §8.3 has specified since
 * the marker system was written and the trip map never implemented.
 *
 * The v0.92.0 open finding is the shape of the bug: Revelstoke's six excursion
 * diamonds sat ~4px apart, so five of six could neither be tapped nor read. A
 * count badge is the honest drawing. The rule used to live in
 * `lib/home-geo.ts` for the signed-in home only; it moved here so both surfaces
 * share one answer.
 */
describe("clusterMarkers (#398)", () => {
  const pin = (dtId: string, x: number, y: number): ProjectedPin => ({ dtId, x, y });

  it("leaves distant markers alone", () => {
    const out = clusterMarkers([pin("a", 0, 0), pin("b", 400, 0)], CLUSTER_PX);
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.kind === "pin")).toBe(true);
  });

  it("groups colliding markers into ONE count, keyed by membership", () => {
    // The v0.92.0 shape: six venues within a few pixels of each other.
    const tight = ["a", "b", "c", "d", "e", "f"].map((id, i) => pin(id, i * 2, i % 2));
    const out = clusterMarkers(tight, CLUSTER_PX);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("cluster");
    if (out[0].kind !== "cluster") return;
    // A COUNT, never a number range (§8.3) — the badge reads "6".
    expect(out[0].cluster.memberDtIds).toHaveLength(6);
    // Keyed by SORTED membership: the same geometry produces the same identity
    // regardless of input order, so a marker element can be reused across frames.
    expect(out[0].cluster.key).toBe("a+b+c+d+e+f");
  });

  it("never emits a cluster of one", () => {
    const one = clusterMarkers([pin("solo", 10, 10)], CLUSTER_PX);
    expect(one).toHaveLength(1);
    expect(one[0].kind).toBe("pin");
  });

  it("is stable for the SAME input order, and a cluster's key is its sorted membership", () => {
    // The rule is deterministic for a fixed input order, and a group's identity
    // is its sorted membership — so the same geometry yields the same cluster
    // KEY even when the grouping walk differs. That is what lets a badge element
    // be reused across frames.
    //
    // It is deliberately NOT order-independent: greedy seeding means input order
    // decides WHO seeds a group, and that is pre-existing behaviour carried over
    // from the home map (verified against the original implementation). Pin it
    // here so a future "make it order-independent" is a deliberate change rather
    // than an accident — and so nobody reads this as a stability guarantee it
    // does not give.
    const input = [pin("a", 0, 0), pin("b", 5, 0), pin("c", 300, 0)];
    expect(clusterMarkers(input, CLUSTER_PX)).toEqual(clusterMarkers(input, CLUSTER_PX));
    const key = (pts: ProjectedPin[]) => {
      const out = clusterMarkers(pts, CLUSTER_PX);
      const c = out.find((i) => i.kind === "cluster");
      return c && c.kind === "cluster" ? c.cluster.key : null;
    };
    expect(key(input)).toBe("a+b");
    expect(key([...input].reverse())).toBe("a+b");
  });

  it("separates two clusters that are far apart", () => {
    const out = clusterMarkers(
      [pin("a", 0, 0), pin("b", 5, 0), pin("c", 900, 0), pin("d", 906, 0)],
      CLUSTER_PX,
    );
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.kind === "cluster")).toBe(true);
  });

  it("clusters on TRUE distance, not a horizontal gap only", () => {
    // Stacked labels overlap as much as side-by-side ones.
    const stacked = [pin("a", 0, 0), pin("b", 0, 10)];
    expect(clusterMarkers(stacked, CLUSTER_PX)).toHaveLength(1);
  });

  it("the radius is the marker's own hit target, so the rule says one thing", () => {
    // Two markers a thumb can actually separate must NOT cluster; two it cannot
    // must. The radius being the 44px hit target is what makes that true — a
    // smaller radius would merge markers a finger separates, a larger one would
    // swallow the town a traveler is looking at.
    expect(CLUSTER_PX).toBe(44);
    const justInside = [pin("a", 0, 0), pin("b", CLUSTER_PX - 2, 0)];
    const justOutside = [pin("a", 0, 0), pin("b", CLUSTER_PX + 2, 0)];
    expect(clusterMarkers(justInside, CLUSTER_PX)).toHaveLength(1);
    expect(clusterMarkers(justOutside, CLUSTER_PX)).toHaveLength(2);
  });

  it("a cluster sits at its members' centroid, not on one member", () => {
    // A badge that inherits one venue's coordinates claims that venue's
    // identity — and its day card — which would be a lie.
    const out = clusterMarkers([pin("a", 100, 100), pin("b", 140, 100)], CLUSTER_PX);
    if (out[0].kind !== "cluster") throw new Error("expected a cluster");
    expect(out[0].cluster.x).toBe(120);
    expect(out[0].cluster.y).toBe(100);
  });

  it("is empty for no markers", () => {
    expect(clusterMarkers([], CLUSTER_PX)).toEqual([]);
  });
});
