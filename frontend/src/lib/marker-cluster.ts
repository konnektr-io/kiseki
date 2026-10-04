/**
 * Screen-space marker clustering — ONE grammar for every Kiseki map surface
 * (DESIGN.md §8.3: "Cluster below the zoom where pins collide; the cluster
 * shows a count, not a number range").
 *
 * The rule lives here, pure and MapLibre-free, because two map surfaces needed
 * it and two copies of a clustering rule drift: the signed-in home has had
 * clustering since #249, while the trip map had nothing — §8.3 has specified it
 * since the marker system was written, and the open finding logged at v0.92.0
 * ("the diamonds sit ~4px apart") is exactly that gap showing. The vocabulary is
 * the home's (`dtId`, `memberDtIds`), because that surface already depends on
 * it; a trip marker is identified by its place name, which is a perfectly good
 * `dtId`.
 *
 * Input is already-projected screen points: the rule says which markers are a
 * pin and which are a count badge. Nothing here knows about cameras, tiles or
 * the WebGL context, so it is testable in plain jsdom.
 */

/** One marker on screen, ready to cluster. `dtId` is its stable identity — a
 *  trip `$dtId` on the home, a place name on a trip map. */
export interface ProjectedPin {
  dtId: string;
  x: number;
  y: number;
}

/** Markers too close to tap apart, drawn as one count badge. */
export interface PinCluster {
  key: string;
  memberDtIds: string[];
  x: number;
  y: number;
}

export type ClusteredPin = { kind: "pin"; pin: ProjectedPin } | { kind: "cluster"; cluster: PinCluster };

/**
 * Group markers that collide on screen (a count, not a range — DESIGN.md §8.3).
 *
 * Greedy and deterministic: in input order, each unclaimed marker seeds a group
 * with every unclaimed marker within `radiusPx` of it. A lone marker is never
 * a "cluster of one" — callers draw it as its own marker.
 *
 * Deterministic for a fixed input order, and a group's IDENTITY is its sorted
 * membership — so the same geometry yields the same cluster key and a badge
 * element can be reused rather than torn down on every camera move. It is
 * deliberately NOT order-independent: greedy seeding means input order decides
 * WHO seeds a group, which is the home map's long-standing behaviour and is
 * pinned as such in `marker-cluster.test.ts`.
 */
export function clusterMarkers(points: readonly ProjectedPin[], radiusPx: number): ClusteredPin[] {
  const claimed = new Set<string>();
  const out: ClusteredPin[] = [];
  for (const seed of points) {
    if (claimed.has(seed.dtId)) continue;
    claimed.add(seed.dtId);
    const members = [seed];
    for (const other of points) {
      if (claimed.has(other.dtId)) continue;
      if (Math.hypot(other.x - seed.x, other.y - seed.y) <= radiusPx) {
        claimed.add(other.dtId);
        members.push(other);
      }
    }
    if (members.length === 1) {
      out.push({ kind: "pin", pin: seed });
    } else {
      out.push({
        kind: "cluster",
        cluster: {
          key: [...members.map((m) => m.dtId)].sort().join("+"),
          memberDtIds: members.map((m) => m.dtId),
          x: members.reduce((s, m) => s + m.x, 0) / members.length,
          y: members.reduce((s, m) => s + m.y, 0) / members.length,
        },
      });
    }
  }
  return out;
}

/**
 * The tap radius for a cluster, in px — deliberately the same as the marker
 * system's 44px hit target, so the rule is one sentence at both ends: two
 * markers that would steal each other's taps cluster instead. A radius much
 * below 44 clusters markers a thumb can actually separate, and much above it
 * swallows the town a traveler is trying to look at.
 */
export const CLUSTER_PX = 44;
