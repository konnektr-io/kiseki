#!/usr/bin/env python3
"""
Reproduce (or clear) the trip-map crash PostHog recorded on 2026-09-26:

    Error: Source "journey" already exists.
    $current_url: https://kiseki.konnektr.io/t/:token/itinerary
    Chrome 153 / Android / Mobile

The production session that captured it walked LEVELS on ONE persistent map
(day/3 -> itinerary -> crash). The itinerary scan level adds a GeoJSON source
literally named "journey" (`RouteMap.tsx`, `addLineLayers("journey", ...)`), so
the question is narrow and mechanical:

  does a scan <-> day level walk ever call `addSource("journey")` while the
  previous build's "journey" source is still on the map?

MapLibre lives in a WebGL canvas and exposes no global, so the probe cannot
read it off the DOM. The app is therefore instrumented at the one place the map
instance is created (`RouteMap.tsx` calls `window.__probeMap(map)` — a
temporary hook, removed before the fix is committed) and the probe wraps that
instance's own addSource/removeSource/addLayer/removeLayer. A duplicate id is
then a MEASURED event with a real call order, not an inference.

Harness notes (see skill kiseki-frontend-ux / browser-probe-harness): build
first, serve frontend/dist with an index.html fallback, mock the trip fetch
from an in-file fixture, and consent is DECLINED so the probe writes nothing
into the real PostHog project.

Run:  backend/.venv/bin/python scripts/probe-map-source-crash.py
"""

import json
import os
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

FRONTEND = Path(__file__).resolve().parent.parent
DIST = FRONTEND / "dist"
OUT = Path(os.environ.get("KISEKI_PROBE_OUT", "/tmp/kiseki-probe-map-source"))

# Playwright pins a revision that is not installed here; use whatever
# chromium_headless_shell the image actually has.
def _chromium() -> str | None:
    import glob
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
                 "to": "Revelstoke", "mode": "drive", "status": "done"},
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

# The recorded production session walked levels on ONE persistent map:
# day/3 -> itinerary -> crash. A full page load destroys the map, so this
# probe navigates IN-APP (the map stays mounted, exactly as on a phone) —
# otherwise the bug class under test is unreproducible by construction.
# "day:N" is a real in-app hop (the day card's own link), "up" is the day
# nav's "Back to the itinerary" button.
WALK = [
    ("scan-boot", None),
    ("day3", "day:3"),
    ("scan-after-day3", "up"),
    ("day1", "day:1"),
    ("scan-after-day1", "up"),
    ("day0", "day:0"),
    ("scan-after-day0", "up"),
    ("day4", "day:4"),
    ("scan-after-day4", "up"),
]

# Installed before the bundle runs; RouteMap hands its live map instance here.
INSTRUMENT = """
(() => {
  window.__mapCalls = [];
  window.__step = "boot";
  window.__probeMap = (map) => {
    if (!map || map.__probePatched) return;
    map.__probePatched = true;
    for (const m of ["addSource", "removeSource", "addLayer", "removeLayer"]) {
      const orig = map[m].bind(map);
      map[m] = function (...args) {
        const rec = { step: window.__step, op: m, id: String(args[0]), t: performance.now() };
        window.__mapCalls.push(rec);
        try {
          return orig(...args);
        } catch (e) {
          rec.threw = String((e && e.message) || e);
          throw e;
        }
      };
    }
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
        log("FAIL: frontend/dist missing — run `vite build` first")
        return 2

    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    OUT.mkdir(parents=True, exist_ok=True)

    findings = {}
    page_errors: list[str] = []

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
                            "from": "Revelstoke", "to": "Rogers Pass", "road": True,
                            "duration": "30 mins", "distance": "35 km",
                            "geometry": {"type": "LineString",
                                         "coordinates": [[-118.20, 51.00], [-118.10, 51.02], [-117.85, 51.05]]},
                        }]
                    }),
                )
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        ctx.route("**/api/**", handle)
        # Consent DECLINED before anything runs: this probe must not write into
        # the real PostHog project (product-analytics-integration, standing rule).
        ctx.add_init_script("try { localStorage.setItem('kiseki_consent','declined'); } catch (e) {}")
        ctx.add_init_script(INSTRUMENT)

        page = ctx.new_page()
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        # Boot the scan level once; from here every hop is IN-APP so the map
        # instance survives (the whole point — RouteMap must not remount).
        log("→ boot the itinerary (scan level)")
        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        page.wait_for_selector(".map-pin-scaled", timeout=30000)
        page.wait_for_timeout(3200)

        for label, hop in WALK:
            if hop is None:
                page.evaluate("() => { window.__step = 'scan-boot'; }")
            elif hop == "up":
                page.evaluate("(s) => { window.__step = s; }", label)
                # The day nav's "Back to the itinerary" control.
                btn = page.get_by_role("button", name=re.compile("back to the itinerary", re.I))
                btn.first.click(timeout=10000)
            elif hop.startswith("day:"):
                page.evaluate("(s) => { window.__step = s; }", label)
                idx = hop.split(":")[1]
                # The day card's own link into that day.
                link = page.locator(f'a[href$="/day/{idx}"]').first
                link.click(timeout=10000)
            page.wait_for_timeout(2600)

            body = page.inner_text("body")
            if "Something went wrong" in body:
                findings.setdefault("boundary_at", []).append(label)
            try:
                page.screenshot(path=str(OUT / f"{label}.png"))
            except Exception:
                pass
            log(f"   {label}: {'ERROR BOUNDARY' if 'Something went wrong' in body else 'ok'}")

        findings["uncaught"] = page.evaluate("window.__uncaught") or []
        findings["mapCalls"] = page.evaluate("window.__mapCalls") or []
        browser.close()
    httpd.shutdown()

    calls = findings["mapCalls"]

    # Replay the call order and find any id added while already live.
    live = {}
    dupes = []
    threw = []
    for c in calls:
        if c.get("threw"):
            threw.append({"op": c["op"], "id": c["id"], "err": c["threw"]})
            continue
        if c["op"] == "addSource":
            live[c["id"]] = live.get(c["id"], 0) + 1
            if live[c["id"]] > 1:
                dupes.append(c["id"])
        elif c["op"] == "removeSource":
            live[c["id"]] = live.get(c["id"], 1) - 1

    added = sorted({c["id"] for c in calls if c["op"] == "addSource"})
    removed = sorted({c["id"] for c in calls if c["op"] == "removeSource"})

    log("\n=== map source/layer calls, in the app's own order ===")
    log(f"total calls: {len(calls)}")
    log(f"sources added:   {added}")
    log(f"sources removed: {removed}")
    log(f"duplicate source adds: {sorted(set(dupes)) or 'none'}")
    log(f"threw: {threw or 'none'}")
    log(f"uncaught: {findings['uncaught'] or 'none'}")
    log(f"error boundary at: {findings.get('boundary_at') or 'nowhere'}")
    log(f"page errors: {page_errors or 'none'}")
    log(f"shots: {OUT}")

    # The journey source is the one PostHog named; report its whole history.
    log("\n--- every call touching the 'journey' source ---")
    for c in calls:
        if c["id"].startswith("journey"):
            log(f"  [{c['step']:<18}] {c['op']:<14} {c['id']}"
                + (f"  THREW: {c['threw']}" if c.get("threw") else ""))

    failed = bool(dupes or threw or findings["uncaught"] or findings.get("boundary_at"))
    print("\n" + ("REPRODUCED — this build still has the bug" if failed else "CLEAN — no duplicate source, no crash"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run())
