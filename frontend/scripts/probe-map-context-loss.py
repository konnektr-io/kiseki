#!/usr/bin/env python3
"""
A trip map that lost its WebGL context must come back on the level you are on —
not on the level that was open when the context died.

Reported by Niko 2026-10-15, minutes after v0.102.1 went live:

    "Something really weird is happening now. Sometimes when I go to the Day
     view, the full itinerary route stays on the map. See screenshot where I'm
     going to Day 1 for the canada trip and still see the route all the way to
     Revelstoke."

MEASURED CAUSE (three links, each one observed, none inferred):

 1. `lib/maps.ts > hasWebGL2()` created a detached canvas and a LIVE webgl2
    context on EVERY call, and `MapView` calls it once per instance — so the
    itinerary rail (~16+ cards) burned through the browser's context budget.
    Chromium then evicts the oldest context, and the trip map's is the oldest:
    "WARNING: Too many active WebGL contexts. Oldest context will be lost."

 2. MapLibre answers a lost context in `Map#_contextLost` (map.ts) with
    `this.style.destroy(); this.style = null;` — so for that window EVERY
    `map.getLayer()` / `map.getSource()` returns undefined, `map.getStyle()`
    throws, and the level teardown's removals become silent no-ops. The route of
    the level that was live is therefore never taken off.

 3. `Map#_contextRestored` re-installs the style it captured at the loss
    (`setStyle(this._lostContextStyle.style, {diff: false})`). Whatever was on
    the map when the context died comes back — the whole-itinerary route — and
    the level you moved to afterwards does not, because nothing rebuilds it.

So the visible bug is the SCAN route sitting on the DAY level, and the trigger is
a context budget spent by a per-call capability probe.

THIS PROBE PINS BOTH ENDS, in two scenarios, on the real component:

  SCENARIO 1 (budget) — load the trip with the rail mounted, count the
      `.getContext('webgl2')` calls the page makes, and assert Chromium never
      reports an eviction. Pre-fix: ~16 contexts and the eviction warning.

  SCENARIO 2 (recovery) — boot the itinerary (scan level live), LOSE the map's
      context, walk to Day 1 while the style is gone, then restore the context.
      Assert the map ends up holding the DAY level and none of the scan level.
      Pre-fix: the scan route is back on the day level (or both are live).

Run:  backend/.venv/bin/python scripts/probe-map-context-loss.py
      KISEKI_PROBE_DIST=/path/to/other/dist ... (run it against a pre-fix build:
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
OUT = Path(os.environ.get("KISEKI_PROBE_OUT", "/tmp/kiseki-probe-map-context-loss"))


def _chromium() -> str | None:
    hits = sorted(glob.glob("/opt/hermes/.playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"))
    hits += sorted(glob.glob(str(Path.home() / ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")))
    return hits[-1] if hits else None


CHROME = _chromium()

TRIP_ID = "probe-context-loss"
LOCATIONS = ["Revelstoke", "Glacier National Park", "Banff", "Canmore", "Golden", "Field", "Lake Louise", "Jasper"]
COORDS = {
    "Revelstoke": (-118.20, 51.00), "Glacier National Park": (-117.50, 51.30),
    "Banff": (-115.57, 51.18), "Canmore": (-115.35, 51.09), "Golden": (-116.96, 51.30),
    "Field": (-116.49, 51.40), "Lake Louise": (-116.18, 51.43), "Jasper": (-118.08, 52.87),
}
# Enough rail cards that a per-instance capability probe exhausts the budget:
# Chromium caps live WebGL contexts at 16 and evicts the oldest past that.
DAYS = [
    {
        "id": f"day-{i}", "date": f"2027-01-{10 + i:02d}", "title": f"{LOCATIONS[i % len(LOCATIONS)]} day",
        "notes": "Probe day.",
        "blocks": [
            {"id": f"blk-{i}a", "kind": "transport", "title": f"Drive to {LOCATIONS[(i + 1) % len(LOCATIONS)]}",
             "from": LOCATIONS[i % len(LOCATIONS)], "to": LOCATIONS[(i + 1) % len(LOCATIONS)],
             "mode": "drive", "status": "done"},
            {"id": f"blk-{i}b", "kind": "activity", "title": "Ski", "location": LOCATIONS[i % len(LOCATIONS)],
             "status": "done"},
        ],
    }
    for i in range(len(LOCATIONS))
]
TRIP = {
    "id": TRIP_ID, "title": "Context loss probe", "slug": TRIP_ID, "visibility": "public",
    "locations": [
        {"id": f"loc-{n}", "name": n, "lat": COORDS[n][1], "lng": COORDS[n][0], "kind": "place"}
        for n in LOCATIONS
    ],
    "sections": [
        {"id": "sec-0", "title": "Powder highway", "order": 0, "days": list(range(len(DAYS))),
         "locationRefs": LOCATIONS, "body": "Probe route."},
    ],
    "days": DAYS,
    "crew": [],
    "practical": {},
}

# The four source ids and the layers built on them, both levels (`RouteMap.tsx`).
SCAN_SOURCES = ["journey", "journey-glyphs"]
SCAN_LAYERS = ["journey-casing", "journey-dashed-casing", "journey-solid", "journey-dashed", "journey-glyphs"]
DAY_SOURCES = ["day", "day-glyphs", "day-tracks"]
DAY_LAYERS = ["day-casing", "day-dashed-casing", "day-solid", "day-dashed", "day-glyphs"]

INSTRUMENT = """
(() => {
  window.__ctxCalls = [];
  window.__map = null;
  window.__uncaught = [];
  window.__lost = 0;
  window.__restored = 0;

  // SCENARIO 1 instrument: every webgl2 context the page asks for, with the
  // stack that asked (the capability probe vs MapLibre's painter).
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGet.call(this, type, ...rest);
    if (String(type).startsWith('webgl')) {
      let stack = '';
      try { throw new Error('ctx'); } catch (e) { stack = String(e.stack).split('\\n').slice(2, 4).join(' <- '); }
      window.__ctxCalls.push({ type: String(type), t: Math.round(performance.now()),
                               attached: !!this.parentNode, stack: stack.slice(0, 120) });
    }
    return ctx;
  };

  window.__probeMap = (map) => {
    if (!map || map.__probePatched) return;
    map.__probePatched = true;
    if (!window.__map) window.__map = map;
    for (const m of ['addSource', 'removeSource', 'addLayer', 'removeLayer']) {
      const orig = map[m].bind(map);
      map[m] = function (...args) {
        const lid = (a) => (typeof a === 'string' ? a : (a && a.id) ? String(a.id) : String(a));
        const rec = { op: m, id: lid(args[0]), t: Math.round(performance.now()),
                      path: location.pathname.split('/').slice(-2).join('/') };
        window.__mapCalls.push(rec);
        try { return orig(...args); } catch (e) { rec.threw = String((e && e.message) || e); throw e; }
      };
    }
    map.on('webglcontextlost', () => { window.__lost++; });
    map.on('webglcontextrestored', () => { window.__restored++; });
  };
  window.__mapCalls = window.__mapCalls || [];

  /** Force the loss the browser would force itself once the budget is spent. */
  window.__loseContext = () => {
    const map = window.__map;
    if (!map) return 'no map';
    const gl = map.getCanvas().getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (!ext) return 'no WEBGL_lose_context';
    // Keep the extension: after the loss `getContext('webgl2')` returns null on
    // that canvas, but the extension object still restores the context.
    window.__glExt = ext;
    ext.loseContext();
    return 'lost';
  };
  /** Hand it back, the way the browser restores a context it evicted. */
  window.__restoreContext = () => {
    const ext = window.__glExt;
    if (!ext) return 'no extension captured (loss never happened)';
    ext.restoreContext();
    return 'restored';
  };
  window.__inventory = () => {
    const map = window.__map;
    const live = (ids, kind) => Object.fromEntries(ids.map((id) => {
      try { return [id, kind === 'src' ? (map && map.getSource(id) ? 'live' : 'absent')
                                         : (map && map.getLayer(id) ? 'live' : 'absent')]; }
      catch (e) { return [id, 'err']; }
    }));
    return { scan: live(%s, 'lyr'), day: live(%s, 'lyr'),
             scanSrc: live(%s, 'src'), daySrc: live(%s, 'src'),
             styleNull: map ? !map.style : null };
  };
  addEventListener('error', (e) => window.__uncaught.push(String((e.error && e.error.message) || e.message || 'error')));
  addEventListener('unhandledrejection', (e) => window.__uncaught.push(String((e.reason && e.reason.message) || e.reason)));
})();
""" % (json.dumps(SCAN_LAYERS), json.dumps(DAY_LAYERS), json.dumps(SCAN_SOURCES), json.dumps(DAY_SOURCES))


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

    issues: list[str] = []
    page_errors: list[str] = []
    console: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
        )
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True)

        def handle(route):
            url = route.request.url
            if "/api/trips/" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(TRIP))
            elif "/api/maps/route/" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps({
                    "legs": [{"from": LOCATIONS[0], "to": LOCATIONS[1], "road": True, "duration": "2 hrs",
                              "distance": "150 km",
                              "geometry": {"type": "LineString",
                                           "coordinates": [list(COORDS[LOCATIONS[0]]), list(COORDS[LOCATIONS[1]])]}}]}))
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        ctx.route("**/api/**", handle)
        # Consent is a COOKIE and this probe must write nothing into PostHog.
        ctx.add_init_script("try { document.cookie = 'kiseki_consent=denied; max-age=31536000; path=/; SameSite=Lax'; } catch (e) {}")
        ctx.add_init_script(INSTRUMENT)

        page = ctx.new_page()
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("console", lambda m: console.append(m.text) if m.type in ("warning", "error") else None)

        log("→ boot the itinerary (scan level) with the rail mounted")
        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        page.wait_for_selector(".route-pin", state="attached", timeout=40000)
        try:
            no = page.get_by_role("button", name=re.compile("no thanks", re.I))
            if no.count():
                no.first.click(timeout=3000)
        except Exception:
            pass
        page.wait_for_timeout(4500)

        # ---------------- SCENARIO 1: the context budget ----------------
        ctx_calls = page.evaluate("window.__ctxCalls") or []
        evicted = [c for c in console if "Too many active WebGL contexts" in c]
        log(f"\n→ SCENARIO 1: {len(ctx_calls)} webgl2 contexts created by this page load")
        for c in ctx_calls[:4]:
            log(f"   attached={c['attached']} t={c['t']}  {c['stack']}")
        if len(ctx_calls) > 4:
            log(f"   ... and {len(ctx_calls) - 4} more")
        if evicted:
            log("   >>> the browser evicted the oldest context (the trip map's): "
                f"{evicted[0]!r}")
            issues.append(f"scenario1: {len(ctx_calls)} contexts, eviction reported")
        elif len(ctx_calls) > 3:
            log(f"   >>> {len(ctx_calls)} live webgl2 contexts — one per capability check")
            issues.append(f"scenario1: {len(ctx_calls)} contexts")

        inv = page.evaluate("window.__inventory()")
        log(f"   scan level live: { {k: v for k, v in inv['scan'].items() if v == 'live'} }")

        # ---------------- SCENARIO 2: lose the context, then walk ----------------
        log("\n→ SCENARIO 2: lose the map's WebGL context while the scan level is live")
        log(f"   lose: {page.evaluate('window.__loseContext()')}")
        page.wait_for_timeout(1200)
        log(f"   lost events: {page.evaluate('window.__lost')}   "
            f"style={page.evaluate('window.__inventory()')['styleNull']}")

        log("→ walk to Day 1 while the style is gone")
        try:
            page.locator('a[href$="/day/0"]').first.click(timeout=10000)
        except Exception as exc:
            log(f"   CLICK FAILED {type(exc).__name__}")
        page.wait_for_timeout(3000)
        body = page.inner_text("body")
        if "Something went wrong" in body:
            issues.append("scenario2: error boundary after the loss")
            log("   >>> ERROR BOUNDARY")

        log("→ restore the context, the way the browser hands it back")
        log(f"   restore: {page.evaluate('window.__restoreContext()')}")
        page.wait_for_timeout(5000)

        inv = page.evaluate("window.__inventory()")
        crashed = "Something went wrong" in page.inner_text("body")
        on_day = bool(re.search(r"DAY 1 OF|Day 1", page.inner_text("body")))
        scan_live = [k for k, v in inv["scan"].items() if v == "live"] + \
                    [k for k, v in inv["scanSrc"].items() if v == "live"]
        day_live = [k for k, v in inv["day"].items() if v == "live"] + \
                   [k for k, v in inv["daySrc"].items() if v == "live"]
        log(f"   restored events: {page.evaluate('window.__restored')}")
        log(f"   on the day screen: {on_day}  |  day layers live: {day_live}")
        log(f"   scan layers still live: {scan_live or 'none'}")

        if crashed:
            issues.append("scenario2: error boundary")
        if scan_live:
            log(f"   >>> the SCAN level's route is on screen while on the day level ({scan_live})")
            issues.append(f"scenario2: stale scan level {scan_live}")
        if not day_live:
            log("   >>> the day level never came back after the restore")
            issues.append("scenario2: day level missing")

        try:
            page.screenshot(path=str(OUT / "after-restore.png"))
        except Exception:
            pass

        calls = page.evaluate("window.__mapCalls") or []
        browser.close()
    httpd.shutdown()

    threw = [c for c in calls if c.get("threw")]
    log("\n=== map calls touching the level ids ===")
    for c in calls:
        log(f"  t={c['t']:>7} [{c['path']:<10}] {c['op']:<13} {c['id']}" + (f"  THREW {c['threw']}" if c.get("threw") else ""))
    log(f"\ntotal {len(calls)} calls, {len(threw)} threw; page errors: {page_errors or 'none'}")
    log(f"issues: {issues or 'none'}")
    log(f"shots: {OUT}")

    ok = not issues and not page_errors
    print("\n" + ("CLEAN — the budget holds and a lost context comes back on the current level" if ok
                  else "REPRODUCED — the scan route survives a context loss on the day level"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
