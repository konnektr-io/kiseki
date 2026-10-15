#!/usr/bin/env python3
"""
Reproduce (or clear) the trip-map crash PostHog recorded six times in 24 days:

    Error: Source "journey" already exists.   (7 events / 6 sessions, 2026-09-21 .. 10-15)
    Error: Source "day" already exists.       (2026-10-13, /t/:token/day/1)

Both levels of the trip surface add GeoJSON sources under FIXED ids — the scan
level `journey` + `journey-glyphs`, the day level `day` + `day-glyphs` +
`day-tracks` (`RouteMap.tsx`) — and both tear their own down in the level
effect's cleanup. MapLibre v6 does not forgive either half of that contract:

  * `Style.addSource` THROWS `Source "x" already exists.` when the id is taken
    (`style.ts`, no defensive branch) — so the throw takes the whole app to the
    error boundary ("Something went wrong. Please refresh the page and try
    again.", PostHog `$exception_handled: true` from `main.tsx`);
  * `Style.removeSource` does NOT throw when a layer still reads the source —
    it fires an error event and RETURNS — so a refused teardown leaves the
    source on the map silently, and the next build of that level is the build
    that dies.

WHAT THIS PROBE PINS is the invariant that class of failure violates: a build of
a level must survive its OWN source id already being live, with a layer reading
it and no bookkeeping for either. That is exactly the state a refused/aborted
teardown leaves behind, and the only state in which the fake is even reachable.

The leak is injected through the app's own map instance (the `__probeMap` hook
`RouteMap` exposes for `scripts/probe-*.py`), so nothing is stubbed: the app's
real level effect runs against it. The walk is in-app (`navigate()` keeps the
surface mounted, which is the whole design of this component), because a full
page load destroys the map and the bug class is unreproducible by construction.

  PHASE 1  scan -> inject a live, layer-reading `day` source -> open a day
  PHASE 2  day  -> inject a live, layer-reading `journey` source -> back to the itinerary

Pre-fix both phases die with the PostHog message; post-fix the sweep in
`releaseLevelResources` takes the leftovers off first and the level draws.

Run:  backend/.venv/bin/python scripts/probe-map-source-leak.py
      KISEKI_PROBE_DIST=/path/to/other/dist ... (run it against a pre-fix build —
      a case that has never failed proves nothing)
"""

import glob
import json
import os
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

FRONTEND = Path(__file__).resolve().parent.parent
DIST = Path(os.environ.get("KISEKI_PROBE_DIST", FRONTEND / "dist")).resolve()
OUT = Path(os.environ.get("KISEKI_PROBE_OUT", "/tmp/kiseki-probe-map-source-leak"))


# Playwright pins a revision that is not installed here; use whatever
# chromium_headless_shell the image actually has.
def _chromium() -> str | None:
    hits = sorted(glob.glob("/opt/hermes/.playwright/chromium_headless_shell-*/"
                            "chrome-headless-shell-linux64/chrome-headless-shell"))
    hits += sorted(glob.glob(str(Path.home() / ".cache/ms-playwright/chromium_headless_shell-*/"
                                 "chrome-headless-shell-linux64/chrome-headless-shell")))
    return hits[-1] if hits else None


CHROME = _chromium()

TRIP_ID = "b16680e7-a338-4c76-9cd7-fa13d45be594"

TRIP = {
    "id": TRIP_ID,
    "slug": "canada-2027-heliski",
    "title": "Canada 2027 — Heliski",
    "subtitle": "A week in the Selkirks",
    "stage": "live",
    "startDate": "2027-01-10",
    "endDate": "2027-01-20",
    "theme": {"preset": "alpine"},
    "coverStats": [],
    "stats": [],
    "features": [],
    "visibility": "public",
    "myRole": "owner",
    "locations": [
        {"id": "loc-1", "name": "Revelstoke", "lat": 51.00, "lng": -118.20, "marker": 1, "alias": []},
        {"id": "loc-2", "name": "Rogers Pass", "lat": 51.05, "lng": -117.85, "marker": 2, "alias": []},
        {"id": "loc-3", "name": "Glacier National Park", "lat": 51.50, "lng": -117.50, "marker": 3, "alias": []},
        {"id": "loc-4", "name": "Banff", "lat": 51.18, "lng": -115.57, "marker": 4, "alias": []},
        {"id": "loc-5", "name": "Canmore", "lat": 51.09, "lng": -115.35, "marker": 5, "alias": []},
    ],
    "sections": [
        {
            "id": "sec-0", "title": "Into the Selkirks", "order": 0, "days": [0, 2],
            "locationRefs": ["Revelstoke", "Rogers Pass", "Glacier National Park"], "body": "Drive north.",
        },
        {
            "id": "sec-1", "title": "East to Banff", "order": 1, "days": [3, 4],
            "locationRefs": ["Banff", "Canmore"], "body": "Across the Rockies.",
        },
    ],
    "days": [
        {
            "id": "day-0", "date": "2027-01-10", "title": "Arrive Revelstoke", "notes": "Land and settle in.",
            "blocks": [
                {"id": "blk-0", "kind": "transport", "title": "Settle in", "from": "Revelstoke",
                 "to": "Glacier National Park", "mode": "drive", "status": "done"},
                {"id": "blk-0b", "kind": "activity", "title": "Dinner", "location": "Revelstoke", "status": "done"},
            ],
        },
        {
            "id": "day-1", "date": "2027-01-11", "title": "Rogers Pass", "notes": "Long day over the pass.",
            "blocks": [
                {"id": "blk-1", "kind": "transport", "title": "Cross Rogers Pass", "from": "Revelstoke",
                 "to": "Glacier National Park", "mode": "drive", "status": "done"},
            ],
        },
        {
            "id": "day-2", "date": "2027-01-12", "title": "Glacier", "notes": "Heli day.",
            "blocks": [
                {"id": "blk-2", "kind": "activity", "title": "Heli day",
                 "location": "Glacier National Park", "status": "done"},
            ],
        },
        {
            "id": "day-3", "date": "2027-01-13", "title": "Banff", "notes": "Long transfer east.",
            "blocks": [
                {"id": "blk-3", "kind": "transport", "title": "Transpose to Banff", "from": "Glacier National Park",
                 "to": "Banff", "mode": "drive", "status": "done"},
            ],
        },
        {
            "id": "day-4", "date": "2027-01-14", "title": "Canmore", "notes": "Slow day.",
            "blocks": [
                {"id": "blk-4", "kind": "activity", "title": "Ride in Canmore",
                 "location": "Canmore", "status": "done"},
            ],
        },
    ],
    "crew": [],
    "practical": {},
}

# Installed before the bundle runs. `RouteMap` hands its live map instance over
# via `__probeMap`, so the probe can (a) watch every add/remove the app makes and
# (b) inject the leaked state through the app's OWN map.
INSTRUMENT = """
(() => {
  window.__mapCalls = [];
  window.__step = "boot";
  window.__map = null;
  window.__probeMap = (map) => {
    if (!map || map.__probePatched) return;
    map.__probePatched = true;
    if (!window.__map) window.__map = map;
    for (const m of ["addSource", "removeSource", "addLayer", "removeLayer"]) {
      const orig = map[m].bind(map);
      map[m] = function (...args) {
        const rec = { step: window.__step, op: m, id: String(args[0]) };
        window.__mapCalls.push(rec);
        try { return orig(...args); }
        catch (e) { rec.threw = String((e && e.message) || e); throw e; }
      };
    }
  };
  /** The state a refused or aborted teardown leaves: a live source of the
   *  level's own id, a layer reading it, and no bookkeeping for either. */
  window.__leak = (source, layer) => {
    const map = window.__map;
    if (!map) return "no map";
    map.addSource(source, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: layer, type: "line", source,
      paint: { "line-color": "#ff0000", "line-width": 6 },
    });
    return "leaked";
  };
  window.__inventory = () => {
    const map = window.__map;
    const sources = ["journey", "journey-glyphs", "day", "day-glyphs", "day-tracks"];
    const layers = ["leaked-journey", "leaked-day"];
    const out = { sources: {}, layers: {} };
    for (const id of sources) {
      try { out.sources[id] = map && map.getSource(id) ? "live" : "absent"; } catch (e) { out.sources[id] = "err"; }
    }
    for (const id of layers) {
      try { out.layers[id] = map && map.getLayer(id) ? "live" : "absent"; } catch (e) { out.layers[id] = "err"; }
    }
    return out;
  };
  window.__uncaught = [];
  addEventListener('error', (e) => {
    window.__uncaught.push(String((e.error && e.error.message) || e.message || 'error'));
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    window.__uncaught.push(String((r && r.message) || r));
  });
})();
"""


def log(msg):
    print(msg, flush=True)


def serve():
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(DIST), **kw)

        def send_head(self):
            p = Path(self.path.split("?")[0])
            if not p.is_file() and "." not in p.name:
                self.path = "/index.html"
            return super().send_head()

        def log_message(self, *args, **kwargs):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def run():
    if not DIST.is_dir():
        log(f"FAIL: {DIST} missing — run `vite build` first")
        return 2

    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    OUT.mkdir(parents=True, exist_ok=True)

    findings: dict[str, object] = {}
    page_errors: list[str] = []
    issues: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
        )
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
        )

        def handle(route):
            url = route.request.url
            if "/api/trips/" in url and url.rstrip("/").endswith(TRIP_ID):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(TRIP))
            elif "/api/maps/route/" in url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "legs": [{
                            "from": "Revelstoke", "to": "Glacier National Park", "road": True,
                            "duration": "2 hrs", "distance": "150 km",
                            "geometry": {"type": "LineString",
                                         "coordinates": [[-118.20, 51.00], [-118.10, 51.02], [-117.85, 51.05]]},
                        }]
                    }),
                )
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        ctx.route("**/api/**", handle)
        # Consent is a COOKIE (`lib/analytics-consent.ts`) — deny it before any
        # page script runs, so this probe writes nothing into the real PostHog
        # project and the banner cannot eat a click (product-analytics-integration,
        # standing rule).
        ctx.add_init_script(
            "try { document.cookie = 'kiseki_consent=denied; max-age=31536000; path=/; SameSite=Lax'; } catch (e) {}"
        )
        ctx.add_init_script(INSTRUMENT)

        page = ctx.new_page()
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        # Boot the scan level once; from here every hop is IN-APP so the map
        # instance survives (the whole point — RouteMap must not remount).
        log("→ boot the itinerary (scan level)")
        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        page.wait_for_selector(".route-pin", timeout=30000)
        try:
            no = page.get_by_role("button", name=re.compile("no thanks", re.I))
            if no.count():
                no.first.click(timeout=3000)
        except Exception:
            pass
        page.wait_for_timeout(2600)
        log(f"   scan level: {page.evaluate('window.__inventory()')}")

        def step(label, action):
            page.evaluate("(s) => { window.__step = s; }", label)
            try:
                action()
            except Exception as exc:
                # A phase that killed the app has no next control to click; the
                # boundary check below is the finding, not this timeout.
                log(f"   {label}: CLICK FAILED {type(exc).__name__}")
            page.wait_for_timeout(2600)
            body = page.inner_text("body")
            crashed = "Something went wrong" in body
            inv = page.evaluate("window.__inventory()")
            log(f"   {label}: {'ERROR BOUNDARY' if crashed else 'ok'}   {inv}")
            try:
                page.screenshot(path=str(OUT / f"{label}.png"))
            except Exception:
                pass
            return crashed

        # PHASE 1 — the day level must survive a live `day` source it does not
        # own, with a layer reading it.
        log('\n→ PHASE 1: leak "day" + leaked-day while on the scan level, then open a day')
        page.evaluate("() => window.__leak('day', 'leaked-day')")
        log(f"   injected: {page.evaluate('window.__inventory()')}")
        crashed = step("phase1-day", lambda: page.locator('a[href$="/day/0"]').first.click(timeout=10000))
        inv = page.evaluate("window.__inventory()")
        if crashed:
            log("   >>> PHASE 1: the day level died on its own source id")
            issues.append("phase1: error boundary")
        elif inv["layers"].get("leaked-day") != "absent" or inv["sources"].get("day") != "live":
            log(f"   >>> PHASE 1: the leak survived the build ({inv})")
            issues.append("phase1: leak survived")
        elif page.locator(".route-pin").count() == 0:
            log("   >>> PHASE 1: no pins drawn — the level built without content")
            issues.append("phase1: empty level")

        # PHASE 2 — the scan level must survive a live `journey` source.
        log('\n→ PHASE 2: leak "journey" + leaked-journey while on the day level, then go up')
        page.evaluate("() => window.__leak('journey', 'leaked-journey')")
        log(f"   injected: {page.evaluate('window.__inventory()')}")
        crashed = step(
            "phase2-scan",
            lambda: page.get_by_role("button", name=re.compile("back to the itinerary", re.I)).first.click(timeout=10000),
        )
        inv = page.evaluate("window.__inventory()")
        if crashed:
            log('   >>> PHASE 2: the scan level died on "journey"')
            issues.append("phase2: error boundary")
        elif inv["layers"].get("leaked-journey") != "absent" or inv["sources"].get("journey") != "live":
            log(f"   >>> PHASE 2: the leak survived the build ({inv})")
            issues.append("phase2: leak survived")
        elif page.locator(".route-pin").count() == 0:
            log("   >>> PHASE 2: no pins drawn — the level built without content")
            issues.append("phase2: empty level")

        findings["mapCalls"] = page.evaluate("window.__mapCalls") or []
        findings["uncaught"] = page.evaluate("window.__uncaught") or []
        browser.close()
    httpd.shutdown()

    calls = findings["mapCalls"]
    threw = [c for c in calls if c.get("threw")]
    log("\n=== map calls ===")
    log(f"total: {len(calls)}   page errors: {page_errors or 'none'}")
    log(f"uncaught: {findings['uncaught'] or 'none'}")
    log(f"issues: {issues or 'none'}")
    for c in threw:
        log(f"  THREW [{c['step']}] {c['op']} {c['id']}: {c['threw']}")
    log(f"shots: {OUT}")

    ok = not issues and not threw and not findings["uncaught"] and not page_errors
    print("\n" + ("CLEAN — a leaked level source is swept, not fatal" if ok
                  else "REPRODUCED — the build still dies on a live source it should have cleared"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
