import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

/**
 * MapLibre is loaded on demand, once per session.
 *
 * It is ~800 kB of WebGL renderer and most pages have no map on them, so it
 * stays out of the entry bundle — the same reason the Google JS API used to be
 * injected lazily. Vite code-splits the dynamic import automatically.
 *
 * `setWorkerUrl` is mandatory for bundled builds in v6 (the worker can no
 * longer find itself via `import.meta.url` inside a bundler's module graph),
 * and Vite needs `?worker&url` rather than plain `?url` — plain `?url` emits
 * the worker without its sibling `maplibre-gl-shared.mjs` and no tile ever
 * loads in production.
 *
 * The promise is module-level on purpose: there are two map components now
 * (`MapView` for cards and the booklet, `RouteMap` for the #39 route surface)
 * and `setWorkerUrl` must run exactly once, before the first `Map`.
 */
let libPromise: Promise<typeof import("maplibre-gl")> | null = null;

export function loadMapLibre() {
  if (!libPromise) {
    libPromise = import("maplibre-gl").then((lib) => {
      lib.setWorkerUrl(workerUrl);
      return lib;
    });
  }
  return libPromise;
}
