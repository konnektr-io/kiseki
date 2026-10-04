#!/usr/bin/env python3
"""Photograph the outdoor overlay, and the lift glyphs, at the sizes that ship.

Two jobs, both of which exist because something shipped that nobody looked at:

1. `shoot_glyph_sheet` renders the four lift pictograms at true size (11px, 1×
   device pixels) AND large. The first chairlift shipped because the unit tests
   asserted "four distinct SVGs" — true, and worthless. A pictogram has to be
   LOOKED AT, and this is the artefact that makes that possible.
2. The map shots walk the zoom gate (z11 lines only / z13 labels appear / z15 real
   pistes), scoped to the map container.

    python scripts/shoot-outdoor-overlay.py [base-url] [trip-id]

base-url defaults to the LIVE deployment when there is no local build, so what it
captures is what ships.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

OUT_DIR = pathlib.Path(os.environ.get("SHOOT_DIR") or "/opt/data/cache/shots")
BASE = sys.argv[1] if len(sys.argv) > 1 else "https://kiseki.konnektr.io"
TRIP_ID = sys.argv[2] if len(sys.argv) > 2 else "b16680e7-a338-4c76-9cd7-fa13d45be594"
FRONTEND = pathlib.Path(__file__).resolve().parent.parent

SHOTS = [(11, "z11-lines-only"), (13, "z13-labels-appear"), (15, "z15-pistes-lifts")]
# z15 is framed on the Matterhorn side; the town valley is the worst case for
# label density and the mountain is where the overlay has to earn its keep.
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

# MapLibre v6 is not a global and the app exposes no handle, so the probe hook is
# the only way to reach the live instance.
CAPTURE_MAP = """
(() => {
  window.__mapRef = null;
  window.__probeMap = (map) => { window.__mapRef = map; };
})();
"""

STROKE = "#5b5b63"
CASING = "#ffffff"


def read_kind_nodes() -> dict[str, list[str]]:
    """Pull KIND_NODES out of lib/lift-glyphs.ts.

    Read from the module rather than a pasted copy: a sheet of hand-copied paths
    drifts from the source and then verifies nothing. Regex rather than
    evaluating the TS — transforming the module into runnable JS is fragile
    (quoted object keys, type annotations) and failed twice before this.
    """
    src = (FRONTEND / "src" / "lib" / "lift-glyphs.ts").read_text()
    cable = re.search(r"const CABLE = '([^']+)'", src)
    pylon = re.search(r"const PYLON = '([^']+)'", src)
    if not (cable and pylon):
        raise SystemExit("CABLE/PYLON not found in lift-glyphs.ts")
    consts = {"CABLE": cable.group(1), "PYLON": pylon.group(1)}

    body = src[src.find("const KIND_NODES"):]
    body = body[: body.find("\n};")]
    # drop comments, then read `name: [ ... ],` blocks
    body = re.sub(r"//[^\n]*", "", body)

    out: dict[str, list[str]] = {}
    # The keys may be quoted ("chair_lift") or bare (gondola) — matching only the
    # unquoted form silently dropped half the set, which is precisely the failure
    # this sheet exists to prevent.
    for m in re.finditer(r'"?([\w-]+)"?:\s*\[(.*?)\n\s*\],', body, re.S):
        name, items = m.group(1), m.group(2)
        # Entries are EITHER a bare identifier (CABLE, PYLON) or a quoted path
        # ('<path .../>'). Matching only the quoted form drops the cable and the
        # pylon dot — the sheet then shows a pictogram with no cable, which reads
        # as a different (wrong) icon entirely.
        got = []
        for entry in items.split(","):
            entry = entry.strip()
            if not entry:
                continue
            bare = re.fullmatch(r"[A-Z_][A-Z_0-9]*", entry)
            if bare:
                if entry not in consts:
                    raise SystemExit(f"unknown constant {entry!r} in {name}")
                got.append(consts[entry])
                continue
            q = re.fullmatch(r"'([^']+)'", entry)
            if q:
                got.append(consts.get(q.group(1), q.group(1)))
        if got:
            out[name] = got
    if not out:
        raise SystemExit("could not read any KIND_NODES entries")
    expected = {"gondola", "chair_lift", "t-bar", "funicular"}
    missing = expected - set(out)
    if missing:
        raise SystemExit(
            f"KIND_NODES is missing {sorted(missing)} — the sheet would under-report. "
            "Fix the reader rather than shipping a partial sheet."
        )
    # Every glyph must carry the cable and the pylon dot: they are what make the
    # set read as one family, and a reader that silently drops them renders a
    # plausible-looking but wrong pictogram.
    for name, items in out.items():
        for needed, label in ((cable.group(1), "CABLE"), (pylon.group(1), "PYLON")):
            if not any(needed in it for it in items):
                raise SystemExit(f"{name} is missing {label} — the sheet would lie about it")
    return out


def shoot_glyph_sheet() -> pathlib.Path:
    """Render the pictograms at true size and large. No map needed."""
    from playwright.sync_api import sync_playwright

    nodes = read_kind_nodes()

    def svg(items: list[str], px: int) -> str:
        inner = "".join(n.replace("{fg}", STROKE).replace("{bg}", CASING) for n in items)
        return (f'<svg width="{px}" height="{px}" viewBox="0 0 24 24" '
                f'xmlns="http://www.w3.org/2000/svg">'
                f'<circle cx="12" cy="12" r="11.4" fill="{CASING}"/>'
                f'<g fill="none" stroke="{STROKE}" stroke-width="1.75" stroke-linecap="round" '
                f'stroke-linejoin="round">{inner}</g></svg>')

    kinds = list(nodes)
    large = "".join(
        f'<td style="text-align:center;padding:6px">{svg(nodes[k], 96)}'
        f'<div style="font:12px sans-serif">{k}</div></td>' for k in kinds)
    truepx = "".join(
        f'<td style="text-align:center;padding:10px;background:#e8e8e6">'
        + "".join(svg(nodes[k], 11) for _ in range(8))
        + f'<div style="font:11px sans-serif;margin-top:6px">{k}</div></td>' for k in kinds)
    html = (f'<!doctype html><meta charset=utf-8><body style="margin:0;background:#f4f4f2;'
            f'font-family:DejaVu Sans,sans-serif">'
            f'<div style="padding:12px 16px;font:bold 15px sans-serif">'
            f'lift glyphs &mdash; from lib/lift-glyphs.ts</div>'
            f'<table style="margin-left:16px;border-collapse:collapse"><tr>{large}</tr></table>'
            f'<div style="padding:6px 16px;font:12px sans-serif;color:#555">true size '
            f'(11px, 1&times; device pixels, each 8&times;)</div>'
            f'<table style="margin-left:16px;border-collapse:collapse"><tr>{truepx}</tr></table>'
            f'</body>')
    page = pathlib.Path("/tmp/glyph-sheet.html")
    page.write_text(html)

    out = OUT_DIR / "lift-glyph-sheet.png"
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                     "--enable-unsafe-swiftshader"])
        pg = b.new_context(viewport={"width": 620, "height": 320},
                           device_scale_factor=2).new_page()
        pg.goto(f"file://{page}")
        pg.wait_for_timeout(600)
        pg.screenshot(path=str(out), full_page=True)
        b.close()
    return out


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
    print(f"using {'local build' if local else 'live deployment'}: {base}")

    try:
        print(f"  glyph sheet: {shoot_glyph_sheet()}")
    except SystemExit as exc:
        print(f"  glyph sheet FAILED: {exc}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        # 1.5x, not 2x: the clip is a large element on software WebGL, where 2x
        # quadruples the pixels and the screenshot times out.
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
                    arg=z, timeout=30_000,
                )
            except Exception:
                pass
            if z >= 13:
                # Wait for the SYMBOL tiles, not just the source — see
                # probe-outdoor-overlay.py for why a fixed settle lies here.
                try:
                    page.wait_for_function(
                        """() => {
                          const m = window.__mapRef;
                          if (!m || m.isMoving()) return false;
                          const ids = ['outdoor-lift-glyphs','outdoor-piste-labels',
                                       'outdoor-trail-labels','outdoor-lift-labels'];
                          return ids.some(i => {
                            try { return m.queryRenderedFeatures({ layers: [i] }).length > 0; }
                            catch (e) { return false; }
                          });
                        }""",
                        timeout=20_000,
                    )
                except Exception:
                    pass
            page.wait_for_timeout(5_000)

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
                  return {glyphRotation: gl.layout?.['icon-rotation-alignment'],
                          liftLabelOffset: pl?.layout?.['text-offset'] ?? null,
                          liftLabelRotation: pl?.layout?.['text-rotation-alignment'] ?? null,
                          pisteField: JSON.stringify(ps?.layout?.['text-field']).slice(0,200)};
                }"""
            )
            if not box or box["width"] < 50:
                print(f"  {name}: no map box ({box})")
                continue
            out = OUT_DIR / f"{name}.png"
            out.write_bytes(page.screenshot(clip=box, timeout=90_000, animations="disabled"))
            total = sum(v for v in counts.values() if isinstance(v, int))
            print(f"  {name}: {out}  {int(box['width'])}x{int(box['height'])}  "
                  f"labels={counts}  (total {total})")
            if style:
                print(f"      applied: glyph-rotation={style['glyphRotation']!r} "
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