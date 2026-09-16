// @vitest-environment jsdom
/**
 * The shared inline-edit control (#296) — one component for every
 * title/note on the trip pages.
 *
 * Both role branches are asserted (#104 rule): `canEdit` false renders the
 * display with NO chrome at all (no buttons, so no privileged request can
 * fire); `canEdit` true adds the pencil → field → save/cancel loop with
 * exact-payload `onSave`. An empty value renders nothing for anon/viewer and
 * an "Add …" ghost for editors.
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InlineField } from "./inline-edit";

let container: HTMLDivElement;
let root: Root;

function mount(props: Partial<Parameters<typeof InlineField>[0]> & { value: string }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(InlineField, {
        label: "Day title",
        canEdit: false,
        onSave: async () => true,
        renderDisplay: (v: string) => createElement("h2", null, v),
        ...props,
      }),
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
}

function setField(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("InlineField — viewer tree (canEdit false)", () => {
  it("renders the value with no buttons and no way to fire a request", () => {
    const onSave = vi.fn(async () => true);
    mount({ value: "Old day", onSave });
    expect(container.textContent).toContain("Old day");
    expect(buttons()).toHaveLength(0);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renders nothing at all for an empty value", () => {
    mount({ value: "", emptyLabel: "Add notes" });
    expect(container.textContent).toBe("");
    expect(buttons()).toHaveLength(0);
  });
});

describe("InlineField — editor tree (canEdit true)", () => {
  it("pencil → edit → save calls onSave with the exact draft", async () => {
    const onSave = vi.fn(async () => true);
    mount({ value: "Old day", canEdit: true, onSave });
    expect(container.textContent).toContain("Old day");

    await click(container.querySelector('button[aria-label="Edit Day title"]')!);
    const input = container.querySelector("input")!;
    expect(input).not.toBeNull();
    setField(input, "New day");
    const save = buttons().find((b) => b.textContent === "Save")!;
    await click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("New day");
  });

  it("cancel reverts without calling onSave", async () => {
    const onSave = vi.fn(async () => true);
    mount({ value: "Old day", canEdit: true, onSave });
    await click(container.querySelector('button[aria-label="Edit Day title"]')!);
    const input = container.querySelector("input")!;
    setField(input, "Discarded");
    const cancel = buttons().find((b) => b.textContent === "Cancel")!;
    await click(cancel);
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Old day");
  });

  it("a failed save keeps the editor open", async () => {
    const onSave = vi.fn(async () => false);
    mount({ value: "Old day", canEdit: true, onSave });
    await click(container.querySelector('button[aria-label="Edit Day title"]')!);
    setField(container.querySelector("input")!, "New day");
    const save = buttons().find((b) => b.textContent === "Save")!;
    await click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    // Still editing — the field is on screen, the pencil is not.
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("empty value offers an Add ghost instead of nothing", async () => {
    const onSave = vi.fn(async () => true);
    mount({ value: "", canEdit: true, onSave, emptyLabel: "Add notes", multiline: true });
    const add = buttons().find((b) => b.textContent === "Add notes")!;
    await click(add);
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("multiline renders a textarea", async () => {
    mount({ value: "Some notes", canEdit: true, multiline: true });
    await click(container.querySelector('button[aria-label="Edit Day title"]')!);
    expect(container.querySelector("textarea")).not.toBeNull();
  });
});
