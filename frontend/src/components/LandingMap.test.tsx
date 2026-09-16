// @vitest-environment jsdom
/**
 * The landing page's map (#249).
 *
 * The map itself is verified where it can actually be seen — the browser pass, with
 * SwiftShader for WebGL2, checking that tiles arrive from OpenFreeMap and that the
 * attribution is on screen. These tests pin the three things a unit test can hold
 * honestly, and each is a property the app depends on:
 *
 * - **Without JavaScript, or without WebGL2, the band still shows a map** — the drawn
 *   route, which is what the prerender ships and what holds the box's height.
 * - **The attribution is not optional.** OpenFreeMap's tiles are community-funded;
 *   the credit is why a public page may use them at all, so `attributionControl` is
 *   asserted on the constructor rather than trusted.
 * - **It never hijacks the page's scroll**, and it draws one numbered pin per stop.
 * - **The roads come from one fixed endpoint, and the credit follows the data.**
 *   `GET /api/landing-route` is the only URL the map ever fetches; the "© HERE"
 *   caption renders only when that fetch answered road geometry.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STOPS = [
  { name: "Shinjuku Gyoen", lng: 139.70955, lat: 35.68507 },
  { name: "Golden Gai", lng: 139.7047, lat: 35.69399 },
];

/** Set false to play a browser without WebGL2. */
const webgl = vi.hoisted(() => ({ ok: true }));

/** What maplibre was asked to draw. */
const calls = vi.hoisted(() => ({
  map: null as Record<string, unknown> | null,
  markers: [] as [number, number][],
  layers: [] as string[],
  markersBuilt: 0,
  sources: {} as Record<string, unknown>,
  fetched: [] as string[],
}));

/** The road-geometry fetch. Per test: "roads" (real geometry), "straight"
 *  (`road: false`), "garbage" (a malformed answer), or "down" (throws). */
const net = vi.hoisted(() => ({ mode: "straight" as "roads" | "straight" | "garbage" | "down" }));

const ROAD_COORDS: [number, number][] = [
  [139.70955, 35.68507],
  [139.71, 35.686],
  [139.7047, 35.69399],
];

vi.mock("../lib/maps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/maps")>()),
  hasWebGL2: () => webgl.ok,
}));

// The loader is the seam the app owns, so the fake plugs in there: no WebGL, no
// canvas, and the test still sees exactly what the component would ask for.
vi.mock("../lib/maplibre", () => ({
  loadMapLibre: async () => ({
    Map: class {
      constructor(options: Record<string, unknown>) {
        calls.map = options;
      }
      on() {}
      once(event: string, cb: () => void) {
        if (event === "load") cb();
      }
      loaded() {
        return false;
      }
      getCanvas() {
        return { setAttribute: () => undefined };
      }
      addSource(id: string, source: unknown) {
        calls.sources[id] = source;
      }
      addLayer(layer: { id: string }) {
        calls.layers.push(layer.id);
      }
      remove() {}
    },
    Marker: class {
      constructor() {
        calls.markersBuilt += 1;
      }
      setLngLat(coords: [number, number]) {
        calls.markers.push(coords);
        return this;
      }
      addTo() {
        return this;
      }
    },
    LngLatBounds: class {
      extend() {}
    },
  }),
}));

const { LandingMap } = await import("./LandingMap");
const { MAP_STYLE_URL } = await import("../lib/maps");

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    calls.fetched.push(url);
    if (net.mode === "down") throw new Error("no backend");
    return {
      ok: true,
      json: async () =>
        net.mode === "roads"
          ? { road: true, coordinates: ROAD_COORDS }
          : net.mode === "garbage"
            ? { road: true, coordinates: [["a", "b"]] }
            : { road: false, coordinates: [[139.70955, 35.68507]] },
    };
  }),
);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  calls.map = null;
  calls.markers = [];
  calls.layers = [];
  calls.markersBuilt = 0;
  calls.sources = {};
  calls.fetched = [];
  net.mode = "straight";
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

const DRAWN_ROUTE = "A route drawn as a dashed line through five numbered stops";

describe("without a browser", () => {
  it("renders the drawn route, not an empty box", () => {
    const html = renderToString(<LandingMap stops={STOPS} />);
    expect(html).toContain(DRAWN_ROUTE);
    // The map container is there but idle: nothing has been asked for yet.
    expect(html).toContain('data-landing-map="idle"');
    expect(calls.map).toBeNull();
  });

  it("lists no map library in the markup", () => {
    // The drawn route is a placeholder for the prerender to carry; the map is
    // script-driven and must never be assumed present.
    expect(renderToString(<LandingMap stops={STOPS} />)).not.toContain("maplibre");
  });
});

describe("the real map, once it can load", () => {
  it("asks for the keyless OpenFreeMap style and keeps the attribution", async () => {
    await mount(<LandingMap stops={STOPS} />);
    expect(calls.map).toBeTruthy();
    expect(calls.map!.style).toBe(MAP_STYLE_URL);
    // Load-bearing: without the credit the tiles may not be used on a public page.
    expect(calls.map!.attributionControl).toEqual({ compact: true });
  });

  it("never hijacks the page's scroll, and does not rotate", async () => {
    await mount(<LandingMap stops={STOPS} />);
    expect(calls.map!.scrollZoom).toBe(false);
    expect(calls.map!.dragRotate).toBe(false);
    expect(calls.map!.pitchWithRotate).toBe(false);
  });

  it("drops one numbered pin per stop, and draws the route over the tiles", async () => {
    await mount(<LandingMap stops={STOPS} />);
    expect(calls.markers).toEqual([
      [139.70955, 35.68507],
      [139.7047, 35.69399],
    ]);
    expect(calls.layers).toEqual(["landing-route-casing", "landing-route-line"]);
  });

  it("fades the drawing out only once the map is ready", async () => {
    const el = await mount(<LandingMap stops={STOPS} />);
    const drawn = el.querySelector("svg")!.parentElement!;
    // `once("load")` fires immediately in the fake, so the map is ready by now.
    expect(drawn.className).toContain("opacity-0");
    expect(el.querySelector("[data-landing-map]")!.getAttribute("data-landing-map")).toBe("ready");
  });
});

describe("the road geometry", () => {
  function drawnLine(): unknown {
    const source = calls.sources["landing-route"] as {
      data: { geometry: { coordinates: unknown } };
    };
    return source.data.geometry.coordinates;
  }

  const STRAIGHT = [
    [139.70955, 35.68507],
    [139.7047, 35.69399],
  ];

  it("fetches exactly one fixed URL — never a trip, showcase or media read", async () => {
    await mount(<LandingMap stops={STOPS} />);
    expect(calls.fetched).toEqual(["/api/landing-route"]);
  });

  it("draws the returned roads and credits HERE", async () => {
    net.mode = "roads";
    const el = await mount(<LandingMap stops={STOPS} />);
    expect(drawnLine()).toEqual(ROAD_COORDS);
    expect(el.textContent).toContain("Road route © HERE");
  });

  it("keeps the straight stop-to-stop line when the backend answers road:false", async () => {
    const el = await mount(<LandingMap stops={STOPS} />);
    expect(drawnLine()).toEqual(STRAIGHT);
    expect(el.textContent).not.toContain("© HERE");
  });

  it("keeps the straight line when the fetch fails outright", async () => {
    net.mode = "down";
    const el = await mount(<LandingMap stops={STOPS} />);
    expect(drawnLine()).toEqual(STRAIGHT);
    expect(el.textContent).not.toContain("© HERE");
    expect(el.querySelector("[data-landing-map]")!.getAttribute("data-landing-map")).toBe("ready");
  });

  it("ignores a malformed answer instead of crashing the source", async () => {
    net.mode = "garbage";
    const el = await mount(<LandingMap stops={STOPS} />);
    expect(drawnLine()).toEqual(STRAIGHT);
    expect(el.textContent).not.toContain("© HERE");
  });
});

describe("a browser without WebGL2", () => {
  it("keeps the drawn route and never loads maplibre (v6 has no WebGL1 fallback)", async () => {
    webgl.ok = false;
    const el = await mount(<LandingMap stops={STOPS} />);
    expect(calls.map).toBeNull();
    expect(el.querySelector("[data-landing-map]")!.getAttribute("data-landing-map")).toBe(
      "no-webgl2",
    );
    expect(el.querySelector("svg")).toBeTruthy();
    // No maplibre markers were built either — the route pins are the drawing's own
    // numbers (the `12345` in the SVG), not DOM elements handed to a map.
    expect(calls.markersBuilt).toBe(0);
  });
});
