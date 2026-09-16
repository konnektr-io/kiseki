import type { Person } from "./types";

/**
 * A follower watches the trip; the crew is who is coming (#315).
 *
 * The split is ONE decision point on purpose: the crew page renders the two
 * groups as separate sections, and every other trip surface (overview,
 * practicalities, the printed booklet) renders the crew only, with followers
 * reduced to a count that links back here. A second hand-rolled
 * `role === "follower"` filter anywhere is how those surfaces start to
 * disagree about who is in the group.
 */
export function splitCrew(crew: Person[] | undefined): {
  members: Person[];
  followers: Person[];
} {
  const members: Person[] = [];
  const followers: Person[] = [];
  for (const p of crew ?? []) (p.role === "follower" ? followers : members).push(p);
  return { members, followers };
}
