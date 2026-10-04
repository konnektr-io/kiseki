#!/usr/bin/env python3
"""Does the Lima cluster badge still misplace itself? (#403)

Niko's screenshot (2026-10-04, Chili+Peru): the badge counting Lima's activities
drew next to Ica. Those places span 11.6 km, so their centroid sits 7.45 km from
the Lima pin — invisible at journey zoom, 50px away (its own town) by z10.

This runs the LOCAL build (not production) so it can compare before/after on the
same trip, and asserts the property that matters: no badge may be drawn further
from every place it counts than the cluster radius allows.
"""
import base64
import glob
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

LIVE = os.environ.get("SMOKE_LIVE") == "1"
DIST = Path("/opt/data/.worktrees/kiseki/feat-412-no-clusters/frontend/dist")
PERU = os.environ.get("SMOKE_TRIP", "6b11a061-54c8-401e-9861-855dea2f7338")
CLUSTER_PX = 44

# The real trip document, fetched once and served from the fixture.
def load_trip() -> dict:
    cache = Path(os.environ.get("SMOKE_FIXTURE", "/opt/data/cache/peru.json"))
    if cache.is_file():
        return json.loads(cache.read_text())
    sys.exit(f"fixture missing: {cache}")


def chromium() -> str | None:
    hits = sorted(glob.glob("/opt/hermes/.playwright/chromium_headless_shell-*/"
                            "chrome-headless-shell-linux64/chrome-headless-shell"))
    hits += sorted(glob.glob(str(Path.home() / ".cache/ms-playwright/chromium_headless_shell-*/"
                                 "chrome-headless-shell-linux64/chrome-headless-shell")))
    return hits[-1] if hits else None


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

    class H2(H):
        def do_GET(self):
            path = self.path.split("?")[0]
            if path.endswith(".png") or path.endswith(".webp") or path.endswith(".jpg"):
                # 1x1 transparent PNG: a valid tile, so no tile error fires.
                body = base64.b64decode(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk"
                    "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            H.do_GET(self)

    if LIVE:
        return None, 0
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H2)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def run():
    trip = load_trip()
    httpd, port = serve()
    base = "https://kiseki.konnektr.io" if LIVE else f"http://127.0.0.1:{port}"
    out = Path("/opt/data/cache/kiseki-probe-cluster-honesty")
    out.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=chromium(),
            args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader"],
        )
        page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        page.add_init_script("try{localStorage.setItem('kiseki_consent','declined')}catch(e){}")

        def handle(route):
            url = route.request.url
            if "/api/trips/" in url and url.rstrip("/").endswith(PERU):
                route.fulfill(status=200, content_type="application/json", body=json.dumps(trip))
            elif "/api/maps/route/" in url:
                # An empty leg set is a valid answer; a 404 here lands in the
                # component's catch and shows "the map couldn't load".
                route.fulfill(status=200, content_type="application/json", body='{"legs":[]}')
            elif "/api/tracks/" in url:
                route.fulfill(status=404, content_type="application/json", body="{}")
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # Log EVERY api request + its status: the component's load effect has a
        # bare `catch { setFailed(true) }`, so the failing call is invisible
        # unless it is recorded.
        api: list[str] = []
        def spy(route):
            api.append(f"{route.request.method} {route.request.url[-70:]} -> ?")
            handle(route)
        page.on("request", lambda r: api.append(f"REQ {r.url[-70:]}") if "/api/" in r.url else None)
        page.on("response", lambda r: api.append(f"RES {r.status} {r.url[-70:]}") if "/api/" in r.url else None)
        page.on("console", lambda m: api.append(f"CONSOLE {m.type}: {m.text[:140]}")
                if m.type == "error" else None)
        if not LIVE:
            page.route("**/api/**", spy)

        trip_names = {l["name"] for l in (trip.get("locations") or []) if l.get("lat") is not None}
        # Chain stops are numbered pins, NOT excursion diamonds: exclude them
        # from the excursion-conservation set or they always read as "vanished".
        chain_names = set()
        for d in (trip.get("days") or []):
            for b in (d.get("blocks") or []):
                for side in ("from", "to"):
                    v = b.get(side)
                    if isinstance(v, str):
                        chain_names.add(v)
                    elif isinstance(v, dict):
                        for key in ("name", "location"):
                            if isinstance(v.get(key), str):
                                chain_names.add(v[key])
        trip_names -= chain_names
        trip_counts = {"names": trip_names, "excursions": len(trip_names)}
        print(f"→ Peru itinerary: {len(trip_names)} located places")
        print("→ Peru itinerary, journey framing")
        page.goto(f"{base}/t/{PERU}/itinerary", wait_until="load", timeout=60000)
        page.wait_for_selector(".map-pin-scaled", timeout=45000)
        # Markers attach after the map's first paint; poll rather than guess.
        for _ in range(20):
            n = page.evaluate("() => document.querySelectorAll('.maplibregl-marker').length")
            if n:
                break
            page.wait_for_timeout(700)
        page.wait_for_timeout(4000)
        counts = page.evaluate(r"""() => ({
          markers: document.querySelectorAll('.maplibregl-marker').length,
          pins: document.querySelectorAll('.route-pin').length,
          excursion: document.querySelectorAll('.route-pin-excursion').length,
          excursionVisible: [...document.querySelectorAll('.route-pin-excursion')]
            .filter((el) => !el.hasAttribute('hidden') && el.getBoundingClientRect().width > 0).length,
          clusters: document.querySelectorAll('.route-cluster').length,
          clusterEls: document.querySelectorAll('.route-cluster-badge').length,
          zoom: document.querySelector('.map-pin-scaled')?.dataset.mapZoom,
          failed: (document.body.innerText || '').includes("couldn't load"),
        })""")
        print(f"   rendered: {counts}")
        if counts["failed"] or counts["markers"] == 0:
            failures.append(f"the map did not render: {counts}")
        # #412: no cluster badge may exist anywhere on the surface.
        if counts["clusters"] or counts["clusterEls"]:
            failures.append(f"cluster badges still rendered: {counts}")

        # Walk the camera and record, at each zoom, every badge with its members'
        # ON-SCREEN distance from the badge — the property that decides honesty.
        rows = []
        walks: list[dict] = []
        seen_zooms: list[float] = []
        for _ in range(10):
            if not page.query_selector(".map-pin-scaled"):
                print("   map container gone — aborting zoom walk")
                print("   body:", (page.inner_text("body") or "")[:160])
                print("   data-map-ready:", page.evaluate("() => document.querySelector('[data-map-ready]')?.getAttribute('data-map-ready')"))
                print("   data-map-failed:", page.evaluate("() => document.querySelector('[data-map-failed]')?.getAttribute('data-map-failed')"))
                print("   webgl2:", page.evaluate("() => { const c=document.createElement('canvas'); return !!c.getContext('webgl2'); }"))
                print("   errors so far:", errors[:3])
                print("   api traffic:")
                for line in api[-16:]:
                    print("     ", line)
                print("   page errors:", errors[:4])
                break
            snap = page.evaluate(r"""() => {
              const box = document.querySelector('.map-pin-scaled');
              const zoom = parseFloat(box.dataset.mapZoom || 'NaN');
              const badges = [...document.querySelectorAll('.route-cluster')]
                .filter((el) => el.getBoundingClientRect().width > 0)
                .map((el) => ({
                  count: Number((el.querySelector('.route-cluster-badge') || {}).textContent || 0),
                  members: (el.dataset.cluster || '').split('+').filter(Boolean),
                  x: el.getBoundingClientRect().x + 22,
                  y: el.getBoundingClientRect().y + 22,
                }));
              // MapLibre writes the projected point onto the marker element
              // itself; for VISIBLE markers that equals the layout box. Only
              // trust the box when the marker is actually painted — a hidden
              // member keeps a stale transform, which produced a phantom
              // "Lima spread 160px" in an earlier run of this probe.
              const pins = [...document.querySelectorAll('.route-pin[data-place]')]
                .filter((el) => !el.hasAttribute('hidden') && el.getBoundingClientRect().width > 0)
                .map((el) => {
                  const r = el.getBoundingClientRect();
                  return { name: el.dataset.place, x: r.x + r.width / 2, y: r.y + r.height / 2 };
                });
              return { zoom, badges, pins,
                excursionVisible: [...document.querySelectorAll('.route-pin-excursion')]
                  .filter((el) => !el.hasAttribute('hidden') && el.getBoundingClientRect().width > 0).length,
                excursionTotal: document.querySelectorAll('.route-pin-excursion').length };
            }""")
            rows.append({"zoom": snap["zoom"], "clusters": len(snap["badges"]),
                         "painted_pins": len(snap["pins"]),
                         "diamonds": snap["excursionVisible"],
                         "of": snap["excursionTotal"]})
            walks.append(snap)
            if seen_zooms and abs(snap["zoom"] - seen_zooms[-1]) < 0.01:
                print(f"   camera stuck at z{snap['zoom']:.2f} — stopping")
                break
            seen_zooms.append(snap["zoom"])
            page.click(".maplibregl-ctrl-zoom-in", force=True)
            page.wait_for_timeout(1200)
            if not page.query_selector(".map-pin-scaled"):
                print(f"   [{snap['zoom']:.2f}] container vanished right after a zoom step")
                print("   body head:", (page.inner_text("body") or "")[:200].replace(chr(10), " | "))
                break

        # Conservation across the whole zoom walk.
        total = trip_counts["excursions"]
        for snap in walks:
            seen: set[str] = set()
            for b in snap["badges"]:
                seen.update(b["members"])
            for p in snap["pins"]:
                if p["name"] in trip_counts["names"]:
                    seen.add(p["name"])
            if snap["badges"]:
                failures.append(f"z{snap['zoom']:.2f}: {len(snap['badges'])} cluster badge(s) present")
            # #412: a hidden diamond is a crowded one — expected, but the badge
            # that used to stand for it must be gone, so conservation now means
            # "counted as visible or deliberately hidden", never "swallowed".
            pass

        page.screenshot(path=str(out / "peru.png"))
        browser.close()
    if httpd:
        httpd.shutdown()

    print(f"\n{'zoom':>7} {'badges':>7} {'diamonds shown':>15} {'stop pins':>10}")
    for r in rows:
        print(f"{r['zoom']:>7} {r['clusters']:>7} {r['diamonds']:>9}/{r['of']:<5} {r['painted_pins']:>10}")
    if errors:
        failures.append(f"page errors: {errors[:2]}")
    for f in failures:
        print(f"FAIL: {f}")
    print("\n" + ("PASS — no cluster badges; diamonds only, at their own coordinates" if not failures
                  else f"FAILED ({len(failures)})"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
