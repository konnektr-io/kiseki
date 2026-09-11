import type { Block, Person, Role, Stage, TodoItem, Trip } from "./types";

/**
 * Pure, immutable helpers for the #46 write UI (milestone C).
 * Everything here is unit-testable without fetch/auth — components layer the
 * optimistic-update + rollback loop (useTripWrite) on top.
 *
 * The SERVER is always the authority: these functions only build the next
 * local snapshot for the optimistic paint. The canonical doc returned by each
 * write replaces the snapshot.
 */

export const STAGES: Stage[] = [
  "idea",
  "options",
  "shortlist",
  "planned",
  "booked",
  "live",
  "archive",
];

export const ROLE_RANK: Record<Role, number> = {
  follower: 1,
  viewer: 2,
  editor: 3,
  owner: 4,
};

/** Server role ladder mirror. `undefined` (anonymous read of a public trip)
 *  ranks below follower — no write affordances. */
export function roleAtLeast(role: string | undefined, min: Role): boolean {
  if (!role) return false;
  return (ROLE_RANK[role as Role] ?? 0) >= ROLE_RANK[min];
}

/** Stage transitions to OFFER in the UI select. The server enforces the real
 *  machine (forward/skip editor+, archive owner-only, backward owner-only);
 *  this only narrows what an editor sees: owner gets every other stage,
 *  editor gets forward options excluding `archive`. */
export function stageOptions(stage: Stage, role: string | undefined): Stage[] {
  if (!roleAtLeast(role, "editor")) return [];
  const cur = STAGES.indexOf(stage);
  if (role === "owner") return STAGES.filter((_, i) => i !== cur);
  return STAGES.filter((s, i) => i > cur && s !== "archive");
}

/* ---------------- local snapshot builders ---------------- */

export function withTripStage(trip: Trip, stage: Stage): Trip {
  return { ...trip, stage };
}

export function withTripVisibility(trip: Trip, visibility: "public" | "private"): Trip {
  return { ...trip, visibility };
}

export function withTripTheme(trip: Trip, preset: string): Trip {
  return { ...trip, theme: { preset } };
}

export function withTodoDone(trip: Trip, index: number, done: boolean): Trip {
  const todos = trip.practical.todos ?? [];
  const target = todos[index];
  if (!target || target.done === done) return trip;
  return {
    ...trip,
    practical: {
      ...trip.practical,
      todos: todos.map((t, i) => (i === index ? { ...t, done } : t)),
    },
  };
}

/** Find a block by id across day and section containers and apply `fn`.
 *  Returns the same reference when nothing changed (helps memoization). */
export function mapBlock(trip: Trip, blockId: string, fn: (b: Block) => Block): Trip {
  let hit = false;
  const days = trip.days.map((d) => {
    const blocks = d.blocks.map((b) => {
      if (b.id !== blockId) return b;
      hit = true;
      return fn(b);
    });
    return blocks.some((b, i) => b !== d.blocks[i]) ? { ...d, blocks } : d;
  });
  const sections = (trip.sections ?? []).map((s) => {
    if (!s.blocks) return s;
    const blocks = s.blocks.map((b) => {
      if (b.id !== blockId) return b;
      hit = true;
      return fn(b);
    });
    return blocks.some((b, i) => b !== s.blocks![i]) ? { ...s, blocks } : s;
  });
  if (!hit) return trip;
  const daysChanged = days.some((d, i) => d !== trip.days[i]);
  const sectionsChanged = sections.some((s, i) => s !== (trip.sections ?? [])[i]);
  return {
    ...trip,
    days: daysChanged ? days : trip.days,
    sections: sectionsChanged ? sections : trip.sections,
  };
}

/** Replace a block's `items` (todo-list or gallery). */
export function withBlockItems(trip: Trip, blockId: string, items: Block["items"]): Trip {
  return mapBlock(trip, blockId, (b) => ({ ...b, items }));
}

/** Patch the editable scalar fields of one block (never id/kind/order). */
export function withBlockFields(trip: Trip, blockId: string, fields: Partial<Block>): Trip {
  return mapBlock(trip, blockId, (b) => ({ ...b, ...fields }));
}

export interface Container {
  kind: "day" | "section";
  id: string;
  blocks: Block[];
}

export function containerOf(trip: Trip, containerId: string): Container | null {
  const day = trip.days.find((d) => d.id === containerId);
  if (day) return { kind: "day", id: day.id, blocks: day.blocks };
  const section = (trip.sections ?? []).find((s) => s.id === containerId);
  if (section) return { kind: "section", id: section.id, blocks: section.blocks ?? [] };
  return null;
}

/** The container's block ids in display (order) sequence — what the
 *  block-order endpoint expects. */
export function orderedContainerBlockIds(trip: Trip, containerId: string): string[] {
  const c = containerOf(trip, containerId);
  if (!c) return [];
  return [...c.blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((b) => b.id);
}

/** Swap the `order` values of two blocks inside one container (up/down move). */
export function swapContainerBlocks(trip: Trip, containerId: string, idA: string, idB: string): Trip {
  const c = containerOf(trip, containerId);
  if (!c) return trip;
  const a = c.blocks.find((b) => b.id === idA);
  const b = c.blocks.find((x) => x.id === idB);
  if (!a || !b) return trip;
  const swap = (blocks: Block[]): Block[] =>
    blocks.map((x) => {
      if (x.id === idA) return { ...x, order: b.order };
      if (x.id === idB) return { ...x, order: a.order };
      return x;
    });
  if (c.kind === "day") {
    return {
      ...trip,
      days: trip.days.map((d) => (d.id === containerId ? { ...d, blocks: swap(d.blocks) } : d)),
    };
  }
  return {
    ...trip,
    sections: (trip.sections ?? []).map((s) =>
      s.id === containerId && s.blocks ? { ...s, blocks: swap(s.blocks) } : s,
    ),
  };
}

/** Remove a block from whichever container holds it (optimistic delete paint;
 *  the DELETE response replaces the snapshot anyway). */
export function removeBlock(trip: Trip, blockId: string): Trip {
  let hit = false;
  const days = trip.days.map((d) => {
    const blocks = d.blocks.filter((b) => {
      if (b.id !== blockId) return true;
      hit = true;
      return false;
    });
    return blocks.length === d.blocks.length ? d : { ...d, blocks };
  });
  const sections = (trip.sections ?? []).map((s) => {
    if (!s.blocks) return s;
    const blocks = s.blocks.filter((b) => {
      if (b.id !== blockId) return true;
      hit = true;
      return false;
    });
    return blocks.length === s.blocks!.length ? s : { ...s, blocks };
  });
  if (!hit) return trip;
  return {
    ...trip,
    days: days.some((d, i) => d !== trip.days[i]) ? days : trip.days,
    sections: sections.some((s, i) => s !== (trip.sections ?? [])[i]) ? sections : trip.sections,
  };
}

/** Patch the trip-scoped fields of one crew member (note/role — the server
 *  enforces role owner-only). Returns the same reference when nothing
 *  changed (helps memoization). `note: null` clears the note. */
export function withCrewMember(
  trip: Trip,
  personId: string,
  patch: { note?: string | null; role?: Role },
): Trip {
  const crew = trip.crew.map((p) => {
    if (p.id !== personId) return p;
    const note = patch.note === undefined ? p.note : (patch.note ?? undefined);
    const role = patch.role ?? p.role;
    if (note === p.note && role === p.role) return p; // no-op → same ref
    return { ...p, note, role };
  });
  if (crew.every((p, i) => p === trip.crew[i])) return trip;
  return { ...trip, crew };
}

/** Optimistically append a crew member (the canonical doc replaces the
 *  snapshot; the server assigns the real id). Returns the same reference
 *  when a member with the same id already exists (helps memoization). */
export function withAddedCrew(trip: Trip, member: Person): Trip {
  if (trip.crew.some((p) => p.id === member.id)) return trip;
  return { ...trip, crew: [...trip.crew, member] };
}

/** Optimistically drop a crew member. Returns the same reference when the
 *  id is not on the crew (helps memoization). */
export function withRemovedCrew(trip: Trip, personId: string): Trip {
  if (!trip.crew.some((p) => p.id === personId)) return trip;
  return { ...trip, crew: trip.crew.filter((p) => p.id !== personId) };
}

/** Block ids: Block carries `id` from the graph document. */
export type { TodoItem };
