// @vitest-environment jsdom
/**
 * `Sheet` — the body's reach and the gesture's safety net.
 *
 * Two phone defects, one root cause (the body was sized for a state the sheet
 * was no longer in):
 *
 * - A drag pulled the sheet up and the body stayed sized for the detent the
 *   drag started from, so the revealed part of the sheet painted blank — the
 *   list simply ended mid-card with white below it (Niko's phone, Costa Rica
 *   2023: sheet visually at `full`, chevron still up, bottom ~40% empty).
 * - If the pointer stream ended without the handle seeing it (a system
 *   gesture, a backgrounded tab, a lost capture), the sheet stayed parked
 *   mid-travel: `dragging` forever, no snap, the body blank for good.
 *
 * jsdom has no layout, so the geometry is driven through stubbed
 * `offsetHeight`/`offsetTop`/`clientHeight`/rects — the same trick the other
 * geometry suites use — and the ResizeObserver is a fake whose callbacks the
 * tests fire by hand.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detentOffsetPct } from "../lib/sheet";

const { Sheet } = await import("./Sheet");

/** The real phone geometry: 360×780 with 61px of app chrome above the surface. */
const geo = {
  surfaceTop: 61,
  surfaceHeight: 663,
  sheetHeight: 597, // 90% of the surface
  viewportHeight: 780,
  bodyOffsetTop: 116, // drag handle + peek line
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
/** Fake observers that remember WHAT they observe, so a test can resize ONE box
 *  and check the component was watching it. */
const roWatchers: { targets: Element[]; fire: () => void }[] = [];

class FakeResizeObserver implements ResizeObserver {
  targets: Element[] = [];
  constructor(private cb: ResizeObserverCallback) {
    roWatchers.push({ targets: this.targets, fire: () => this.cb([], this) });
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve(el: Element) {
    this.targets = this.targets.filter((t) => t !== el);
  }
  disconnect() {
    this.targets.length = 0;
  }
}

/** A pointer event jsdom does not ship — React listens for the native name. */
function pointer(target: EventTarget, type: string, init: Record<string, unknown>): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, init);
  act(() => {
    target.dispatchEvent(e);
  });
}

/** Fire only the observers watching `el` (or all of them) and let the
 *  rAF-coalesced measure land. */
async function fireResize(el?: Element): Promise<void> {
  await act(async () => {
    for (const w of roWatchers) {
      if (!el || w.targets.includes(el)) w.fire();
    }
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

/** The body's bottom, in viewport px, for the sheet's CURRENT position. */
function bodyBottom(body: HTMLElement, detent: "peek" | "half" | "full", dragPx = 0): number {
  return (
    geo.surfaceTop +
    geo.surfaceHeight -
    geo.sheetHeight +
    (detentOffsetPct(detent) / 100) * geo.sheetHeight +
    dragPx +
    geo.bodyOffsetTop +
    Number.parseFloat(body.style.height)
  );
}

function mount(detent: "peek" | "half" | "full", onDetentChange = vi.fn()): void {
  act(() =>
    root!.render(
      <Sheet detent={detent} onDetentChange={onDetentChange} label="Costa Rica — the itinerary">
        <div style={{ height: 4000 }} />
      </Sheet>,
    ),
  );
}

function body(html: HTMLElement): HTMLElement {
  const el = html.querySelector<HTMLElement>("[data-scroll-root]");
  if (!el) throw new Error("no scroll body");
  return el;
}

function handle(html: HTMLElement): HTMLElement {
  const el = html.querySelector<HTMLElement>(".sheet-handle");
  if (!el) throw new Error("no drag handle");
  return el;
}

beforeEach(() => {
  geo.bodyOffsetTop = 116;
  roWatchers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => geo.surfaceHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => geo.sheetHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get: () => geo.bodyOffsetTop,
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: geo.surfaceTop, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: geo.viewportHeight });
  // jsdom ships neither pointer capture nor a font set.
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

describe("Sheet body height", () => {
  it("ends the body on the sheet's visible floor", () => {
    mount("half");
    // 724 (the surface's bottom) − 508 (the body's top at `half`).
    expect(body(container!).style.height).toBe("216px");
    expect(bodyBottom(body(container!), "half")).toBeCloseTo(724, 0);
  });

  it("re-measures when the chrome above the body changes height", async () => {
    // A font swap or a re-wrapped stats line moves the body's top; the height
    // is a cached measurement, so it only survives if the observers fire.
    mount("full");
    expect(body(container!).style.height).toBe("481px");
    const header = container!.querySelector<HTMLElement>("section > div.shrink-0")!;
    expect(header).not.toBeNull();
    geo.bodyOffsetTop = 236; // the peek line grew by 120px
    await fireResize(header);
    expect(body(container!).style.height).toBe("361px");
    expect(bodyBottom(body(container!), "full")).toBeCloseTo(724, 0);
  });
});

describe("Sheet drag", () => {
  it("grows the body with the finger — the revealed strip is never blank", () => {
    mount("half");
    const h = handle(container!);
    pointer(h, "pointerdown", { pointerId: 1, clientY: 400 });
    pointer(h, "pointermove", { pointerId: 1, clientY: 200 }); // pulled up 200px
    expect(body(container!).style.height).toBe("416px");
    // The body still ends on the floor, for where the sheet IS.
    expect(bodyBottom(body(container!), "half", -200)).toBeCloseTo(724, 0);
  });

  it("settles when the pointerup never reaches the handle", () => {
    // The defect: the stream ends elsewhere, `dragging` stays true forever and
    // the sheet is parked mid-travel with a blank body.
    const onDetentChange = vi.fn();
    mount("half", onDetentChange);
    const h = handle(container!);
    pointer(h, "pointerdown", { pointerId: 1, clientY: 400 });
    pointer(h, "pointermove", { pointerId: 1, clientY: 200 });

    pointer(window, "pointerup", { pointerId: 1 });

    // The parent owns the detent (it re-renders with `full`): what this
    // component must do is stop travelling and let the snap run again.
    expect(onDetentChange).toHaveBeenCalledWith("full");
    expect(container!.querySelector("section")!.style.transform).toBe(
      `translateY(${detentOffsetPct("half")}%)`,
    );
    expect(body(container!).style.height).toBe("216px");
  });

  it("reverts the travel when the browser cancels the gesture", () => {
    const onDetentChange = vi.fn();
    mount("half", onDetentChange);
    const h = handle(container!);
    pointer(h, "pointerdown", { pointerId: 1, clientY: 400 });
    pointer(h, "pointermove", { pointerId: 1, clientY: 200 });

    pointer(window, "pointercancel", { pointerId: 1 });

    expect(onDetentChange).not.toHaveBeenCalled();
    expect(container!.querySelector("section")!.style.transform).toBe(
      `translateY(${detentOffsetPct("half")}%)`,
    );
    expect(body(container!).style.height).toBe("216px");
  });
});
