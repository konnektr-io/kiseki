// @vitest-environment jsdom
/**
 * The signed-in home's map (#249, slice 3).
 *
 * The canvas itself is verified where it can actually be seen — the browser
 * pass, checking pins land, the attribution is on screen, and zero console
 * errors. These tests pin what a unit test can hold honestly, mirroring the
 * `LandingMap.test.tsx` contract:
 *
 * - **Without JavaScript the home still shows places** — the placeholder names
 *   the pin count, and the map container is idle (nothing constructed).
 * - **One marker per pin, nothing invented** — a trip the geo read did not
 *   list gets no pin, full stop.
 * - **Stage colour comes from the one class map** (`pinClassForStage`), and
 *   selection speaks the trip-map grammar (`route-pin` / `is-selected` /
 *   `route-map-focused` — no second marker language).
 * - **Colliding pins group into a count badge** that zooms in on tap.
 * - **Empty geo builds no map at all** — the home collapses the canvas.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeMapPin } from "../lib/home-geo";

const PINS: HomeMapPin[] = [
  { dtId: "a", title: "Ski Week", stage: "booked", lat: 50.9981, lng: -118.1957, name: "Revelstoke", origin: "mine" },
  { dtId: "b", title: "Dolomites", stage: "planned", lat: 46.4102, lng: 11.844, name: "Val Gardena", origin: "discover" },
];

/** Set false to play a browser without WebGL2. */
const webgl = vi.hoisted(() => ({ ok: true }));

/** What maplibre was asked to draw. */
const calls = vi.hoisted(() => ({
  map: null as Record<string, unknown> | null,
  /** Every marker construction: its accessible label + coordinates. */
  markers: [] as { label: string | null; at: [number, number] }[],
  /** Live marker elements, in construction order. */
  elements: [] as HTMLElement[],
  fit: null as Record<string, unknown> | null,
  jumps: [] as Record<string, unknown>[],
  zooms: [] as string[],
  handlers: {} as Record<string, (() => void)[]>,
  /** Screen projection — per test: spread (no clustering) or collide. */
  project: "spread" as "spread" | "collide",
}));

/** Screen position per mode: spread keeps pins apart, collide stacks them. */
function projectPoint(lng: number, _lat: number): { x: number; y: number } {
  if (calls.project === "collide") return { x: 100, y: 100 };
  return { x: lng * 10, y: 200 };
}

vi.mock("../lib/maps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/maps")>()),
  hasWebGL2: () => webgl.ok,
  // jsdom has no matchMedia — the camera always takes the instant path here.
  prefersReducedMotion: () => true,
}));

// The loader is the seam the app owns, so the fake plugs in there: no WebGL,
// no canvas, and the test still sees exactly what the component would ask for.
vi.mock("../lib/maplibre", () => ({
  loadMapLibre: async () => ({
    Map: class {
      container: HTMLElement;
      constructor(options: Record<string, unknown>) {
        calls.map = options;
        this.container = options.container as HTMLElement;
      }
      on(event: string, cb: () => void) {
        (calls.handlers[event] ??= []).push(cb);
      }
      once(event: string, cb: () => void) {
        if (event === "load") cb();
      }
      loaded() {
        return false;
      }
      getCanvas() {
        return { setAttribute: () => undefined };
      }
      project([lng, lat]: [number, number]) {
        return projectPoint(lng, lat);
      }
      unproject([x, y]: [number, number]) {
        return { lng: x, lat: y };
      }
      fitBounds(_bounds: unknown, options: Record<string, unknown>) {
        calls.fit = options;
      }
      jumpTo(options: Record<string, unknown>) {
        calls.jumps.push(options);
      }
      easeTo(options: Record<string, unknown>) {
        calls.jumps.push(options);
      }
      getZoom() {
        return 5;
      }
      zoomIn() {
        calls.zooms.push("in");
      }
      zoomOut() {
        calls.zooms.push("out");
      }
      remove() {}
    },
    Marker: class {
      el: HTMLElement;
      constructor(options: { element: HTMLElement }) {
        this.el = options.element;
        calls.elements.push(this.el);
      }
      setLngLat(at: [number, number]) {
        calls.markers.push({ label: this.el.getAttribute("aria-label"), at });
        return this;
      }
      addTo(map: { container: HTMLElement }) {
        map.container.appendChild(this.el);
        return this;
      }
      remove() {
        this.el.remove();
      }
    },
    LngLatBounds: class {
      extend() {}
    },
  }),
}));

const { HomeMap } = await import("./HomeMap");
const { MAP_STYLE_URL, pinClassForStage } = await import("../lib/maps");

function fire(event: string): void {
  for (const cb of calls.handlers[event] ?? []) cb();
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  calls.map = null;
  calls.markers = [];
  calls.elements = [];
  calls.fit = null;
  calls.jumps = [];
  calls.zooms = [];
  calls.handlers = {};
  calls.project = "spread";
  webgl.ok = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(node: ReactElement): Promise<HTMLElement> {
  await act(async () => {
    root!.render(node);
  });
  return container!;
}

const noop = () => undefined;

describe("without a browser", () => {
  it("names the pin count instead of an empty box, and builds no map", () => {
    const html = renderToString(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(html).toContain("Map of 2 trip locations");
    expect(html).toContain('data-home-map="idle"');
    expect(calls.map).toBeNull();
  });

  it("says honestly when there is nothing to show", () => {
    const html = renderToString(<HomeMap pins={[]} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(html).toContain("No located trips yet");
    expect(html).not.toContain("data-home-map");
    expect(calls.map).toBeNull();
  });
});

describe("the real map, once it can load", () => {
  it("asks for the keyless style and keeps the attribution", async () => {
    await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.map).toBeTruthy();
    expect(calls.map!.style).toBe(MAP_STYLE_URL);
    expect(calls.map!.attributionControl).toEqual({ compact: true });
  });

  it("drops one stage-coloured pin per trip, and nothing else", async () => {
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.markers).toEqual([
      { label: "Ski Week — Revelstoke", at: [-118.1957, 50.9981] },
      { label: "Dolomites — Val Gardena", at: [11.844, 46.4102] },
    ]);
    // The pin's colour is the one class map — booked filled, planned muted.
    const dots = [...el.querySelectorAll("[data-home-map] .route-pin-dot")];
    expect(dots).toHaveLength(2);
    expect(dots[0].className).toContain(pinClassForStage("booked").split(" ").pop()!);
    expect(dots[1].className).toContain(pinClassForStage("planned").split(" ").pop()!);
    // Every pin is a labelled 44px button — the bands are the list equivalent,
    // but pointer and keyboard reach the same trips.
    const buttons = [...el.querySelectorAll("[data-home-map] button")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("aria-label")).toBe("Ski Week — Revelstoke");
  });

  it("never renders a trip the geo read did not list", async () => {
    await mount(<HomeMap pins={[PINS[0]]} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.markers).toHaveLength(1);
    expect(calls.markers[0].label).not.toContain("Dolomites");
  });

  it("frames the pins, centred on a lone one", async () => {
    await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 1, right: 2, bottom: 3, left: 4 }} />);
    expect(calls.fit).toMatchObject({ padding: { top: 1, right: 2, bottom: 3, left: 4 }, maxZoom: 12 });
    calls.fit = null;
    calls.jumps = [];
    await mount(<HomeMap pins={[PINS[0]]} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.jumps[0]).toMatchObject({ center: [-118.1957, 50.9981], zoom: 10 });
  });
});

describe("band↔pin linkage", () => {
  it("raises the selected pin and dims the rest, in the trip-map grammar", async () => {
    const el = await mount(<HomeMap pins={PINS} selectedDtId="b" onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const map = el.querySelector("[data-home-map]")!;
    expect(map.classList.contains("route-map-focused")).toBe(true);
    const raised = map.querySelector('[data-pin="b"]')!;
    const dimmed = map.querySelector('[data-pin="a"]')!;
    expect(raised.classList.contains("is-selected")).toBe(true);
    expect(dimmed.classList.contains("is-selected")).toBe(false);
  });

  it("restyles in place when the selection moves, without rebuilding", async () => {
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const built = calls.elements.length;
    await act(async () => {
      root!.render(<HomeMap pins={PINS} selectedDtId="a" onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    });
    expect(calls.elements.length).toBe(built);
    expect(el.querySelector('[data-pin="a"]')!.classList.contains("is-selected")).toBe(true);
  });

  it("a pin tap selects its trip", async () => {
    const onSelect = vi.fn();
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={onSelect} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const pin = el.querySelector('[data-pin="a"]') as HTMLElement;
    await act(async () => {
      pin.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});

describe("clustering", () => {
  it("groups colliding pins into one count badge", async () => {
    calls.project = "collide";
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const badges = [...el.querySelectorAll("[data-home-map] button")];
    expect(badges).toHaveLength(1);
    expect(badges[0].getAttribute("aria-label")).toBe("2 trips — zoom in");
    expect(badges[0].textContent).toBe("2");
  });

  it("a cluster tap zooms in", async () => {
    calls.project = "collide";
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const badge = el.querySelector("[data-home-map] button") as HTMLElement;
    await act(async () => {
      badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.jumps[0]).toMatchObject({ zoom: 7 });
  });

  it("re-clusters when the view moves", async () => {
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(el.querySelectorAll("[data-home-map] button")).toHaveLength(2);
    calls.project = "collide";
    await act(async () => {
      fire("moveend");
    });
    expect(el.querySelectorAll("[data-home-map] button")).toHaveLength(1);
  });
});

describe("zoom controls", () => {
  it("zooms on the labelled buttons, once the map is ready", async () => {
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const zoomIn = el.querySelector('button[aria-label="Zoom in"]') as HTMLElement;
    const zoomOut = el.querySelector('button[aria-label="Zoom out"]') as HTMLElement;
    await act(async () => {
      zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      zoomOut.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.zooms).toEqual(["in", "out"]);
  });

  it("renders no zoom without pins", () => {
    const html = renderToString(
      <HomeMap pins={[]} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />,
    );
    expect(html).not.toContain("Zoom in");
  });
});

describe("empty geo and missing WebGL2", () => {
  it("builds no map when there is nothing to pin", async () => {
    const el = await mount(<HomeMap pins={[]} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.map).toBeNull();
    expect(el.querySelector("[data-home-map]")).toBeNull();
    expect(el.textContent).toContain("No located trips yet");
  });

  it("keeps the placeholder and never loads maplibre without WebGL2", async () => {
    webgl.ok = false;
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.map).toBeNull();
    expect(el.querySelector("[data-home-map]")!.getAttribute("data-home-map")).toBe("no-webgl2");
  });
});
