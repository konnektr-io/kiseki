#!/usr/bin/env python3
"""Do the excursion diamonds get names when they have room? (#413)

Niko, 2026-10-04: fully zoomed in, with every diamond visible and space between
them, "only some labels seem to shown ... It seems completely random which
labels get shown and which don't."

Suspects, in order:
  1. EXCURSION_LABEL_MAX = 4 caps the layer REGARDLESS of how many diamonds are
     visible, so at high zoom only four names can ever appear.
  2. The cap is applied by array order (trip.locations), not by fit, so which
     four win is arbitrary from the traveler's point of view.
  3. The 92px separation test then drops names from even those four.

Measure all three on the real trip, per zoom.
"""
import glob
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

DIST = Path("/opt/data/.worktrees/kiseki/fix-413-label-zoom/frontend/dist")
PERU = "6b11a061-54c8-401e-9861-855dea2f7338"
EXCURSION_MIN_ZOOM = 9


def chromium():
    hits = sorted(glob.glob("/opt/hermes/.playwright/chromium_headless_shell-*/"
                            "chrome-headless-shell-linux64/chrome-headless-shell"))
    return hits[-1] if hits else None


def serve():
    import base64

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(DIST), **kw)

        def send_head(self):
            p = Path(self.path.split("?")[0])
            if not p.is_file() and "." not in p.name:
                self.path = "/index.html"
            return super().send_head()

        def do_GET(self):
            # Do NOT stub tiles: RouteMap treats a tile error as "the map failed"
            # and unmounts the surface, which is why earlier runs kept dying
            # mid-walk. Real tiles keep the map alive and the assertions honest.
            super().do_GET()

        def log_message(self, *a, **k):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def run():
    trip = json.loads(Path("/opt/data/cache/peru.json").read_text())
    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    out = Path("/opt/data/cache/kiseki-probe-labels")
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chromium(),
                              args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"])
        page = b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        page.add_init_script("try{localStorage.setItem('kiseki_consent','declined')}catch(e){}")

        def handle(route):
            url = route.request.url
            if "/api/trips/" in url and url.rstrip("/").endswith(PERU):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(trip))
            elif "/api/maps/route/" in url:
                route.fulfill(status=200, content_type="application/json", body='{"legs":[]}')
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        page.route("**/api/**", handle)
        page.goto(f"{base}/t/{PERU}/itinerary", wait_until="load", timeout=60000)
        page.wait_for_selector(".map-pin-scaled", timeout=45000)
        for _ in range(20):
            if page.evaluate("() => document.querySelectorAll('.maplibregl-marker').length"):
                break
            page.wait_for_timeout(700)
        page.wait_for_timeout(5000)

        print(f"{'zoom':>7} {'diamonds':>9} {'named':>7}   named / visible")
        rows = []
        failures: list[str] = []
        for step in range(11):
            snap = page.evaluate(r"""() => {
              const box = document.querySelector('.map-pin-scaled');
              if (!box) return null;
              const zoom = parseFloat(box.dataset.mapZoom || 'NaN');
              const diamonds = [...document.querySelectorAll('.route-pin-excursion')]
                .filter((el) => !el.hasAttribute('hidden')
                              && getComputedStyle(el).display !== 'none'
                              && el.getBoundingClientRect().width > 0);
              const labels = [...document.querySelectorAll('.map-place-label.is-excursion')]
                .filter((el) => el.getBoundingClientRect().width > 0);
              const host = document.querySelector('.map-pin-scaled');
              return {
                zoom,
                mapAlive: !!host && !document.body.innerText.includes("couldn't load"),
                markers: document.querySelectorAll('.maplibregl-marker').length,
                diamonds: diamonds.length,
                labels: labels.length,
                names: labels.map((el) => (el.textContent || '').trim()),
                diamondNames: diamonds.map((el) => el.dataset.place),
              };
            }""")
            if snap is None:
                print("   (map container gone — stopping)")
                break
            rows.append(snap)
            print(f"{snap['zoom']:>7} {snap['diamonds']:>9} {snap['labels']:>7}   "
                  f"{'live' if snap['mapAlive'] else 'DEAD'}  "
                  f"{', '.join(snap['names'][:4]) or '(none)'}")
            if snap["diamonds"]:
                # Independent proof the diamonds are really on screen, without
                # relying on basemap pixels: read each painted marker's rect and
                # each label pill's rect out of the DOM.
                rects = page.evaluate(r"""() => {
                  const ds = [...document.querySelectorAll('.route-pin-excursion')]
                    .filter((el) => !el.hasAttribute('hidden')
                                  && getComputedStyle(el).display !== 'none')
                    .map((el) => { const r = el.getBoundingClientRect();
                      return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; });
                  const ls = [...document.querySelectorAll('.map-place-label.is-excursion')]
                    .filter((el) => el.getBoundingClientRect().width > 0)
                    .map((el) => { const r = el.getBoundingClientRect();
                      return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; });
                  const why = [...document.querySelectorAll('.route-pin-excursion')]
                    .slice(0, 3)
                    .map((el) => ({
                      hasAttr: el.hasAttribute('hidden'),
                      cls: el.className,
                      display: getComputedStyle(el).display,
                      w: Math.round(el.getBoundingClientRect().width),
                    }));
                  return { ds, ls, vp: [innerWidth, innerHeight], why };
                }""")
                painted = [d for d in rects["ds"] if d[2] > 0]
                print(f"   diamonds painted (laid out, not hidden): "
                      f"{len(painted)}/{len(rects['ds'])}, labels: {len(rects['ls'])}")
                for w in rects["why"]:
                    print("     ", w)
                # Same tick: DOM counts above, pixels here.
                alive = page.evaluate("""() => {
                  const c = document.querySelector('.maplibregl-canvas');
                  return !!c && c.width > 0;
                }""")
                page.screenshot(path=str(out / "labels.png"))
                print(f"   (captured this frame; canvas={alive})")
            # #413 invariants, per frame.
            if not snap["mapAlive"]:
                print(f"   (z{snap['zoom']:.2f} read from a DEAD map — discarded)")
                rows.pop()
                break
            if snap["labels"] > snap["diamonds"]:
                failures.append(f"z{snap['zoom']:.2f}: {snap['labels']} labels for "
                                f"{snap['diamonds']} diamonds")
            if snap["diamonds"] >= 3 and snap["labels"] < snap["diamonds"]:
                unnamed = [d for d in snap["diamondNames"] if d not in snap["names"]]
                failures.append(f"z{snap['zoom']:.2f}: {len(unnamed)} visible diamond(s) "
                                f"unnamed: {unnamed[:4]}")
            if snap["zoom"] >= EXCURSION_MIN_ZOOM and snap["diamonds"] == 0:
                failures.append(f"z{snap['zoom']:.2f}: at/above z{EXCURSION_MIN_ZOOM} but no "
                                f"diamond drew")
            # Wait for the camera to settle. The component only re-runs the
            # visibility pass on `moveend`, so sampling earlier reads the
            # PREVIOUS zoom and invents an off-by-one no user could see.
            page.click(".maplibregl-ctrl-zoom-in", force=True)
            page.wait_for_timeout(400)
            settled = False
            last = None
            for _ in range(20):
                if not page.query_selector(".map-pin-scaled"):
                    break
                state = page.evaluate(r"""() => {
                  const b = document.querySelector('.map-pin-scaled');
                  if (!b) return null;
                  return {
                    zoom: parseFloat(b.dataset.mapZoom || '0'),
                    markers: document.querySelectorAll('.maplibregl-marker').length,
                    diamonds: [...document.querySelectorAll('.route-pin-excursion')]
                      .filter((el) => !el.hasAttribute('hidden')).length,
                  };
                }""")
                if state is None:
                    break
                if last and state == last:
                    settled = True
                    break
                last = state
                page.wait_for_timeout(400)
            if not settled:
                print("   (camera never settled — offline tiles; stopping)")
                break
            if not page.query_selector(".map-pin-scaled"):
                print("   (map left the surface — offline tile 404s; last good frame above)")
                break
        if rows and rows[-1]["diamonds"]:
            # Re-frame and shoot while the map is still alive.
            page.screenshot(path=str(out / "labels.png"))
        b.close()
    httpd.shutdown()

    print()
    for f in failures:
        print("FAIL:", f)
    worst = max((r for r in rows if r["diamonds"] >= 3),
                key=lambda r: r["diamonds"] - r["labels"], default=None)
    print()
    if worst:
        gap = worst["diamonds"] - worst["labels"]
        print(f"WORST: z{worst['zoom']:.2f}  {worst['diamonds']} diamonds visible, "
              f"{worst['labels']} named  -> {gap} unlabelled")
        unnamed = [d for d in worst["diamondNames"] if d not in worst["names"]]
        print("  unnamed:", unnamed[:8])
    print()
    print("PASS — every visible diamond is named" if not failures
          else f"FAILED ({len(failures)})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
