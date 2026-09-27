// @vitest-environment jsdom
/**
 * SplitView sheet-mode map box (#377 slice 1, Niko's resize).
 *
 * The map box ENDS where the sheet begins: an inner wrapper anchored top
 * carries `bottom: sheetPx`, so the map IS the visible strip and the camera
 * needs no sheet occlusion. Pinned here:
 *
 * - the wrapper's `bottom` is the sheet occlusion MINUS the sheet's top
 *   corner radius (#377 follow-up: the box ends at the bottom of the rounded
 *   shoulders so no backdrop notch shows above them);
 * - `padding.bottom` is chrome-only (the sheet is no longer inside the box —
 *   counting it too would double-shift);
 * - the occlusion is measured from the OUTER box (`mapBoxRef`), never the
 *   shrunk inner box (the fraction is of the surface; measuring the shrunk
 *   box feeds back on itself);
 * - `--map-chrome-y` is 0 in sheet mode (attribution at the box bottom is
 *   visible, no translate needed).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_PADDING, type MapPadding } from "../lib/maps";
import { detentOcclusionPx } from "../lib/sheet";

const { SplitView, SHEET_CORNER_RADIUS_PX } = await import("./SplitView");

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const box = { w: 390, h: 800 };
const roCallbacks: (() => void)[] = [];

class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    roCallbacks.push(() => this.cb([], this as unknown as ResizeObserver));
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fireResize(): void {
  for (const cb of roCallbacks) cb();
}

beforeEach(() => {
  box.w = 390;
  box.h = 800;
  roCallbacks.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => box.w,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => box.h,
  });
  // No query matches → `sheet` (the ladder's default rung).
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

async function mountSheet(detent: "peek" | "half" | "full", seen: { padding: MapPadding | null }): Promise<HTMLElement> {
  await act(async () => {
    root!.render(
      <SplitView
        label="Trips on the map"
        detent={detent}
        onDetentChange={() => undefined}
        content={<div>rows</div>}
        map={(padding) => {
          seen.padding = padding;
          return <div data-test-map="" />;
        }}
      />,
    );
  });
  // The box measurement runs through the ResizeObserver stub.
  await act(async () => {
    fireResize();
  });
  return container!;
}

describe("sheet-mode map box (#377 slice 1)", () => {
  it("ends the map box at the BOTTOM OF THE SHEET'S CORNERS, not its flat edge (#377 follow-up)", async () => {
    // The rounded top shoulders of the sheet leave a 16px notch of page
    // backdrop beside its straight side edges; the map box extends by the
    // corner radius so the notch shows map instead. Niko, 2026-09-22:
    // "align to the bottom of the sheet side borders".
    const seen: { padding: MapPadding | null } = { padding: null };
    const el = await mountSheet("half", seen);
    const wrapper = el.querySelector("[data-sheet-map-box]") as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(SHEET_CORNER_RADIUS_PX).toBe(16); // rounded-t-2xl — keep in sync with Sheet.tsx
    expect(wrapper.style.bottom).toBe(`${detentOcclusionPx("half", box.h) - SHEET_CORNER_RADIUS_PX}px`);
    expect(wrapper.style.bottom).toBe("384px");
  });

  it("measures the occlusion from the OUTER box at every detent (minus the corner radius)", async () => {
    for (const [detent, want] of [["peek", "104px"], ["half", "384px"], ["full", "704px"]] as const) {
      const seen: { padding: MapPadding | null } = { padding: null };
      const el = await mountSheet(detent, seen);
      const wrapper = el.querySelector("[data-sheet-map-box]") as HTMLElement;
      expect(wrapper.style.bottom).toBe(want);
      expect(wrapper.style.bottom).toBe(`${detentOcclusionPx(detent, 800) - SHEET_CORNER_RADIUS_PX}px`);
      await act(async () => {
        root!.render(<div />);
      });
    }
  });

  it("hands the camera chrome-only padding — the sheet is not counted twice", async () => {
    const seen: { padding: MapPadding | null } = { padding: null };
    await mountSheet("half", seen);
    expect(seen.padding).toBeTruthy();
    expect(seen.padding!.bottom).toBe(CHROME_PADDING.bottom);
    expect(seen.padding!.bottom).not.toBe(CHROME_PADDING.bottom + detentOcclusionPx("half", box.h));
    expect(seen.padding!.top).toBe(CHROME_PADDING.top);
  });

  it("leaves the attribution chrome untranslated in sheet mode", async () => {
    const seen: { padding: MapPadding | null } = { padding: null };
    const el = await mountSheet("half", seen);
    const outer = el.querySelector(".map-surface") as HTMLElement;
    expect(outer).toBeTruthy();
    expect(outer.style.getPropertyValue("--map-chrome-y")).toBe("0px");
  });
});

/**
 * #392 — the map must NOT remount when the surface mode changes.
 *
 * `SplitView` used to `return` from two different JSX roots with `map(padding)`
 * inline in each, so React reconciled across two unrelated trees on every mode
 * change and unmounted the map. `useSurfaceMode` re-reads on resize AND
 * orientationchange, so rotating a phone destroyed the MapLibre instance: the
 * basemap re-downloaded, the `!ready` skeleton pulsed over it, and the camera
 * reset (measured by scripts/probe-map-surface-mode.py — 2 instances/rotate).
 *
 * The assertion is the DOM node's IDENTITY, not its shape: a remounted element
 * is a different object, so tagging the map child and holding the reference
 * across the mode change is exactly "did React throw it away". A `key` would
 * NOT fix this — the roots differ, so identity is what matters.
 */
describe("map identity across surface modes (#392)", () => {
  /** Render SplitView, tagging the map child so a remount is detectable. */
  async function mount(): Promise<HTMLElement> {
    await act(async () => {
      root!.render(
        <SplitView
          label="The route"
          detent="half"
          onDetentChange={() => undefined}
          content={<div>rows</div>}
          map={() => <div data-test-map="" />}
        />,
      );
    });
    await act(async () => {
      fireResize();
    });
    return container!;
  }

  it("keeps the SAME map element when the mode changes (no remount)", async () => {
    // `useSurfaceMode` reads matchMedia; drive the ladder the way a rotate does.
    const mql = (matches: boolean) =>
      ((query: string) => ({
        matches: query === "(min-width: 768px)" ? matches : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia;

    // 1. sheet (phone portrait) — the map child is mounted.
    window.matchMedia = mql(false);
    let el = await mount();
    const first = el.querySelector("[data-test-map]") as HTMLElement;
    expect(first).toBeTruthy();

    // 2. cross into a wide viewport (rotate / breakpoint) and re-render.
    window.matchMedia = mql(true);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    el = container!;
    const second = el.querySelector("[data-test-map]") as HTMLElement;
    expect(second).toBeTruthy();

    // THE assertion: same node object, so React never unmounted the map.
    expect(second).toBe(first);
  });
});
