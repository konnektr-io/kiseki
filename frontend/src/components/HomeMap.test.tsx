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
  /** How many times a camera was computed for the pin set (a re-frame = a 2nd). */
  fits: 0,
  /** The options the fit asked MapLibre for (padding, maxZoom). */
  cameraOptions: null as Record<string, unknown> | null,
  /** The bounding box the fit was computed over — unfolded longitudes. */
  bounds: null as { minLng: number; maxLng: number; minLat: number; maxLat: number } | null,
  jumps: [] as Record<string, unknown>[],
  zooms: [] as string[],
  /** `map.resize()` calls — the canvas keeping up with its container. */
  resizes: 0,
  handlers: {} as Record<string, (() => void)[]>,
  /** Screen projection — per test: spread (no clustering) or collide. */
  project: "spread" as "spread" | "collide",
  /** What the globe was asked for — `setProjection` / `setSky` recordings. */
  projections: [] as unknown[],
  skies: [] as unknown[],
  /** The camera centre the horizon check reads — faces both PINS by default. */
  center: { lng: -53, lat: 49 },
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
      getCenter() {
        return { ...calls.center };
      }
      setProjection(p: unknown) {
        calls.projections.push(p);
      }
      setSky(s: unknown) {
        calls.skies.push(s);
      }
      fitBounds(_bounds: unknown, options: Record<string, unknown>) {
        calls.fit = options;
        calls.fits += 1;
      }
      /**
       * The app computes the camera itself and applies it (see `framePins`):
       * MapLibre's `fitBounds` goes through `flyTo`, whose arc was measured
       * leaving zoom/latitude behind on a zoom-out. The fake answers with the
       * midpoint of whatever box it was handed, at a fixed zoom — so a test can
       * assert WHICH box the fit was computed over.
       */
      cameraForBounds(bounds: { minLng: number; maxLng: number; minLat: number; maxLat: number }, options: Record<string, unknown>) {
        calls.fits += 1;
        calls.cameraOptions = options;
        calls.bounds = { ...bounds };
        return {
          center: { lng: (bounds.minLng + bounds.maxLng) / 2, lat: (bounds.minLat + bounds.maxLat) / 2 },
          zoom: 3,
        };
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
      resize() {
        calls.resizes += 1;
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
      minLng = Infinity;
      maxLng = -Infinity;
      minLat = Infinity;
      maxLat = -Infinity;
      extend(at: [number, number]) {
        this.minLng = Math.min(this.minLng, at[0]);
        this.maxLng = Math.max(this.maxLng, at[0]);
        this.minLat = Math.min(this.minLat, at[1]);
        this.maxLat = Math.max(this.maxLat, at[1]);
      }
    },
    LngLat: {
      convert(value: unknown) {
        if (Array.isArray(value)) return { lng: value[0], lat: value[1] };
        const v = value as { lng: number; lat: number };
        return { lng: v.lng, lat: v.lat };
      },
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

/**
 * The container's measured box. jsdom reports 0×0 for every element, which is
 * exactly the state this component must refuse to fit into — so the harness
 * drives it explicitly, and can resize it mid-test.
 */
const box = { w: 390, h: 783 };

/** ResizeObserver is not in jsdom: record the callbacks so a test can fire them. */
const observers = { callbacks: [] as (() => void)[] };

class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    observers.callbacks.push(() => this.cb([], this as unknown as ResizeObserver));
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Fire every observed container resize, as the browser would. */
function fireResize(): void {
  for (const cb of observers.callbacks) cb();
}

beforeEach(() => {
  calls.map = null;
  calls.markers = [];
  calls.elements = [];
  calls.fit = null;
  calls.fits = 0;
  calls.cameraOptions = null;
  calls.bounds = null;
  calls.jumps = [];
  calls.zooms = [];
  calls.resizes = 0;
  calls.handlers = {};
  calls.project = "spread";
  calls.projections = [];
  calls.skies = [];
  calls.center = { lng: -53, lat: 49 };
  webgl.ok = true;
  box.w = 390;
  box.h = 783;
  observers.callbacks = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => box.w,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => box.h,
  });
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

  it("frames the pins with the sheet's padding, and centres a lone one", async () => {
    await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 1, right: 2, bottom: 3, left: 4 }} />);
    expect(calls.cameraOptions).toMatchObject({ padding: { top: 1, right: 2, bottom: 3, left: 4 }, maxZoom: 12 });
    // The computed camera is APPLIED (not passed to fitBounds, whose flyTo arc
    // was measured dropping zoom/latitude on a zoom-out).
    const framed = calls.jumps[0] as { center: [number, number]; zoom: number };
    expect(framed.zoom).toBe(3);
    expect(framed.center[0]).toBeCloseTo(-53.17585, 4);
    expect(framed.center[1]).toBeCloseTo(48.70415, 4);
    calls.jumps = [];
    await mount(<HomeMap pins={[PINS[0]]} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.jumps[0]).toMatchObject({ center: [-118.1957, 50.9981], zoom: 10 });
  });
});

describe("the pin set's bounding box", () => {
  /** Canada, Chile and Japan — three continents, one of them across the date line. */
  const WORLD: HomeMapPin[] = [
    { dtId: "ca", title: "Canada", stage: "booked", lat: 51.1784, lng: -114.06, name: "YYC", origin: "mine" },
    { dtId: "cl", title: "Chile", stage: "planned", lat: -33.4489, lng: -70.66, name: "Santiago", origin: "mine" },
    { dtId: "jp", title: "Japan", stage: "idea", lat: 42.78, lng: 141.35, name: "New Chitose", origin: "mine" },
  ];

  it("measures the set by its shortest arc, not the long way round", async () => {
    await mount(<HomeMap pins={WORLD} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    // Long way round: −114.06 … 141.35 = 255° centred on Africa, which no zoom
    // can show on a 390px phone. Shortest arc: Japan eastward to Chile = 148°.
    expect(calls.bounds!.minLng).toBeCloseTo(141.35, 4);
    expect(calls.bounds!.maxLng).toBeCloseTo(289.34, 4);
    // The centre comes back OUT of the unfolded frame: +215° is −145°.
    const framed = calls.jumps[0] as { center: [number, number] };
    expect(framed.center[0]).toBeCloseTo(-144.655, 3);
    expect(framed.center[1]).toBeCloseTo(8.86475, 3);
  });

  it("leaves a set that does not cross the date line alone", async () => {
    const EUROPE: HomeMapPin[] = [
      { dtId: "a", title: "A", stage: "idea", lat: 46.4, lng: 11.84, name: "Val Gardena", origin: "mine" },
      { dtId: "b", title: "B", stage: "idea", lat: 47.4, lng: 13.4, name: "Salzburg", origin: "mine" },
    ];
    await mount(<HomeMap pins={EUROPE} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.bounds!.minLng).toBeCloseTo(11.84, 4);
    expect(calls.bounds!.maxLng).toBeCloseTo(13.4, 4);
    const framed = calls.jumps[0] as { center: [number, number] };
    expect(framed.center[0]).toBeCloseTo(12.62, 3);
    expect(framed.center[1]).toBeCloseTo(46.9, 3);
  });

  it("the three-continent set spans less than a hemisphere — one globe face holds it", async () => {
    // 148° < 180°: the flat-measured shortest-arc fit still frames on the
    // globe. The fit input carries no width-specific branch, so phone
    // (390px, sheet at half) and desktop (1440px, rail) frame the same box —
    // one test per width, fresh harness each.
    const frameWorld = async () => {
      await mount(<HomeMap pins={WORLD} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
      expect(calls.bounds!.maxLng - calls.bounds!.minLng).toBeCloseTo(147.99, 1);
      expect(calls.bounds!.maxLng - calls.bounds!.minLng).toBeLessThan(180);
      const framed = calls.jumps[0] as { center: [number, number] };
      expect(framed.center[0]).toBeGreaterThanOrEqual(-180);
      expect(framed.center[0]).toBeLessThan(180);
    };
    box.w = 390;
    box.h = 783;
    await frameWorld();
  });

  it("the three-continent set spans less than a hemisphere at desktop width", async () => {
    box.w = 1440;
    box.h = 900;
    await mount(<HomeMap pins={WORLD} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.bounds!.maxLng - calls.bounds!.minLng).toBeCloseTo(147.99, 1);
    expect(calls.bounds!.maxLng - calls.bounds!.minLng).toBeLessThan(180);
    const framed = calls.jumps[0] as { center: [number, number] };
    expect(framed.center[0]).toBeGreaterThanOrEqual(-180);
    expect(framed.center[0]).toBeLessThan(180);
  });
});

describe("the landing globe (#372 slice 1)", () => {
  it("renders on a globe with the token-sky atmosphere — never hex, never a second rule", async () => {
    await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    expect(calls.projections).toEqual([{ type: "globe" }]);
    expect(calls.skies).toHaveLength(1);
    const sky = calls.skies[0] as Record<string, unknown>;
    expect(sky["sky-color"]).toBeTruthy();
    expect(sky["horizon-color"]).toBeTruthy();
    expect(String(sky["sky-color"])).not.toMatch(/^#/);
    expect(String(sky["horizon-color"])).not.toMatch(/^#/);
  });

  it("a pin over the horizon never clusters with visible ones", async () => {
    // Every projection lands on the same pixel — on Mercator this is one
    // badge. With a North-Pacific camera Revelstoke faces (37°) while Val
    // Gardena is far-side (103°), so the far-side pin must stand alone.
    calls.project = "collide";
    calls.center = { lng: -160, lat: 30 };
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const buttons = [...el.querySelectorAll("[data-home-map] button")];
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute("aria-label")).sort()).toEqual([
      "Dolomites — Val Gardena",
      "Ski Week — Revelstoke",
    ]);
  });

  it("far-side pins still cluster with each other", async () => {
    // South-Atlantic camera: both pins over the horizon, same pixel — one
    // far-side badge, not two lone pins and never mixed into a visible set.
    calls.project = "collide";
    calls.center = { lng: -30, lat: -50 };
    const el = await mount(<HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
    const badges = [...el.querySelectorAll("[data-home-map] button")];
    expect(badges).toHaveLength(1);
    expect(badges[0].getAttribute("aria-label")).toBe("2 trips — zoom in");
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
    expect(calls.jumps.at(-1)).toMatchObject({ zoom: 7 });
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

describe("the container owns its size", () => {
  const at = (padding = { top: 0, right: 0, bottom: 0, left: 0 }) =>
    <HomeMap pins={PINS} selectedDtId={null} onSelect={noop} padding={padding} />;

  it("gives the map box its own height instead of relying on `absolute`", async () => {
    const el = await mount(at());
    const map = el.querySelector("[data-home-map]")!;
    // Load-bearing: MapLibre adds its `maplibregl-map` class to this element,
    // and that class's UNLAYERED `position: relative` beats Tailwind's
    // `.absolute` — an absolutely-positioned box with no in-flow children
    // collapses to 0 and the map measures 0 (the shipped phone bug).
    expect(map.className).toContain("h-full");
    expect(map.className).toContain("w-full");
    expect(map.className).not.toContain("absolute");
  });

  it("never fits an empty box, and recovers when the box becomes real", async () => {
    // The container is 0-tall at build time (the phone case): fitting into it
    // is the no-op that parks the camera on null island.
    box.w = 0;
    box.h = 0;
    const el = await mount(at());
    expect(calls.fits).toBe(0);
    expect(el.querySelector("[data-home-map]")!.getAttribute("data-home-map")).toBe("idle");

    // …and the moment it has a real box, the canvas and the camera catch up.
    box.w = 390;
    box.h = 783;
    const resizesBefore = calls.resizes;
    await act(async () => {
      fireResize();
    });
    expect(calls.resizes).toBeGreaterThan(resizesBefore);
    expect(calls.fits).toBe(1);
    expect(el.querySelector("[data-home-map]")!.getAttribute("data-home-map")).toBe("ready");
  });

  it("re-fits when the container resizes, and only then", async () => {
    await mount(at());
    expect(calls.fits).toBe(1);

    box.w = 900;
    box.h = 600; // the rail dragged narrower
    const resizesBefore = calls.resizes;
    await act(async () => {
      fireResize();
    });
    expect(calls.resizes).toBe(resizesBefore + 1);
    expect(calls.fits).toBe(2);

    // A resize that changes nothing must not re-frame — the camera is not a
    // render artefact (§10).
    await act(async () => {
      fireResize();
    });
    expect(calls.resizes).toBe(resizesBefore + 2);
    expect(calls.fits).toBe(2);
  });

  it("re-fits when the sheet detent moves the camera padding", async () => {
    await mount(at({ top: 36, right: 44, bottom: 444, left: 64 }));
    expect(calls.fits).toBe(1);
    await act(async () => {
      root!.render(at({ top: 36, right: 44, bottom: 120, left: 64 }));
    });
    // A whole new map would throw the camera away; a re-fit keeps it.
    expect(calls.fits).toBe(2);
    expect(calls.cameraOptions).toMatchObject({ padding: { top: 36, right: 44, bottom: 120, left: 64 } });
  });

  it("stops moving the camera once the viewer takes over", async () => {
    await mount(at());
    const fitted = calls.fits;
    // A real gesture: MapLibre sets `originalEvent` only for those.
    await act(async () => {
      for (const cb of calls.handlers["dragstart"] ?? []) {
        (cb as unknown as (e: { originalEvent: unknown }) => void)({ originalEvent: {} });
      }
    });
    box.w = 900;
    await act(async () => {
      fireResize();
    });
    await act(async () => {
      root!.render(at({ top: 36, right: 44, bottom: 120, left: 64 }));
    });
    expect(calls.fits).toBe(fitted); // theirs now — resize only
    expect(calls.resizes).toBeGreaterThan(0);
  });
});
