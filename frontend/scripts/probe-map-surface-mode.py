#!/usr/bin/env python3
"""
#392 — the trip map must NOT remount when the surface mode changes.

`SplitView` used to `return` from two different JSX roots with `map(padding)`
inline in each, so React reconciled across two unrelated trees on every mode
change and UNMOUNTED the map. `useSurfaceMode` re-reads on resize AND on
orientationchange, so rotating a phone rebuilt the whole MapLibre instance:
the basemap re-downloaded, the `!ready` skeleton pulsed over it, and the camera
reset. That is the "sometimes it takes a while to load the itinerary and the
whole map seems to reload / pulse" report.

MapLibre is not a global in v6 and its sources/layers live in a WebGL canvas, so
this probe measures the thing that is actually observable: the identity of the
map's own DOM container across a rotation. If React remounts, the element is
replaced and the node object changes; if it does not, the node survives. The
map child is tagged by the caller (`SplitView` renders whatever `map()` returns)
so a replacement is unambiguous.

Also asserted: the map FRAME is one element in every mode (`[data-map-frame]`),
and the camera padding the map is handed still tracks the occlusion in sheet
mode — the sheet-geometry contract must survive the restructure.

Run:  backend/.venv/bin/python scripts/probe-map-surface-mode.py
"""
import importlib.util
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

FRONTEND = Path(__file__).resolve().parent.parent
DIST = FRONTEND / "dist"
TRIP_ID = "b16680e7-a338-4c76-9cd7-fa13d45be594"

# The trip fixture + the harness live in probe-map-source-crash.py; reuse them
# rather than keeping a second copy that can drift.
_spec = importlib.util.spec_from_file_location(
    "probe_source", FRONTEND / "scripts" / "probe-map-source-crash.py"
)
if _spec is None or _spec.loader is None:
    raise SystemExit("probe-map-source-crash.py not found next to this script")
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

ROUTE_LEGS = {"legs": [{
    "from": "Revelstoke", "to": "Rogers Pass", "road": True,
    "duration": "30 mins", "distance": "35 km",
    "geometry": {"type": "LineString",
                 "coordinates": [[-118.20, 51.00], [-118.10, 51.02], [-117.85, 51.05]]}}]}


def log(m):
    print(m, flush=True)


def serve():
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(DIST), **kw)

        def send_head(self):
            p = Path(self.path.split("?")[0])
            if not p.is_file() and "." not in p.name:
                self.path = "/index.html"
            return super().send_head()

        def log_message(self, *a, **k):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def run():
    if not DIST.is_dir():
        log("FAIL: frontend/dist missing — run `vite build` first")
        return 2

    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    out = Path("/tmp/kiseki-probe-map-surface-mode")
    out.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=probe.CHROME,
            args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
        )
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True
        )

        def handle(route):
            url = route.request.url
            if "/api/trips/" in url and url.rstrip("/").endswith(TRIP_ID):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(probe.TRIP))
            elif "/api/maps/route/" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(ROUTE_LEGS))
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        ctx.route("**/api/**", handle)
        # Consent declined BEFORE anything runs: this probe must not write
        # events into the real PostHog project.
        ctx.add_init_script("try{localStorage.setItem('kiseki_consent','declined')}catch(e){}")
        # Tag the map's own container so a remount is detectable by identity.
        # The observer can only attach once the document exists, so the tagger
        # is a named function polled from a load listener rather than an
        # immediate observe() on a possibly-null documentElement.
        ctx.add_init_script("""
          window.__mapNodeId = 0;
          window.__tagMap = () => {
            const box = document.querySelector('.map-pin-scaled');
            if (box && !box.__tagged) box.__tagged = ++window.__mapNodeId;
            const frame = document.querySelector('[data-map-frame]');
            if (frame && !frame.__frameTagged) frame.__frameTagged = ++window.__mapNodeId;
          };
          const start = () => {
            if (!document.documentElement) return setTimeout(start, 10);
            new MutationObserver(() => window.__tagMap())
              .observe(document.documentElement, { childList: true, subtree: true });
            window.__tagMap();
          };
          start();
        """)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        log("→ portrait 390x844 (sheet mode)")
        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        page.wait_for_selector(".map-pin-scaled", timeout=30000)
        page.wait_for_timeout(3000)
        # The MAP CONTAINER's own tag — the thing React must not replace.
        tag_portrait = page.evaluate(
            "() => document.querySelector('.map-pin-scaled')?.__tagged ?? 0"
        )
        frames = page.evaluate("document.querySelectorAll('[data-map-frame]').length")
        canvas_portrait = page.evaluate("!!document.querySelector('.map-pin-scaled canvas')")
        page.screenshot(path=str(out / "1-portrait.png"))

        log("→ rotate to landscape 844x390 (side/split mode)")
        page.set_viewport_size({"width": 844, "height": 390})
        page.wait_for_timeout(3000)
        tag_land = page.evaluate(
            "() => document.querySelector('.map-pin-scaled')?.__tagged ?? 0"
        )
        page.screenshot(path=str(out / "2-landscape.png"))

        log("→ rotate back to portrait")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(3000)
        tag_back = page.evaluate(
            "() => document.querySelector('.map-pin-scaled')?.__tagged ?? 0"
        )
        page.screenshot(path=str(out / "3-portrait-again.png"))

        # After every rotation the map must still be usable: a remount leaves
        # the freshly-created map not yet loaded, and the skeleton pulsing.
        canvas_final = page.evaluate("!!document.querySelector('.map-pin-scaled canvas')")
        skeleton = page.evaluate("document.querySelectorAll('.animate-pulse').length")
        browser.close()
    httpd.shutdown()

    log(f"\nmap container tag after portrait   : {tag_portrait}")
    log(f"map container tag after landscape  : {tag_land}")
    log(f"map container tag after rotate back: {tag_back}")
    log(f"map canvas present (portrait)      : {canvas_portrait}")
    log(f"map canvas present (final)         : {canvas_final}")
    log(f"pulsing skeleton elements (final)  : {skeleton}")
    log(f"map frames in DOM                  : {frames}")
    log(f"page errors                        : {errors[:3] or 'none'}")
    log(f"shots: {out}")

    # THE assertion: one map container for the whole session.
    if not tag_portrait or tag_portrait == 0:
        failures.append("the map container was never tagged (probe did not attach)")
    if tag_land != tag_portrait or tag_back != tag_portrait:
        failures.append(
            f"map remounted across rotation (tags: {tag_portrait} -> {tag_land} -> {tag_back})"
        )
    if frames != 1:
        failures.append(f"expected exactly one [data-map-frame], found {frames}")
    if not canvas_final:
        failures.append("no map canvas after rotating back — the map is not usable")
    if errors:
        failures.append(f"page errors: {errors[:2]}")

    for f in failures:
        log(f"FAIL: {f}")
    print("\n" + ("PASS — one map instance, no remount, no pulse" if not failures
                  else f"FAILED ({len(failures)}) — #392 is not fixed"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
