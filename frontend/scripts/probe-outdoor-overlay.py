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
3. **Labels + lift glyphs.** Four label layers exist, all four lift sprites are
   registered, and the labels sit *below* the trip's own layers. The zoom gate is
   read through `queryRenderedFeatures`, not `getLayoutProperty('visibility')`:
   minzoom is enforced by the renderer, not by that property, so asking the
   property reports a layer as "visible" below its gate and proves nothing.
4. **Print path.** Zero Maptoolkit requests while a booklet render happens is
   proof the overlay stayed out of the PDF (the Maptoolkit community licence's
   § 07(d) forbids printed media, so this is a licence assertion, not a nicety).

Ordering note that cost a run: every map measurement happens BEFORE the
print-path `page.goto`. That navigation loads a new document, so `__mapRef` is
gone afterwards and anything read post-goto measures nothing while looking like
a measurement.

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
import os
import pathlib
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FRONTEND = pathlib.Path(__file__).resolve().parent.parent
DIST = FRONTEND / "dist"
MTK = "maptoolkit.org"

# Where the probe leaves its pictures. A failed run should still leave evidence
# behind, so this defaults outside the repo and is overridable.
OUT_SHOT_DIR = os.environ.get("PROBE_OUT_SHOT_DIR") or "/opt/data/cache/shots"

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
        ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
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
        console: list[str] = []

        page.on("console", lambda msg: console.append(f"{msg.type}: {msg.text}") if msg.type in ("error", "warning") else None)
        page.on("pageerror", lambda exc: console.append(f"pageerror: {exc}"))
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
        # Ordering is checked PER TYPE. The first `symbol` layer is the basemap's
        # own place labels, and the rule is "our lines sit below those" — but our
        # LABEL layers are themselves symbols, so asserting every `outdoor-*` id
        # precedes the first symbol is self-contradictory (it fails the moment the
        # labels ship). What must hold:
        #   lines  → below the basemap's first symbol
        #   labels → below the trip's own layers
        # ...which is what `label_below_trip` checks separately below.
        stack_ok = page.evaluate(
            """() => {
              const m = window.__mapRef;
              if (!m) return null;
              const ls = m.getStyle().layers ?? [];
              const firstSymbol = ls.findIndex(l => l.type === 'symbol');
              const lines = ls.map((l, i) => [l.id, i])
                .filter(([id]) => id.startsWith('outdoor-') && !id.includes('label') && !id.includes('glyph'));
              if (!lines.length || firstSymbol < 0) return null;
              return lines.every(([, i]) => i < firstSymbol);
            }"""
        )

        # ---- labels + lift glyphs ------------------------------------------
        # Measured BEFORE the print-path navigation below: that goto wipes
        # `__mapRef` (a fresh page has a fresh probe hook), so anything read
        # after it is measuring nothing.
        label_layers = page.evaluate(
            """() => {
              const m = window.__mapRef;
              if (!m) return null;
              return (m.getStyle()?.layers ?? []).map(l => l.id)
                .filter(i => i.startsWith('outdoor-') && (i.includes('label') || i.includes('glyph')));
            }"""
        )
        sprites = page.evaluate(
            """() => {
              const m = window.__mapRef;
              if (!m || typeof m.hasImage !== 'function') return null;
              return ['lift-glyph-gondola','lift-glyph-chair_lift','lift-glyph-t-bar','lift-glyph-funicular']
                .filter(id => m.hasImage(id));
            }"""
        )
        # The trip-priority rule, asserted: the outdoor labels must sit BELOW the
        # trip's own layers, so a piste name can never outrank a place pin.
        label_below_trip = page.evaluate(
            """() => {
              const m = window.__mapRef;
              if (!m) return null;
              // The layer OBJECTS, not just their ids — the predicates below need
              // `type` to tell our line layers from our symbol layers. An earlier
              // version mapped to ids only, so `l.type` was undefined and every
              // anchor came back -1 while the notes still read plausibly.
              const ls = (m.getStyle()?.layers ?? []);
              // The rule worth asserting is about OUR OWN stack, because that is
              // what this change controls:
              //   lines  <  labels            (a name sits on its own line)
              //   labels <  every basemap symbol (place labels stay readable on top)
              // An earlier version tried to locate "the trip's layers" by naming
              // prefixes, and every guess was wrong in a way that FAILED THE
              // ASSERTION rather than skipping it — `park` and `highway_*` are
              // basemap layers, so "first non-outdoor layer" matched index 1 and
              // reported the labels as being on top of the trip. The trip's own
              // route layers are level-dependent and absent on the scan level, so
              // they cannot be the anchor; the basemap symbol boundary can.
              // NOTE: `ls` is built from `map.getStyle().layers`, and every entry
              // has an id — but the predicates below must still tolerate one
              // that does not, because `findIndex` hands the callback the raw
              // element and a missing id then throws inside the page (which
              // surfaces as an opaque "Cannot read properties of undefined").
              const isOutdoor = (id) => typeof id === 'string' && id.startsWith('outdoor-');
              const idx = (pred) => ls.findIndex((l, i) => pred(l, i));
              const lines = idx((l) => isOutdoor(l.id) && l.type === 'line');
              const labels = idx((l) => isOutdoor(l.id) && l.type === 'symbol');
              const outdoorIdx = ls.map((l, i) => [l.id, i]).filter(([id]) => isOutdoor(id)).map(([, i]) => i);
              const lastLabel = outdoorIdx.length ? outdoorIdx[outdoorIdx.length - 1] : null;
              const firstBaseSymbol = idx((l) => l.type === 'symbol' && !isOutdoor(l.id));
              return {
                lines, labels, lastLabel, firstBaseSymbol,
                ourStack: ls.map((l, i) => [l.id, i]).filter(([id]) => isOutdoor(id)),
              };
            }"""
        )
        # The zoom gate. MapLibre reports a below-minzoom layer's visibility as
        # unset, and `visibility` is not what minzoom acts through — so the
        # honest read is `queryRenderedFeatures`, which is what actually asks
        # "did this draw".
        zoom_gate = {}
        for z in (11, 14):
            # Move AND wait for the move to settle. `jumpTo` returns immediately;
            # querying straight after reads the PREVIOUS camera's tiles, which is
            # how an earlier run reported "0 labels at z14" while the screenshot
            # taken at the same z14 showed the map on a different level entirely.
            # `idle` is the only honest signal that the frame has been rendered.
            page.evaluate(
                """(z) => {
                  const m = window.__mapRef;
                  if (!m || typeof m.jumpTo !== 'function') return;
                  m.jumpTo({ center: [7.7491, 46.0207], zoom: z });
                }""",
                z,
            )
            try:
                page.wait_for_function(
                    """() => {
                      const m = window.__mapRef;
                      return !!m && !m.isMoving() && Math.abs(m.getZoom() - %d) < 0.01;
                    }"""
                    % z,
                    timeout=25_000,
                )
            except Exception:
                pass
            # Wait for the SOURCE, not a timer. `isSourceLoaded` was still false
            # at z14 while the previous zoom's tiles were on screen, so the query
            # ran against a viewport whose symbol tiles had not arrived yet and
            # reported zero for every layer.
            try:
                page.wait_for_function(
                    """() => {
                      const m = window.__mapRef;
                      if (!m) return false;
                      const s = m.getSource('kiseki-outdoor');
                      return !!s && m.isSourceLoaded('kiseki-outdoor') && !m.isMoving();
                    }""",
                    timeout=30_000,
                )
            except Exception:
                pass
            page.wait_for_timeout(3_000)  # let the symbol tiles settle
            zoom_gate[z] = page.evaluate(
                """() => {
                  const m = window.__mapRef;
                  if (!m) return 'no-map';
                  // EVERY label layer, not just the piste one — the fragments
                  // differ in length per class, so a single layer can legitimately
                  // place nothing while another places plenty. Counting one layer
                  // and calling it "no labels" hides which half actually works.
                  const out = {};
                  for (const id of ['outdoor-lift-glyphs','outdoor-piste-labels','outdoor-trail-labels','outdoor-lift-labels']) {
                    try { out[id] = m.queryRenderedFeatures({ layers: [id] }).length; }
                    catch (e) { out[id] = 'err:' + e.message; }
                  }
                  out.__zoom = Math.round(m.getZoom() * 100) / 100;
                  out.__srcLoaded = !!m.getSource('kiseki-outdoor') && m.isSourceLoaded('kiseki-outdoor');
                  // Distinguish "no lift features in the tiles" from "the sprites
                  // are missing" — both look identical from the render count alone,
                  // and the second one is a silent failure worth catching.
                  try {
                    out.__sprites = ['lift-glyph-gondola','lift-glyph-chair_lift','lift-glyph-t-bar','lift-glyph-funicular']
                      .filter(id => m.hasImage(id)).length;
                    const feats = m.querySourceFeatures('kiseki-outdoor', { sourceLayer: 'road_label' });
                    out.__liftFeaturesInTiles = feats.filter(f =>
                      ['chair_lift','drag_lift','t-bar','j-bar','platter','gondola','cable_car','funicular']
                        .includes((f.properties||{}).subtype)).length;
                  } catch (e) { out.__diagErr = String(e.message || e); }
                  return out;
                }"""
            )

        # ---- pictures of the map that actually carries the overlay ----------
        # Scoped to the CONTAINER that owns `__mapRef`, not the whole page: an
        # itinerary page also renders MapView thumbnails, so a full-page shot can
        # show an unrelated overview map and read as "no labels at all".
        # Three zooms, because the gate is the thing worth seeing: z11 (lines,
        # no labels), z13 (labels switch on), z15 (real pistes + lifts).
        for _z, _name in ((11, "z11-lines-only"), (13, "z13-labels-appear"), (15, "z15-pistes-lifts")):
            try:
                page.evaluate(
                    "(z) => { const m = window.__mapRef; if (m) m.jumpTo({center:[7.7491,46.0207], zoom: z}); }",
                    _z,
                )
                page.wait_for_function(
                    """(z) => {
                      const m = window.__mapRef;
                      if (!m) return false;
                      const s = m.getSource('kiseki-outdoor');
                      return !!s && m.isSourceLoaded('kiseki-outdoor') && !m.isMoving()
                             && Math.abs(m.getZoom() - z) < 0.01;
                    }""",
                    _z,
                    timeout=30_000,
                )
                page.wait_for_timeout(5_000)
                box = page.evaluate(
                    """() => {
                      const m = window.__mapRef;
                      if (!m) return null;
                      const r = m.getContainer().getBoundingClientRect();
                      return { x: r.x, y: r.y, width: r.width, height: r.height };
                    }"""
                )
                if box and box["width"] > 50 and box["height"] > 50:
                    out = Path(OUT_SHOT_DIR) / f"{_name}.png"
                    out.write_bytes(page.screenshot(clip=box))
                    drawn = page.evaluate(
                        """() => {
                          const m = window.__mapRef;
                          if (!m) return '?';
                          const ids = ['outdoor-lift-glyphs','outdoor-piste-labels','outdoor-trail-labels','outdoor-lift-labels'];
                          return ids.reduce((n, i) => n + m.queryRenderedFeatures({ layers: [i] }).length, 0);
                        }"""
                    )
                    notes.append(f"shot {_name}: {out} ({int(box['width'])}x{int(box['height'])}, {drawn} label features)")
                else:
                    notes.append(f"shot {_name}: skipped, bad box {box}")
            except Exception as exc:
                notes.append(f"shot {_name} failed: {exc}")

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

    Path(OUT_SHOT_DIR).mkdir(parents=True, exist_ok=True)
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

    if label_layers:
        notes.append(f"label/glyph layers on the map: {len(label_layers)}")
    else:
        failures.append("no outdoor label/glyph layers — the labels never installed")

    if sprites is None:
        failures.append("no map handle — could not read registered lift sprites")
    else:
        notes.append(f"lift sprites registered: {len(sprites)}/4")
        if len(sprites) < 4:
            failures.append(f"only {len(sprites)}/4 lift sprites registered")

    if label_below_trip is None:
        failures.append("no map handle — could not read the outdoor stack order")
    else:
        st = label_below_trip
        notes.append(
            f"outdoor lines @ {st['lines']}, labels @ {st['labels']}, "
            f"basemap's first symbol @ {st['firstBaseSymbol']}"
        )
        if st["lines"] < 0 or st["labels"] < 0 or st["firstBaseSymbol"] < 0:
            failures.append(f"could not locate all three stack anchors: {st}")
        else:
            if not st["lines"] < st["labels"]:
                failures.append(f"outdoor labels ({st['labels']}) are not above their own lines ({st['lines']})")
            else:
                notes.append("labels sit above their own lines: yes")
            last_label = st["lastLabel"] if st["lastLabel"] is not None else -1
            if not last_label < st["firstBaseSymbol"]:
                failures.append(
                    f"outdoor labels (last @ {last_label}) are not below the basemap's "
                    f"first symbol layer (@ {st['firstBaseSymbol']}) — basemap labels could be buried"
                )
            else:
                notes.append("outdoor labels stay below the basemap's labels: yes")

    # The trip-priority rule in pixels: below the gate nothing is drawn at all.
    LABEL_LAYERS = ["outdoor-lift-glyphs", "outdoor-piste-labels", "outdoor-trail-labels", "outdoor-lift-labels"]

    def total(entry):
        if not isinstance(entry, dict):
            return None
        return sum(v for v in (entry.get(k) for k in LABEL_LAYERS) if isinstance(v, int))

    n11, n14 = total(zoom_gate.get(11)), total(zoom_gate.get(14))
    for z in (11, 14):
        e = zoom_gate.get(z)
        if isinstance(e, dict):
            notes.append(
                f"@ z{z} (actual zoom {e.get('__zoom')}, source loaded {e.get('__srcLoaded')}): "
                + ", ".join(f"{k.replace('outdoor-','')}={e.get(k)}" for k in LABEL_LAYERS)
            )
            for k in ("__sprites", "__liftFeaturesInTiles", "__diagErr"):
                if e.get(k) is not None:
                    notes.append(f"    {k} = {str(e[k])[:230]}")
    if n11 is None or n14 is None:
        failures.append(f"lost the map handle during the zoom gate ({zoom_gate.get(11)!r}, {zoom_gate.get(14)!r})")
    else:
        if n11 != 0:
            failures.append(f"outdoor labels already draw at z11 ({n11} features) — the zoom gate is not holding")
        if not n14:
            failures.append("no outdoor label or glyph draws at z14 — the annotation would never appear")

    if print_mtk:
        failures.append(
            f"the print path loaded Maptoolkit ({len(print_mtk)} requests) — § 07(d) forbids "
            "printed media; the overlay must stay off the booklet path"
        )
    else:
        notes.append("print path loaded zero Maptoolkit requests (licence § 07(d) satisfied)")

    interesting = [c for c in console if any(k in c.lower() for k in
                    ("glyph", "font", "sprite", "icon", "symbol", "outdoor", "error"))]
    if interesting:
        notes.append(f"console/page errors ({len(interesting)}):")
        for c in interesting[:8]:
            notes.append(f"    {c[:170]}")
    elif console:
        notes.append(f"console had {len(console)} error/warning lines, none glyph-related")

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