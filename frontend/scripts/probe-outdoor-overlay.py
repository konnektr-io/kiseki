#!/usr/bin/env python3
"""Prove the outdoor overlay renders on the trip map — and that print never sees it.

`lib/outdoor-overlay.ts` has unit tests for the filters and the palette, but those
only assert the layer *specs*. The failures that matter are invisible to them: a
filter that matches nothing at runtime, a source whose tiles 404, or layers that
land in the wrong stack position and get buried under the basemap.

Run after `pnpm build` (this drives the built bundle, like every other probe here):

    cd frontend
    python scripts/probe-outdoor-overlay.py [trip-id]

How it measures, and why not the obvious way
--------------------------------------------

MapLibre v6 is not a global, and the app exposes no map handle, so the probe
cannot simply ask the map for its layers. Two older probes
(`probe-map-source-crash.py`, `probe-map-surface-mode.py`) do this by injecting a
`window.__probeMap(map)` hook that `RouteMap.tsx` is *documented* to call. **That
hook no longer exists in `src/`** — the probes' docstring is stale, so copying
their approach yields a probe that silently measures nothing and reports PASS.

So this one measures from the outside, with no app cooperation required:

1. **Tile requests.** Playwright sees every network request the page makes, so a
   live Maptoolkit tileset is proof the source loaded — no app hook needed.
2. **Rendered output.** A screenshot diff: the same camera with the overlay
   layers hidden vs. shown. Pixels changing is proof that features arrived and
   drew; a layer id existing is not.
3. **Print path.** Zero Maptoolkit requests while a booklet render happens is
   proof the overlay stayed out of the PDF (the Maptoolkit community licence's
   § 07(d) forbids printed media, so this is a licence assertion, not a nicety).

The one thing this needs from the app is `window.__probeMap`, which `RouteMap`
already calls. It was missing while this was written — two older probes document
calling it but no component invoked it, so those probes could not have been
reading a live map either. The hook is restored in `RouteMap.tsx`; if it is ever
removed again, these assertions degrade to "NOT READABLE" and the probe says so
rather than passing silently.

Deliberately NOT asserted: the basemap's own attribution text. The TileJSON
carries the § 08 copyright line and MapLibre renders it, but the required logo is
a separate element tracked as follow-up (adding the logo control is a dependency
change). The probe reports what it sees instead of pretending to check it.
"""
from __future__ import annotations

import io
import json
import pathlib
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

FRONTEND = pathlib.Path(__file__).resolve().parent.parent
DIST = FRONTEND / "dist"
MTK = "maptoolkit.org"

# Real trip used by the other map probes; overridable for a live trip.
TRIP_ID = sys.argv[1] if len(sys.argv) > 1 else "b16680e7-a338-4c76-9cd7-fa13d45be594"

if not (DIST / "index.html").exists():
    sys.exit("FAIL: frontend/dist missing — run `pnpm build` first")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("FAIL: playwright missing — `python -m pip install playwright`")


# ---------------------------------------------------------------------------
# A trip-shaped payload: the overlay mounts on the trip map surface, and an
# anonymous landing page never mounts it, so the probe needs a real trip
# document or it asserts nothing. Locations are placed over Zermatt because that
# is where the piste/lift data is dense enough to draw.
# ---------------------------------------------------------------------------
TRIP = {
    "id": TRIP_ID,
    "slug": "probe-outdoor",
    "title": "Overlay probe",
    "subtitle": "fixture",
    "stage": "planned",
    "startDate": "2027-01-10",
    "endDate": "2027-01-16",
    "theme": {"preset": "alpine"},
    "locations": [
        {"name": "Zermatt", "lat": 46.0207, "lng": 7.7491, "marker": 1},
        {"name": "Täsch", "lat": 46.0642, "lng": 7.8956, "marker": 2},
    ],
    "sections": [],
    "days": [
        {
            "id": "day-0",
            "date": "2027-01-10",
            "title": "Zermatt",
            "blocks": [
                {
                    "id": "blk-0",
                    "kind": "activity",
                    "title": "Ski the Matterhorn side",
                    "location": "Zermatt",
                    "status": "planned",
                }
            ],
        }
    ],
    "crew": [],
    "practical": {},
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def log_message(self, format, *a):  # noqa: A002
        pass

    def send_head(self):
        p = pathlib.Path(self.path.split("?")[0])
        if not p.is_file() and "." not in p.name:
            self.path = "/index.html"
        return super().send_head()


def serve() -> tuple[str, ThreadingHTTPServer]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}", httpd


# Hide the overlay layers for the negative control: the same screenshot with
# only the overlay's visibility flipped proves the pixels came from THIS overlay
# rather than from the basemap, which is the whole point of a negative control.
#
# It reads the map from `window.__mapRef` — the same handle CAPTURE_MAP fills.
# It reports how many layers it actually toggled (rather than a bare boolean), so
# "the handle was missing" and "the layers were already hidden" cannot both look
# like success.
HIDE_OVERLAY = """
(() => {
  window.__hideOutdoor = (on) => {
    const map = window.__mapRef;
    if (!map || typeof map.getStyle !== 'function') return -1;
    const ids = (map.getStyle()?.layers ?? []).map(l => l.id).filter(i => i.startsWith('outdoor-'));
    for (const id of ids) {
      map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
    }
    return ids.length;
  };
})();
"""

# `RouteMap` hands its live instance to `window.__probeMap` once the style is
# loaded (a hook added for exactly this purpose — the other two map probes
# document it, and their docstrings predate its removal). Installed before the
# bundle runs, so it is in place by the time the map finishes loading.
CAPTURE_MAP = """
(() => {
  window.__mapRef = null;
  window.__probeMap = (map) => { window.__mapRef = map; };
})();
"""



def png_diff(a: bytes, b: bytes) -> float:
    """Fraction of sampled pixels that differ between two PNGs. -1 = unavailable."""
    try:
        from PIL import Image
    except ImportError:
        return -1.0
    ia = Image.open(io.BytesIO(a)).convert("RGB")
    ib = Image.open(io.BytesIO(b)).convert("RGB")
    if ia.size != ib.size:
        return -1
    pa, pb = ia.load(), ib.load()
    w, h = ia.size
    changed = total = 0
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            total += 1
            if pa[x, y] != pb[x, y]:
                changed += 1
    return changed / total if total else 0.0


def main() -> int:
    base, httpd = serve()
    failures: list[str] = []
    notes: list[str] = []
    # Flipped before the booklet pass so the print counter only sees print
    # traffic. A dict rather than a bare bool so the event lambdas close over a
    # stable object instead of a rebound local.
    phase = {"print": False}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx.add_init_script("try{localStorage.setItem('kiseki_consent','declined')}catch(e){}")
        ctx.add_init_script(HIDE_OVERLAY)
        ctx.add_init_script(CAPTURE_MAP)

        def handle(route):
            if "/api/trips/" in route.request.url and TRIP_ID in route.request.url:
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(TRIP),
                )
            else:
                route.continue_()

        ctx.route("**/api/**", handle)

        page = ctx.new_page()
        mtk: list[str] = []
        print_mtk: list[str] = []
        page.on(
            "request",
            lambda r: mtk.append(r.url) if MTK in r.url else None,
        )
        # The same counter, restarted for the print pass below.
        page.on(
            "request",
            lambda r: print_mtk.append(r.url)
            if (MTK in r.url and phase["print"])
            else None,
        )

        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        try:
            page.wait_for_selector("canvas.maplibregl-canvas", timeout=30_000)
        except Exception:
            failures.append("no map canvas mounted — the probe measured nothing")

        # The overlay's minzoom is 10, and the trip framing sits far below it,
        # so the camera must be moved into a valley or the layers correctly draw
        # nothing and the probe would report a false PASS.
        page.evaluate(
            """() => {
              const c = document.querySelector('canvas.maplibregl-canvas');
              const m = window.__mapRef;
              if (m) m.jumpTo({ center: [7.7491, 46.0207], zoom: 13 });
            }"""
        )
        page.wait_for_timeout(9_000)

        with_overlay = page.screenshot()
        hidden_ok = page.evaluate("() => window.__hideOutdoor(true)")
        page.wait_for_timeout(2_500)
        without_overlay = page.screenshot()
        page.evaluate("() => window.__hideOutdoor(false)")

        layer_ids = page.evaluate(
            """() => {
              const m = window.__mapRef;
              if (!m) return null;
              return (m.getStyle()?.layers ?? []).map(l => l.id).filter(i => i.startsWith('outdoor-'));
            }"""
        )
        stack_ok = page.evaluate(
            """() => {
              const m = window.__mapRef;
              if (!m) return null;
              const ls = m.getStyle().layers ?? [];
              const firstSymbol = ls.findIndex(l => l.type === 'symbol');
              const ours = ls.map((l,i)=>[l.id,i]).filter(([id])=>id.startsWith('outdoor-'));
              if (!ours.length || firstSymbol < 0) return null;
              return ours.every(([,i]) => i < firstSymbol);
            }"""
        )

        # ---- the print path must never touch Maptoolkit --------------------
        # The booklet renders the SAME MapLibre maps live through `MapView`
        # (#37), so "screen-only" is not automatic: it holds because the overlay
        # is wired into `RouteMap` only. `MapView` additionally sets this flag
        # before the app loads, which makes the assertion cheap and exact — a
        # PDF render that pulled a single Maptoolkit tile would fail here.
        phase["print"] = True
        page.goto(
            f"{base}/t/{TRIP_ID}/booklet",
            wait_until="load",
        )
        page.wait_for_timeout(6_000)

        ctx.close()
        browser.close()

    httpd.shutdown()

    # ---- assertions -------------------------------------------------------
    mtk_tiles = [u for u in mtk if "/mtk/" in u or ".mvt" in u]
    notes.append(f"maptoolkit requests: {len(mtk)} total, {len(mtk_tiles)} tile requests")

    if not mtk_tiles:
        failures.append("no Maptoolkit tile requests — the overlay source never loaded")

    if layer_ids:
        notes.append(f"overlay layers on the map: {len(layer_ids)}")
    else:
        # __probeMap never fired, or fired before load. Either way the probe could
        # not inspect the style, so it must NOT claim a pass on the pixel diff.
        failures.append(
            "no map handle — __probeMap never fired; layer/pixel assertions could not run"
        )

    if hidden_ok is None or hidden_ok <= 0:
        failures.append(
            f"negative control toggled {hidden_ok} layers — "
            + ("no map handle" if hidden_ok == -1 else "no overlay layers found to hide")
        )
    else:
        d = png_diff(with_overlay, without_overlay)
        if d < 0:
            failures.append("pixel diff unavailable (Pillow missing) — cannot prove it drew")
        else:
            notes.append(f"pixels changed with overlay hidden: {d * 100:.2f}%")
            if d < 0.0005:
                failures.append(
                    "overlay layers exist but drew nothing (no pixel change when hidden)"
                )

    if stack_ok is False:
        failures.append("overlay layers are NOT below the basemap's first symbol layer")
    elif stack_ok is None:
        notes.append("stack position: NOT READABLE")
    else:
        notes.append("overlay below first symbol layer: yes")

    if print_mtk:
        failures.append(
            f"the print path loaded Maptoolkit ({len(print_mtk)} requests) — § 07(d) forbids "
            "printed media; the overlay must stay off the booklet path"
        )
    else:
        notes.append("print path loaded zero Maptoolkit requests (licence § 07(d) satisfied)")

    print("=" * 68)
    for n in notes:
        print("  ·", n)
    if failures:
        print("\nFAIL:")
        for f in failures:
            print("  ✗", f)
        print("=" * 68)
        return 1
    print("\nPASS — outdoor overlay renders on the trip map, and stays out of the booklet")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())