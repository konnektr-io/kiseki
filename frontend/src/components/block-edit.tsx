import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { BlockView } from "./blocks";
import type { BlockCardProps } from "./blocks";
import { Button } from "./ui";
import { useTripState } from "./theme";
import { useTripWrite } from "../lib/useTripWrite";
import {
  orderedContainerBlockIds,
  roleAtLeast,
  swapContainerBlocks,
  withBlockFields,
  withBlockItems,
} from "../lib/editing";
import { deleteTripBlock, putContainerOrder, putTripBlock } from "../lib/api";
import { isPostHogConfigured, posthog } from "../lib/posthog";
import type { Block, BlockKind, BlockStatus } from "../lib/types";

/**
 * Inline block editing for the #46 write UI (milestone C), rendered by
 * DayBlocks when a trip page is in editable mode. One component per block:
 * a read-only BlockView plus a chrome row (move ↑/↓ within the container,
 * edit, delete) and, for `todo` blocks, tappable checkboxes. All writes go
 * through the optimistic-update + rollback loop in useTripWrite; the server
 * remains the authority (editor+, tested server-side).
 *
 * NOT used by the booklet: BookletPage renders plain DayBlocks, and the
 * chrome row is `no-print` regardless.
 */

const FIELD_EDITABLE: BlockKind[] = [
  "activity",
  "transport",
  "lodging",
  "meal",
  "todo",
  "note",
  "booking",
  "custom",
];
const STATUS_KINDS: BlockKind[] = ["activity", "lodging", "meal", "booking"];
const COST_KINDS: BlockKind[] = ["activity", "lodging", "meal", "booking"];
const CODE_KINDS: BlockKind[] = ["booking", "transport", "activity", "lodging", "meal"];

const iconBtn =
  "inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring disabled:opacity-40 disabled:hover:bg-card disabled:hover:text-muted-foreground";

/** The ARMED delete control (#286) — a labelled destructive pill, and its OWN
 *  class set rather than `iconBtn` + destructive overrides. Appending
 *  `bg-destructive text-destructive-foreground` to the icon button loses the
 *  precedence fight: the base `bg-card`/`text-muted-foreground` sit at the same
 *  specificity and Tailwind emits them later, and while the pointer is still on
 *  the button (i.e. right after the click) `hover:bg-muted` — a higher
 *  specificity hover rule — wins outright. Measured on production: armed+hover
 *  rendered `rgb(245,245,244)` (muted, i.e. identical to a hovered unarmed
 *  button) with a muted-grey glyph, so the first click looked like a no-op and
 *  Niko reported the button as dead. Keeping one utility per property here is
 *  what makes the armed state unambiguous. */
const deleteArmedBtn =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-destructive bg-destructive px-2 text-xs font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:focus-ring disabled:opacity-40";

/** How long the block-delete confirm stays armed (#286). The settings page's
 *  trip-delete arms for 3 s, but it renders its own Cancel button; this row has
 *  none, so the auto-revert is the only way out of the armed state — and 3 s
 *  proved too short for a real second click. A probe that armed, paused 3.5 s,
 *  then clicked, hit the reverted trash icon and re-armed instead of deleting:
 *  no request, no error, nothing on screen — Niko's "the delete button doesn't
 *  do anything", to the letter. */
const DELETE_ARM_MS = 8000;

export function EditableBlockList({
  blocks,
  containerId,
  letters,
  cardProps,
  date,
}: {
  blocks: Block[];
  /** The day twin id whose block list this is — the block-order target. */
  containerId: string;
  /** Day-level letters (§8.3/#90), blockId → letter — passed straight to
   *  BlockView so editors on the map surface keep the tap↔card wiring. */
  letters?: Map<string, string>;
  cardProps?: (b: Block) => BlockCardProps;
  /** The day's ISO date — pins each block's weather strip to that day. */
  date?: string;
}) {
  const { trip } = useTripState();
  const { busy, error, run } = useTripWrite();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteArmId, setDeleteArmId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [blocks],
  );

  if (!roleAtLeast(trip.myRole, "editor")) {
    // Caller gates already; belt-and-braces so a viewer never sees chrome.
    return (
      <div className="space-y-2.5">
        {sorted.map((b) => (
          <BlockView key={b.id} block={b} letter={letters?.get(b.id)} cardProps={cardProps?.(b)} date={date} />
        ))}
      </div>
    );
  }

  const move = async (dir: -1 | 1, b: Block) => {
    const ids = orderedContainerBlockIds(trip, containerId);
    const i = ids.indexOf(b.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const swapped = [...ids];
    [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
    if (isPostHogConfigured) {
      posthog.capture("trip_block_reordered", {
        block_kind: b.kind,
        direction: dir === -1 ? "up" : "down",
      });
    }
    await run(
      (token) => putContainerOrder(trip.id, containerId, swapped, token),
      (t) => swapContainerBlocks(t, containerId, b.id, ids[j]),
    );
  };

  const remove = async (b: Block) => {
    setDeleteArmId(null);
    if (isPostHogConfigured) posthog.capture("trip_block_deleted", { block_kind: b.kind });
    await run((token) => deleteTripBlock(trip.id, b.id, token));
  };

  const toggleItem = async (b: Block, itemIndex: number, done: boolean) => {
    const items = ((b.items ?? []) as { label?: string; done?: boolean }[]).map((it, i) =>
      i === itemIndex ? { ...it, done } : it,
    );
    if (isPostHogConfigured) {
      posthog.capture("trip_todo_item_toggled", { completed: done });
    }
    await run(
      (token) => putTripBlock(trip.id, b.id, { items }, token),
      (t) => withBlockItems(t, b.id, items as Block["items"]),
    );
  };

  const saveFields = async (b: Block, fields: Partial<Block>) => {
    setEditingId(null);
    if (isPostHogConfigured) {
      posthog.capture("trip_block_updated", {
        block_kind: b.kind,
        changed_field_count: Object.keys(fields).length,
      });
    }
    await run(
      (token) => putTripBlock(trip.id, b.id, fields as Record<string, unknown>, token),
      (t) => withBlockFields(t, b.id, fields),
    );
  };

  return (
    <div className="space-y-2.5">
      {sorted.map((b, idx) => {
        const isEditing = editingId === b.id;
        const isArmed = deleteArmId === b.id;
        const fieldsEditable = FIELD_EDITABLE.includes(b.kind);
        const isTodo = b.kind === "todo";
        return (
          <div key={b.id} className="space-y-1.5">
            {isEditing ? (
              <BlockEditor
                block={b}
                busy={busy}
                onCancel={() => setEditingId(null)}
                onSave={(fields) => void saveFields(b, fields)}
              />
            ) : (
              <BlockView
                block={b}
                editable={isTodo}
                onToggleItem={
                  isTodo ? (itemIndex, done) => void toggleItem(b, itemIndex, done) : undefined
                }
                letter={letters?.get(b.id)}
                cardProps={cardProps?.(b)}
                date={date}
              />
            )}
            {!isEditing && (
              <div
                className="no-print flex items-center gap-1"
                role="group"
                aria-label={`Actions — ${b.title || b.kind}`}
              >
                <button
                  type="button"
                  className={iconBtn}
                  disabled={busy || idx === 0}
                  onClick={() => void move(-1, b)}
                  aria-label="Move block up"
                  title="Move up"
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  disabled={busy || idx === sorted.length - 1}
                  onClick={() => void move(1, b)}
                  aria-label="Move block down"
                  title="Move down"
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </button>
                {fieldsEditable && (
                  <button
                    type="button"
                    className={iconBtn}
                    disabled={busy}
                    onClick={() => {
                      setDeleteArmId(null);
                      setEditingId(b.id);
                    }}
                    aria-label="Edit block"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
                {isArmed ? (
                  /* Two-step destructive control (same arm→confirm pattern as
                     the trip delete): the arm must be VISIBLE or the first
                     click reads as a no-op — hence a labelled destructive pill
                     instead of a recoloured icon button (#286). */
                  <button
                    type="button"
                    className={deleteArmedBtn}
                    disabled={busy}
                    onClick={() => void remove(b)}
                    aria-label="Confirm delete"
                    title="Confirm delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    className={iconBtn}
                    disabled={busy}
                    onClick={() => {
                      setDeleteArmId(b.id);
                      window.setTimeout(() => {
                        setDeleteArmId((cur) => (cur === b.id ? null : cur));
                      }, DELETE_ARM_MS);
                    }}
                    aria-label="Delete block"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" className="pt-1 text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------------- inline editor ---------------- */

const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:focus-ring disabled:opacity-50";
const labelCls = "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

function BlockEditor({
  block,
  busy,
  onCancel,
  onSave,
}: {
  block: Block;
  busy: boolean;
  onCancel: () => void;
  onSave: (fields: Partial<Block>) => void;
}) {
  const [title, setTitle] = useState(block.title ?? "");
  const [time, setTime] = useState(block.time ?? "");
  const [description, setDescription] = useState(block.description ?? "");
  const [status, setStatus] = useState<BlockStatus | "">(block.status ?? "");
  const [cost, setCost] = useState(block.cost != null ? String(block.cost) : "");
  const [currency, setCurrency] = useState(block.currency ?? "");
  const [bookingCode, setBookingCode] = useState(block.bookingCode ?? "");
  const [mode, setMode] = useState(block.mode ?? "");
  const [from, setFrom] = useState(block.from ?? "");
  const [to, setTo] = useState(block.to ?? "");
  const [html, setHtml] = useState(block.html ?? "");

  const k = block.kind;
  const isCustom = k === "custom";
  const isTransport = k === "transport";

  const save = () => {
    const fields: Partial<Block> = {};
    if (title !== (block.title ?? "")) fields.title = title;
    if (time !== (block.time ?? "")) fields.time = time;
    if (description !== (block.description ?? "")) fields.description = description;
    if (STATUS_KINDS.includes(k) && status !== (block.status ?? "")) {
      fields.status = (status || undefined) as BlockStatus | undefined;
    }
    const parsedCost = cost === "" ? undefined : Number(cost);
    if (COST_KINDS.includes(k) && parsedCost !== block.cost && !Number.isNaN(parsedCost)) {
      fields.cost = parsedCost;
    }
    if (COST_KINDS.includes(k) && currency !== (block.currency ?? "")) fields.currency = currency;
    if (CODE_KINDS.includes(k) && bookingCode !== (block.bookingCode ?? "")) {
      fields.bookingCode = bookingCode;
    }
    if (isTransport) {
      if (mode !== (block.mode ?? "")) fields.mode = (mode || undefined) as Block["mode"];
      if (from !== (block.from ?? "")) fields.from = from;
      if (to !== (block.to ?? "")) fields.to = to;
    }
    if (isCustom && html !== (block.html ?? "")) fields.html = html;
    onSave(fields);
  };

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <p className="kicker mb-2">Edit {k}</p>
      {!isCustom && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_8rem]">
            <div>
              <label className={labelCls} htmlFor={`title-${block.id}`}>
                Title
              </label>
              <input
                id={`title-${block.id}`}
                className={inputCls}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor={`time-${block.id}`}>
                Time
              </label>
              <input
                id={`time-${block.id}`}
                className={inputCls}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                placeholder="e.g. 09:30"
                disabled={busy}
              />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor={`description-${block.id}`}>
              Description (markdown)
            </label>
            <textarea
              id={`description-${block.id}`}
              className={`${inputCls} min-h-20 resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
          </div>
          {isTransport && (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div>
                <label className={labelCls} htmlFor={`mode-${block.id}`}>
                  Mode
                </label>
                <select
                  id={`mode-${block.id}`}
                  className={inputCls}
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  disabled={busy}
                >
                  <option value="">—</option>
                  {(["flight", "drive", "train", "ferry"] as const).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor={`from-${block.id}`}>
                  From
                </label>
                <input
                  id={`from-${block.id}`}
                  className={inputCls}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor={`to-${block.id}`}>
                  To
                </label>
                <input
                  id={`to-${block.id}`}
                  className={inputCls}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>
          )}
          {(STATUS_KINDS.includes(k) || COST_KINDS.includes(k) || CODE_KINDS.includes(k)) && (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {STATUS_KINDS.includes(k) && (
                <div>
                  <label className={labelCls} htmlFor={`status-${block.id}`}>
                    Status
                  </label>
                  <select
                    id={`status-${block.id}`}
                    className={inputCls}
                    value={status}
                    onChange={(e) => setStatus(e.target.value as BlockStatus | "")}
                    disabled={busy}
                  >
                    <option value="">—</option>
                    {(["planned", "booked", "done", "skipped"] as const).map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {COST_KINDS.includes(k) && (
                <>
                  <div>
                    <label className={labelCls} htmlFor={`cost-${block.id}`}>
                      Cost
                    </label>
                    <input
                      id={`cost-${block.id}`}
                      className={inputCls}
                      value={cost}
                      onChange={(e) => setCost(e.target.value)}
                      inputMode="decimal"
                      disabled={busy}
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`currency-${block.id}`}>
                      Currency
                    </label>
                    <input
                      id={`currency-${block.id}`}
                      className={inputCls}
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      placeholder="EUR"
                      disabled={busy}
                    />
                  </div>
                </>
              )}
              {CODE_KINDS.includes(k) && (
                <div>
                  <label className={labelCls} htmlFor={`code-${block.id}`}>
                    Booking code
                  </label>
                  <input
                    id={`code-${block.id}`}
                    className={inputCls}
                    value={bookingCode}
                    onChange={(e) => setBookingCode(e.target.value)}
                    disabled={busy}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {isCustom && (
        <div>
          <label className={labelCls} htmlFor={`html-${block.id}`}>
            HTML (sanitized on render)
          </label>
          <textarea
            id={`html-${block.id}`}
            className={`${inputCls} min-h-28 resize-y font-mono text-xs`}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            disabled={busy}
          />
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" variant="accent" size="sm" onClick={save} disabled={busy}>
          Save
        </Button>
      </div>
    </div>
  );
}
