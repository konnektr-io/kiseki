// @vitest-environment jsdom
/**
 * Block-delete control (#286).
 *
 * Niko reported the per-block delete button as dead ("the delete button for an
 * activity at the bottom doesn't do anything"). The two-step arm→confirm DID
 * fire the API — a production browser probe saw the DELETE go out — but the
 * armed state was invisible: the destructive utilities were APPENDED to the
 * shared `iconBtn` class set, so `bg-card` / `text-muted-foreground` (same
 * specificity, emitted later) and `hover:bg-muted` (higher specificity, and the
 * pointer is still on the button right after the click) won the cascade.
 * Measured armed+hover background: `rgb(245, 245, 244)` = `bg-muted`, i.e.
 * byte-identical to hovering any other icon button.
 *
 * jsdom computes no real cascade, so this file pins the STRUCTURE the cascade
 * depends on — the armed control carries its OWN class set, with no competing
 * background/text utilities — plus the two-step behaviour (arm first, delete
 * only on confirm). The computed-style half of the contract is asserted by the
 * browser probe; neither half alone is the fix.
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    getAccessTokenSilently: async () => "test-token",
  }),
}));

// The card tree pulls maplibre-gl in through CardMedia/MapView.
vi.mock("./MapView", () => ({ MapView: () => null, TripMap: () => null }));

const deleteMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../lib/api", () => ({
  deleteTripBlock: deleteMock,
  putTripBlock: vi.fn(async () => ({})),
  putContainerOrder: vi.fn(async () => ({})),
}));

const { EditableBlockList } = await import("./block-edit");
const { TripProvider } = await import("./theme");
import type { Block, Trip } from "../lib/types";

const trip = {
  id: "t1",
  slug: "test",
  title: "Test trip",
  stage: "booked",
  myRole: "owner",
  locations: [],
  days: [],
} as unknown as Trip;

const block = { id: "b1", kind: "activity", title: "Ski day", order: 0 } as unknown as Block;

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(TripProvider, {
        trip,
        apply: () => {},
        children: createElement(EditableBlockList, { blocks: [block], containerId: "day-1" }),
      }),
    );
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
}

function byLabel(label: string): HTMLButtonElement {
  const el = container.querySelector(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  return el as HTMLButtonElement;
}

function labels(): string[] {
  return Array.from(container.querySelectorAll("button")).map(
    (b) => b.getAttribute("aria-label") ?? "",
  );
}

beforeEach(() => {
  deleteMock.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("block delete arm→confirm (#286)", () => {
  it("arms on the first click and fires the API only on the second", async () => {
    mount();
    // Unarmed: the icon button — and it DOES carry the shared hover styling
    // (the negative control for the armed-class assertions below).
    const trash = byLabel("Delete block");
    expect(trash.className).toContain("bg-card");
    expect(trash.className).toContain("hover:bg-muted");
    expect(labels()).not.toContain("Confirm delete");

    await click(trash);
    expect(deleteMock).not.toHaveBeenCalled(); // arming alone deletes nothing

    const confirm = byLabel("Confirm delete");
    await click(confirm);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith("t1", "b1", "test-token");
  });

  it("gives the armed control its own class set — nothing to out-rank it", async () => {
    mount();
    await click(byLabel("Delete block"));
    const confirm = byLabel("Confirm delete");
    // The destructive pair is present…
    expect(confirm.className).toContain("bg-destructive");
    expect(confirm.className).toContain("text-destructive-foreground");
    // …and no competing utility with the same properties rides along (that is
    // precisely what made the armed state render as a plain hovered button).
    expect(confirm.className).not.toContain("bg-card");
    expect(confirm.className).not.toContain("hover:bg-muted");
    expect(confirm.className).not.toContain("text-muted-foreground");
    // Labelled, not a bare glyph swap.
    expect(confirm.textContent).toBe("Confirm");
  });

  /* The other half of "the button does nothing": a 3 s arm window silently
   * swallows the second click of anyone who pauses to read the confirm. Pinned
   * on both sides — still armed after a human pause, reverted in the end — so
   * neither a too-short window nor an arm that never expires can ship. */
  it("keeps the arm through a human pause, and still reverts eventually", async () => {
    vi.useFakeTimers();
    try {
      mount();
      await click(byLabel("Delete block"));
      expect(labels()).toContain("Confirm delete");
      await act(async () => {
        vi.advanceTimersByTime(3500); // the probe's failing pause
      });
      expect(labels()).toContain("Confirm delete");
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(labels()).toContain("Delete block");
      expect(labels()).not.toContain("Confirm delete");
      expect(deleteMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
