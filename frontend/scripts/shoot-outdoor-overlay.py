#!/usr/bin/env python3
"""Capture the outdoor overlay at three zooms — the zoom GATE is the thing to see.

Companion to `probe-outdoor-overlay.py`, which asserts. This only photographs, so
it can be pointed at a live deployment or a local build and iterated on without
touching the assertions.

    python scripts/shoot-outdoor-overlay.py [base-url] [trip-id]

base-url defaults to the LIVE site, so what it captures is what ships.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

OUT_DIR = pathlib.Path(os.environ.get("SHOOT_DIR") or "/opt/data/cache/shots")
BASE = sys.argv[1] if len(sys.argv) > 1 else "https://kiseki.konnektr.io"
TRIP_ID = sys.argv[2] if len(sys.argv) > 2 else "b16680e7-a338-4c76-9cd7-fa13d45be594"
FRONTEND = pathlib.Path(__file__).resolve().parent.parent

# z11 lines only / z13 the gate / z15 real pistes + lifts
SHOTS = [
    (11, "z11-lines-only"),
    (13, "z13-labels-appear"),
    (15, "z15-pistes-lifts"),
]
# Centre on Findel / the Matterhorn side for the z15 frame — the town valley is the
# worst case for label density and the mountain is where the overlay has to earn
# its keep.
CENTRES = {11: (7.7491, 46.0207), 13: (7.7491, 46.0207), 15: (7.7420, 46.0105)}

TRIP = {
    "id": TRIP_ID, "slug": "probe-outdoor", "title": "Overlay probe",
    "subtitle": "fixture", "stage": "planned",
    "startDate": "2027-01-10", "endDate": "2027-01-16",
    "theme": {"preset": "alpine"},
    "locations": [
        {"name": "Zermatt", "lat": 46.0207, "lng": 7.7491, "marker": 1},
        {"name": "Täsch", "lat": 46.0642, "lng": 7.8956, "marker": 2},
    ],
    "sections": [],
    "days": [{"id": "day-0", "date": "2027-01-10", "title": "Zermatt",
              "blocks": [{"id": "blk-0", "kind": "activity",
                          "title": "Ski the Matterhorn side",
                          "location": "Zermatt", "status": "planned"}]}],
    "crew": [], "practical": {},
}

# MapLibre v6 is not a global and the app has no handle, so the probe hook is the
# only way to reach the live instance.
CAPTURE_MAP = """
(() => {
  window.__mapRef = null;
  window.__probeMap = (map) => { window.__mapRef = map; };
})();
"""


def serve_dist():
    DIST = FRONTEND / "dist"
    if not (DIST / "index.html").exists():
        return None

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(DIST), **kw)

        def log_message(self, format, *a):  # noqa: A002
            pass

        def send_head(self):
            p = pathlib.Path(self.path.split("?")[0])
            if not p.is_file() and "." not in p.name:
                self.path = "/index.html"
            return super().send_head()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}", httpd


def main() -> int:
    from playwright.sync_api import sync_playwright

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    local = serve_dist()
    base = local[0] if local else BASE
    if local:
        print(f"using local build: {base}")
    else:
        print(f"using live deployment: {base}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        # 1.5x, not 2x: the clip is a large element and this runs on SwiftShader
        # (software WebGL), where a 2x scale quadruples the pixels and the
        # screenshot times out at 30 s. 1.5x is still enough for 9px labels.
        ctx = browser.new_context(viewport={"width": 1680, "height": 1050},
                                  device_scale_factor=1.5)
        ctx.add_init_script("try{localStorage.setItem('kiseki_consent','declined')}catch(e){}")
        ctx.add_init_script(CAPTURE_MAP)

        def handle(route):
            if "/api/trips/" in route.request.url and TRIP_ID in route.request.url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(TRIP))
            else:
                route.continue_()

        ctx.route("**/api/**", handle)
        page = ctx.new_page()
        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        try:
            page.wait_for_selector("canvas.maplibregl-canvas", timeout=30_000)
        except Exception:
            print("FAIL: no map canvas mounted")
            return 1
        page.wait_for_timeout(9_000)

        for z, name in SHOTS:
            lng, lat = CENTRES[z]
            page.evaluate(
                "([lng,lat,z]) => { const m = window.__mapRef; if (m) m.jumpTo({center:[lng,lat], zoom:z}); }",
                [lng, lat, z],
            )
            try:
                page.wait_for_function(
                    """(z) => {
                      const m = window.__mapRef;
                      if (!m) return false;
                      const s = m.getSource('kiseki-outdoor');
                      return !!s && m.isSourceLoaded('kiseki-outdoor') && !m.isMoving()
                             && Math.abs(m.getZoom() - z) < 0.01;
                    }""",
                    arg=z,
                    timeout=30_000,
                )
            except Exception:
                pass
            page.wait_for_timeout(6_000)

            box = page.evaluate(
                """() => {
                  const m = window.__mapRef;
                  if (!m) return null;
                  const r = m.getContainer().getBoundingClientRect();
                  return {x: r.x, y: r.y, width: r.width, height: r.height};
                }"""
            )
            counts = page.evaluate(
                """() => {
                  const m = window.__mapRef;
                  if (!m) return {};
                  const ids = ['outdoor-lift-glyphs','outdoor-piste-labels','outdoor-trail-labels','outdoor-lift-labels'];
                  const out = {};
                  for (const i of ids) out[i.replace('outdoor-','')] = m.queryRenderedFeatures({layers:[i]}).length;
                  return out;
                }"""
            )
            style = page.evaluate(
                """() => {
                  const m = window.__mapRef;
                  if (!m) return null;
                  const gl = (m.getStyle()?.layers ?? []).find(x => x.id === 'outdoor-lift-glyphs');
                  const pl = (m.getStyle()?.layers ?? []).find(x => x.id === 'outdoor-lift-labels');
                  const ps = (m.getStyle()?.layers ?? []).find(x => x.id === 'outdoor-piste-labels');
                  if (!gl) return null;
                  return {
                    glyphRotation: gl.layout?.['icon-rotation-alignment'],
                    liftLabelOffset: pl?.layout?.['text-offset'] ?? null,
                    liftLabelRotation: pl?.layout?.['text-rotation-alignment'] ?? null,
                    pisteField: JSON.stringify(ps?.layout?.['text-field']).slice(0, 200),
                  };
                }"""
            )
            if not box or box["width"] < 50:
                print(f"  {name}: no map box ({box})")
                continue
            out = OUT_DIR / f"{name}.png"
            out.write_bytes(page.screenshot(clip=box, timeout=90_000, animations="disabled"))
            total = sum(v for v in counts.values() if isinstance(v, int))
            print(f"  {name}: {out}  {int(box['width'])}x{int(box['height'])}  labels={counts}  (total {total})")
            if style:
                print(f"      applied style: glyph-rotation={style['glyphRotation']!r} "
                      f"lift-text-offset={style['liftLabelOffset']!r} "
                      f"lift-text-rotation={style['liftLabelRotation']!r}")
                print(f"      piste text-field={style['pisteField']}")

        ctx.close()
        browser.close()

    if local:
        local[1].shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())