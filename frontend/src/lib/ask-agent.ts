import type { Block, Day, Trip, TripSection } from "./types";

/**
 * The "ask the agent about this" bridge (#296, phase 2) — the event + the
 * pre-scoped composer text that stops the user hand-copying "on day 4, the
 * second block…" into chat.
 *
 * No new write paths: this only ADDRESSES the existing chat relay
 * (`POST /api/chat` via the trip drawer). The drawer opens with the entity
 * context (ids + current field values) pre-filled in the composer; the user
 * reads, edits and sends it like any other message.
 *
 * Privacy: the DRAFT carries field values (that is the point — the agent
 * needs to see what the user sees), but it is transient composer state, never
 * logged. The edit-intent SIGNAL (phase 3, `lib/edit-intent.ts`) records
 * entity + field names only — never values.
 */

/** What the drawer was opened about. `id` is the day/block/section twin id;
 *  `fields` names the values carried in the draft (for the intent log);
 *  `draft` is the pre-filled composer text. */
export interface AskAgentContext {
  entity: "day" | "section" | "block";
  id: string;
  label: string;
  fields: string[];
  draft: string;
}

export const ASK_AGENT_EVENT = "kiseki:ask-agent";

/** Open the trip chat drawer pre-scoped with `ctx` (TripLayout listens). */
export function requestAskAgent(ctx: AskAgentContext): void {
  window.dispatchEvent(new CustomEvent<AskAgentContext>(ASK_AGENT_EVENT, { detail: ctx }));
}

/** One field value in the draft, capped so a long notes blob stays a
 *  context line instead of becoming the message. */
function cap(value: string | undefined, max = 400): string {
  const v = (value ?? "").trim();
  if (!v) return "—";
  return v.length > max ? `${v.slice(0, max).trimEnd()}…` : v;
}

/** Day context: title + notes, the two fields the day level edits (#296). */
export function dayAskContext(trip: Trip, dayIdx: number): AskAgentContext | null {
  const day: Day | undefined = trip.days[dayIdx];
  if (!day) return null;
  const name = day.title || day.date;
  return {
    entity: "day",
    id: day.id,
    label: `Day ${dayIdx + 1} — ${name}`,
    fields: ["title", "notes"],
    draft:
      `About Day ${dayIdx + 1} — “${name}” (day_id=${day.id}):\n` +
      `Title: ${cap(day.title || day.date)}\n` +
      `Notes: ${cap(day.notes)}\n\n`,
  };
}

/** Section context: the chapter title + the day range it covers. */
export function sectionAskContext(section: TripSection): AskAgentContext {
  const [first, last] = section.days ?? [];
  const range =
    first != null && last != null
      ? last > first
        ? `days ${first + 1}–${last + 1}`
        : `day ${first + 1}`
      : "no days yet";
  return {
    entity: "section",
    id: section.id,
    label: `Section — ${section.title}`,
    fields: ["title"],
    draft: `About the section “${section.title}” (section_id=${section.id}, ${range}):\n\n`,
  };
}

/** Block context: kind + title + the editable scalars, plus WHERE it lives
 *  ("on Day 4" / "in section X") so the agent needs no hand-copied pointer. */
export function blockAskContext(
  trip: Trip,
  block: Block,
  containerId: string,
): AskAgentContext {
  const dayIdx = trip.days.findIndex((d) => d.id === containerId);
  const section = (trip.sections ?? []).find((s) => s.id === containerId);
  const where =
    dayIdx >= 0
      ? `on Day ${dayIdx + 1}`
      : section
        ? `in the section “${section.title}”`
        : "in an unknown container";
  return {
    entity: "block",
    id: block.id,
    label: `${block.kind} — ${block.title || "untitled"}`,
    fields: ["title", "description"],
    draft:
      `About the ${block.kind} block “${block.title || "untitled"}” ` +
      `(block_id=${block.id}, ${where}):\n` +
      `Title: ${cap(block.title)}\n` +
      (block.time ? `Time: ${cap(block.time, 40)}\n` : "") +
      `Description: ${cap(block.description)}\n\n`,
  };
}
