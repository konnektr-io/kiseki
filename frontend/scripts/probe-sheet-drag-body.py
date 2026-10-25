#!/usr/bin/env python3
"""
The sheet's scroll body must end on the sheet's VISIBLE floor — at every
detent, and while a finger is dragging it.

Niko's phone (Costa Rica 2023, 360×780): the sheet sat visually at `full` with
the bottom ~40% of it blank and the chevron still pointing up. That is a sheet
whose TRANSFORM and whose body HEIGHT disagree: the body was sized for the
detent the drag started from (`half`), so the part the drag revealed had no
content in it — the list stopped mid-card and white ran to the nav.

Reproduced here by dragging the handle up and measuring before the release:
  before the fix → `blank` ≈ the distance dragged (259px at this viewport)
  after the fix  → `blank` ≤ 0 (the body follows the finger)
and the same numbers hold after a gesture the browser takes away
(`pointercancel`): the sheet must settle, not stay parked mid-travel.

Run:  backend/.venv/bin/python frontend/scripts/probe-sheet-drag-body.py
      KISEKI_PROBE_DIST=<other dist> …   # to measure a pre-fix build
"""
import importlib.util
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

FRONTEND = Path(__file__).resolve().parent.parent
DIST = Path(os.environ.get("KISEKI_PROBE_DIST", str(FRONTEND / "dist")))
OUT = Path(os.environ.get("KISEKI_PROBE_OUT", "/tmp/kiseki-probe-sheet-drag"))

# The trip fixture + the chromium locator live in probe-map-source-crash.py.
_spec = importlib.util.spec_from_file_location(
    "probe_source", FRONTEND / "scripts" / "probe-map-source-crash.py"
)
if _spec is None or _spec.loader is None:
    raise SystemExit("probe-map-source-crash.py not found next to this script")
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

TRIP_ID = probe.TRIP_ID
TRIP = probe.TRIP

MEASURE = r"""
() => {
  const sheet = document.querySelector('section[data-detent]');
  if (!sheet) return { none: true };
  const surface = sheet.parentElement;
  const body = sheet.querySelector('[data-scroll-root]');
  const s = sheet.getBoundingClientRect();
  const su = surface.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  return {
    detent: sheet.dataset.detent,
    surfaceBottom: +su.bottom.toFixed(1),
    sheetTop: +s.top.toFixed(1),
    bodyBottom: +b.bottom.toFixed(1),
    bodyH: body.style.height,
    // >0 means the sheet's lower part is empty (content stops above the floor)
    blank: +(Math.min(su.bottom, window.innerHeight) - b.bottom).toFixed(1),
    transform: getComputedStyle(sheet).transform,
  };
}
"""


def log(m):
    print(m, flush=True)


def serve():
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(DIST), **kw)

        def send_head(self):
            p = Path(self.path.split("?")[0])
            if not p.is_file() and "." not in p.name:
                self.path = "/index.html"
            return super().send_head()

        def log_message(self, *a, **k):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def drag(cdp, x, y, dy, release=True):
    """Drag the handle by `dy` px through the touch channel; optionally release."""
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart",
             "touchPoints": [{"x": x, "y": y, "id": 1}]})
    steps = 10
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove",
                 "touchPoints": [{"x": x, "y": y + dy * i / steps, "id": 1}]})
    if release:
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def run():
    if not DIST.is_dir():
        log("FAIL: frontend/dist missing — build it first")
        return 2
    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    OUT.mkdir(parents=True, exist_ok=True)
    failures = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=probe.CHROME,
            args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
        )
        ctx = browser.new_context(
            viewport={"width": 360, "height": 780},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
        )

        def handle(route):
            url = route.request.url
            if "/api/trips/" in url and url.rstrip("/").endswith(TRIP_ID):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(TRIP))
            elif "/api/maps/route/" in url:
                route.fulfill(status=200, content_type="application/json", body='{"legs":[]}')
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        ctx.route("**/api/**", handle)
        ctx.add_init_script(
            "try { localStorage.setItem('kiseki_consent', 'declined'); } catch (e) {}"
        )
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        log("→ boot the itinerary at 360x780 (sheet mode)")
        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        page.wait_for_selector(".map-pin-scaled", timeout=30000)
        page.wait_for_timeout(2500)
        # Dismiss the analytics banner the way a user does (never remove it from
        # the DOM: React holds a detached subtree and the boundary fires).
        for label in ("No thanks", "Allow analytics"):
            try:
                page.click(f'button:has-text("{label}")', timeout=1500)
                break
            except Exception:
                continue
        page.wait_for_timeout(400)

        settled = page.evaluate(MEASURE)
        log(f"   settled ({settled['detent']}): {json.dumps(settled)}")
        page.screenshot(path=str(OUT / "1-settled.png"))

        box = page.evaluate("""() => {
            const h = document.querySelector('.sheet-handle').getBoundingClientRect();
            return {x: h.left + h.width / 2, y: h.top + h.height / 2};
        }""")
        cdp = ctx.new_cdp_session(page)

        log("→ drag the handle up 260px and measure with the finger still down")
        drag(cdp, box["x"], box["y"], -260, release=False)
        page.wait_for_timeout(600)
        mid = page.evaluate(MEASURE)
        log(f"   mid-drag: {json.dumps(mid)}")
        page.screenshot(path=str(OUT / "2-mid-drag.png"))

        # The revealed part must be filled by the list, not blank.
        if mid["blank"] > 2:
            failures.append(
                f"mid-drag: the body stops {mid['blank']}px above the sheet's floor "
                f"(body {mid['bodyH']}, sheet top {mid['sheetTop']}) — revealed part is blank"
            )

        log("→ let the browser take the gesture away (touchCancel)")
        cdp.send("Input.dispatchTouchEvent", {"type": "touchCancel", "touchPoints": []})
        page.wait_for_timeout(1500)
        after = page.evaluate(MEASURE)
        log(f"   after cancel: {json.dumps(after)}")
        page.screenshot(path=str(OUT / "3-after-cancel.png"))
        if after["blank"] > 2:
            failures.append(f"after a cancelled gesture the body is {after['blank']}px short")
        if "px" in (after["transform"] or ""):
            failures.append(f"after a cancelled gesture the sheet is still mid-travel: {after['transform']}")

        log("→ a clean drag must still snap to `full` and fill the sheet")
        drag(cdp, box["x"], box["y"], -260, release=True)
        page.wait_for_timeout(2000)
        snapped = page.evaluate(MEASURE)
        log(f"   settled after a clean drag: {json.dumps(snapped)}")
        page.screenshot(path=str(OUT / "4-snapped.png"))
        if snapped["detent"] != "full":
            failures.append(f"a clean upward drag snapped to `{snapped['detent']}`, not `full`")
        if snapped["blank"] > 2:
            failures.append(f"at `full` the body is {snapped['blank']}px short of the floor")

        if errors:
            failures.append(f"page errors: {errors[:2]}")
        browser.close()
    httpd.shutdown()

    log(f"shots: {OUT}")
    for f in failures:
        log(f"FAIL: {f}")
    print("\n" + ("PASS — the sheet body always reaches its visible floor"
                  if not failures else f"FAILED ({len(failures)})"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
