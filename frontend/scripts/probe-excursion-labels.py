#!/usr/bin/env python3
"""
#388 follow-up — the itinerary map's excursion diamonds must say what they are.

Niko's report (2026-10-03): the itinerary view's activity diamonds navigate
correctly on tap but carry no text, so the whole-trip scan reads as five
numbered pins and a heap of anonymous lozenges. He wants them labelled, "maybe
only when zooming in or clicking them", with the numbered locations and their
labels staying more prominent.

What only a browser can prove here — and what vitest cannot:

1. **The labels exist at all.** The layer is built inside a MapLibre `Marker`,
   whose element is created in an effect against a live WebGL map. jsdom has
   no map, so `buildExcursionLabels` never runs in a unit test. The DOM
   selector `.map-place-label.is-excursion` returning anything is the only
   proof that the feature shipped.
2. **No two venue pills ever overlap.** A first attempt gated the layer on a
   global zoom floor (`EXCURSION_LABEL_ZOOM_FLOOR`), and THIS PROBE is what
   killed it: the map skill warns that a floor taken from a library constant
   instead of a measurement is worse than none. Fitting Canada's real registry
   gives z6 for the journey framing and z≈13 to separate one town, so no single
   constant is right. The shipped rule measures each label's actual screen
   position instead, so the invariant to assert is geometric — assert it
   directly from `getBoundingClientRect()` at every camera, which is what
   `pairs` collects.
3. **The spine stays dominant.** The numbered labels are the map's index; the
   ask explicitly required them to keep priority. The probe asserts both are
   on screen at once AND that the venue cap stays below the numbered layer's.
4. **A tapped diamond is named whenever the separation rule would have
   dropped it** — the "or clicking them" half, and the case most likely to
   regress silently. The tap is measured at the journey camera, where five
   venues overlap; the tapped one must still be named.

The fixture is the shared probe trip plus a venue cluster in Revelstoke — the
shape that produced the original #388 bug (six venues within ~4 px of a stop),
and the reason a cap and a separation rule exist at all.

Run:  backend/.venv/bin/python scripts/probe-excursion-labels.py
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
# Artifact override so the SAME case can be run against the pre-fix build: a
# probe that has never failed proves nothing. Point KISEKI_PROBE_DIST at main's
# `dist` and every label assertion must go red, which is what makes the green
# above mean anything.
DIST = Path(os.environ.get("KISEKI_PROBE_DIST") or (FRONTEND / "dist"))
TRIP_ID = "b16680e7-a338-4c76-9cd7-fa13d45be594"
LABEL_MAX = 4                    # EXCURSION_LABEL_MAX in lib/maps.ts
MIN_SEPARATION_PX = 92           # EXCURSION_LABEL_MIN_SEPARATION_PX in lib/maps.ts

# The trip fixture + the chromium path live in probe-map-source-crash.py; reuse
# them rather than keeping a second copy that can drift.
_spec = importlib.util.spec_from_file_location(
    "probe_source", FRONTEND / "scripts" / "probe-map-source-crash.py"
)
if _spec is None or _spec.loader is None:
    raise SystemExit("probe-map-source-crash.py not found next to this script")
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

# Canada's real registry spans 4.19 deg of longitude (YYC -> Revelstoke), and
# the shared probe trip only 1.2 — which is why its journey fit lands at z6.1
# and never exercises a dense-venue gate at all. Widening the fixture to the
# real spread is what puts the camera where a real trip's camera sits.
WIDE_STOPS = [
    ("loc-c1", "Calgary", 51.1215, -114.0079, 1),
    ("loc-c2", "Banff", 51.1784, -115.5708, 4),
    ("loc-c3", "Lake Louise", 51.4254, -116.1773, 5),
    ("loc-c4", "Golden", 51.2920, -116.9656, 6),
    ("loc-c5", "Rogers Pass", 51.3019, -117.5167, 7),
    ("loc-c6", "Revelstoke", 50.9981, -118.1957, 2),
]

ROUTE_LEGS = {"legs": [{
    "from": "Revelstoke", "to": "Rogers Pass", "road": True,
    "duration": "30 mins", "distance": "35 km",
    "geometry": {"type": "LineString",
                 "coordinates": [[-118.20, 51.00], [-118.10, 51.02], [-117.85, 51.05]]}}]}

# A venue cluster ON a stop: `placeRole` calls a place a stop only if a section
# refs it or a transport endpoint names it, so a meal block's `location` alone
# makes these excursions (#91). The numbered stops stay the spine.
#
# The spread matters and is not arbitrary. #388 reported six Revelstoke venues
# inside ~4 px of each other at journey zoom; a realistic town cluster is about
# 1 km across, which needs z14 before four 90px pills separate. A first fixture
# squeezed them into 567 m, and the probe then (correctly) refused to call the
# layer camera-driven — at that spread nothing could separate. Real spread here:
VENUES = [
    ("loc-v1", "Rockford Bar & Grill", 51.00097, -118.19313),
    ("loc-v2", "The Village Idiot", 50.99576, -118.19841),
    ("loc-v3", "Minyuk Coffee Co", 50.99918, -118.20041),
    ("loc-v4", "Abe's Cafe", 50.99442, -118.19227),
    ("loc-v5", "Selkirk Cafe", 51.00241, -118.19741),
]
TAP = "Rockford Bar & Grill"


def fixture():
    """Canada's real six stops + a five-venue cluster in Revelstoke.

    `placeRole` calls a place a stop only if a section refs it or a transport
    endpoint names it, so a meal block's `location` alone makes the venues
    excursions (#91). The numbered stops stay the spine.
    """
    trip = json.loads(json.dumps(probe.TRIP))
    trip["locations"] = [
        {"id": i, "name": n, "lat": la, "lng": ln, "marker": mk, "alias": []}
        for i, n, la, ln, mk in WIDE_STOPS
    ] + [
        {"id": i, "name": n, "lat": la, "lng": ln, "alias": []} for i, n, la, ln in VENUES
    ]
    # Every WIDE_STOP is a section base / transport endpoint in the shared trip
    # only for the original five; name the extra ones explicitly so the chain
    # is the six stops and the venues are genuinely excursions.
    trip["sections"] = [{"id": "s-0", "title": "The week", "order": 0,
                         "days": [0, 4],
                         "locationRefs": [n for _, n, _, _, _ in WIDE_STOPS],
                         "body": "The whole trip."}]
    trip["days"][0]["blocks"] = trip["days"][0]["blocks"] + [
        {"id": f"m-{i}", "kind": "meal", "title": f"Dinner — {n}", "location": n, "status": "booked"}
        for i, n, _, _ in VENUES
    ]
    return trip


TRIP = fixture()

# One handler, branching inside: Playwright matches routes newest-first, so a
# catch-all registered after this one would swallow every fixture.
READ = """() => {
  const box = document.querySelector('.map-pin-scaled');
  const b = box ? box.getBoundingClientRect() : null;
  const labels = [...document.querySelectorAll('.map-place-label.is-excursion')];
  const spine = [...document.querySelectorAll('.map-place-label:not(.is-excursion):not(.is-chip)')];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
  };
  const shown = labels.filter(vis);
  const rect = (el) => el.getBoundingClientRect();
  const centre = (r) => [r.x + r.width / 2, r.y + r.height / 2];

  // Every pair of visible venue pills by centre distance. This is the invariant
  // the layer promises, read from the DOM rather than inferred from a cap.
  const pairs = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const [ax, ay] = centre(rect(shown[i]));
      const [bx, by] = centre(rect(shown[j]));
      pairs.push([shown[i].textContent.trim(), shown[j].textContent.trim(),
                  Math.hypot(ax - bx, ay - by)]);
    }
  }

  // Containment, measured for BOTH layers so the assertion can be comparative
  // (MapLibre leaves off-screen markers in the DOM; the map container clips
  // them, which the pre-existing numbered labels rely on just as much).
  const outside = (els) => els.filter(vis).filter((el) => {
    const r = rect(el);
    return !b || r.right < b.left || r.left > b.right || r.bottom < b.top || r.top > b.bottom;
  }).length;

  return {
    zoom: box ? parseFloat(box.dataset.mapZoom || 'NaN') : null,
    excursion: shown.map((el) => el.textContent.trim()),
    selectedExcursion: labels.filter((el) => el.classList.contains('is-selected'))
                             .map((el) => el.textContent.trim()),
    spineVisible: spine.filter(vis).length,
    spineTotal: spine.length,
    spineOutsideBox: outside(spine),
    diamonds: document.querySelectorAll('.route-pin-excursion').length,
    pairs,
    labelsOutsideBox: outside(labels),
    labelsInStrip: b
      ? shown.filter((el) => {
          const r = rect(el);
          return r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom;
        }).length
      : 0,
  };
}"""


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
        log(f"FAIL: {DIST} missing — run `vite build` first")
        return 2
    log(f"dist under test: {DIST}")

    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    out = Path("/opt/data/cache/kiseki-probe-excursion-labels")
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
                route.fulfill(status=200, content_type="application/json", body=json.dumps(TRIP))
            elif "/api/maps/route/" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(ROUTE_LEGS))
            else:
                route.fulfill(status=404, content_type="application/json", body="{}")

        ctx.route("**/api/**", handle)
        # Consent declined BEFORE anything runs: this probe must not write
        # events into the real PostHog project.
        ctx.add_init_script("try{localStorage.setItem('kiseki_consent','declined')}catch(e){}")

        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        log("→ itinerary, journey-fit framing")
        page.goto(f"{base}/t/{TRIP_ID}/itinerary", wait_until="load")
        page.wait_for_selector(".map-pin-scaled", timeout=30000)
        # Wait for the MARKERS, not the container: `.map-pin-scaled` mounts with
        # the map instance and the level build adds pins after the style loads,
        # so a fixed settle read it too early and reported "0 diamonds" — a
        # flake that reads exactly like the feature being absent. The marker DOM
        # is the honest readiness signal.
        page.wait_for_selector(".route-pin", timeout=30000)
        page.wait_for_timeout(4000)
        wide = page.evaluate(READ)
        log(f"   zoom {wide['zoom']}: {wide['diamonds']} diamonds, "
            f"{len(wide['excursion'])} venue labels, {wide['spineVisible']} numbered labels")
        page.screenshot(path=str(out / "1-journey.png"))

        log(f"→ tap the '{TAP}' diamond at that zoom")
        tapped = page.evaluate(
            """(name) => {
              const el = document.querySelector('.route-pin-excursion[data-place="' + name + '"]');
              if (!el) return false;
              el.click();
              return true;
            }""",
            TAP,
        )
        page.wait_for_timeout(2500)
        after_tap = page.evaluate(READ)
        log(f"   zoom {after_tap['zoom']}: labels {after_tap['excursion']}, "
            f"selected {after_tap['selectedExcursion']}")
        page.screenshot(path=str(out / "2-tapped-diamond.png"))

        log("→ zoom in until the town separates")
        # The map's OWN zoom-in control, not a synthetic gesture: the control is
        # the reachable path for anyone who cannot pinch, and clicking it moves
        # the camera one whole level each time so the count can be sampled
        # between steps. (A `page.keyboard.press("Equal")` does nothing here —
        # MapLibre binds zoom keys to the canvas, and the tap had already moved
        # focus to the tapped marker.)
        seen = {zoom_snap["zoom"]: len(zoom_snap["excursion"]) for zoom_snap in (after_tap,)}
        # z15 is where a 1.05 km cluster resolves four pills (measured: z13 leaves
        # it at 88px, one short of the 92px a pill needs). Zoom from wherever the
        # tap left the camera, so the count is sampled along a real approach.
        for _ in range(14):
            page.click(".maplibregl-ctrl-zoom-in", force=True)
            page.wait_for_timeout(700)
            snap = page.evaluate(READ)
            seen[snap["zoom"]] = len(snap["excursion"])
            if snap["zoom"] >= 15:
                break
        page.wait_for_timeout(2500)
        # Bring the cluster into the unoccluded strip, by CONVERGING rather than
        # guessing a drag: a fixed offset pushes the map the wrong way half the
        # time (measured — a +60/-40 drag left every label at x≈450–908 on a
        # 390px viewport, and the label placement was innocent). Dragging the
        # map by the map-box-centre→cluster-centre error walks the cluster in,
        # which is the view a traveler has after zooming into a town.
        for _ in range(6):
            err = page.evaluate("""() => {
              const box = document.querySelector('.map-pin-scaled');
              const b = box.getBoundingClientRect();
              const ds = [...document.querySelectorAll('.route-pin-excursion')]
                .map((el) => el.getBoundingClientRect());
              if (!ds.length) return null;
              const cx = ds.reduce((a, r) => a + r.x + r.width / 2, 0) / ds.length;
              const cy = ds.reduce((a, r) => a + r.y + r.height / 2, 0) / ds.length;
              return { dx: b.left + b.width / 2 - cx, dy: b.top + b.height / 2 - cy };
            }""")
            if not err or (abs(err["dx"]) < 30 and abs(err["dy"]) < 30):
                break
            page.mouse.move(195, 250)
            page.mouse.down()
            page.mouse.move(195 + err["dx"], 250 + err["dy"], steps=15)
            page.mouse.up()
            page.wait_for_timeout(1500)
        log(f"   label count by zoom: {dict(sorted(seen.items(), reverse=True))}")
        zoomed = page.evaluate(READ)
        log(f"   zoom {zoomed['zoom']}: {len(zoomed['excursion'])} venue labels, "
            f"{zoomed['spineVisible']} numbered labels")
        page.screenshot(path=str(out / "3-zoomed-in.png"))

        log("→ day level (must NOT inherit the excursion label layer)")
        page.goto(f"{base}/t/{TRIP_ID}/day/0", wait_until="load")
        page.wait_for_selector(".route-pin", timeout=30000)
        page.wait_for_timeout(3500)
        day_level = page.evaluate(READ)
        chips = page.evaluate("() => document.querySelectorAll('.route-chip').length")
        log(f"   day level: {len(day_level['excursion'])} excursion labels, "
            f"{day_level['diamonds']} diamonds, {day_level['spineVisible']} numbered, "
            f"{chips} letter chips")
        page.screenshot(path=str(out / "4-day-level.png"))

        canvas = page.evaluate("!!document.querySelector('.map-pin-scaled canvas')")
        browser.close()
    httpd.shutdown()

    # How many names the layer could show at each camera, sorted by zoom.
    curve = dict(sorted(seen.items(), reverse=True))
    peak = max(curve.values()) if curve else 0

    log(f"\nlabel count by zoom (camera → names): {curve}")
    log(f"zooms measured (wide / tap / zoomed): "
        f"{wide['zoom']} / {after_tap['zoom']} / {zoomed['zoom']}")
    log(f"excursion diamonds in DOM            : {wide['diamonds']}")
    log(f"venue labels at journey zoom         : {wide['excursion'] or 'none'}")
    log(f"venue labels after tapping a diamond : {after_tap['excursion'] or 'none'}")
    log(f"venue labels after zooming in        : {zoomed['excursion'] or 'none'}")
    log(f"numbered spine labels when zoomed    : {zoomed['spineVisible']}")
    log(f"venue labels inside the map box      : {zoomed['labelsInStrip']}/{len(zoomed['excursion'])}")
    log(f"labels off-map (venues / numbered)   : "
        f"{zoomed['labelsOutsideBox']}/{len(zoomed['excursion'])} vs "
        f"{zoomed['spineOutsideBox']}/{zoomed['spineTotal']}")
    log(f"page errors                          : {errors[:3] or 'none'}")
    log(f"shots: {out}")

    # 1. The diamonds must EXIST, or there is nothing to label.
    if wide["diamonds"] < len(VENUES):
        failures.append(f"expected {len(VENUES)} excursion diamonds, found {wide['diamonds']}")

    # 2. THE MEASURED GATE. Two diamonds may be labelled together only if their
    #    pills clear each other, so assert the invariant directly from the DOM
    #    geometry instead of trusting the cap: no two visible venue labels may
    #    sit closer than one pill's width. This is the property the zoom floor
    #    was supposed to provide, and it must hold at EVERY camera.
    def too_close(pairs):
        return [(a, b, round(d)) for a, b, d in pairs if d < MIN_SEPARATION_PX]
    for label, snap in (("journey", wide), ("after tap", after_tap), ("zoomed", zoomed)):
        near = too_close(snap["pairs"])
        if near:
            failures.append(f"{label} view: {len(near)} venue label pair(s) overlap "
                            f"(closer than {MIN_SEPARATION_PX}px): {near[:2]}")

    # 3. Tapping a diamond names it — whatever the separation rule decided.
    if not tapped:
        failures.append(f"could not tap the '{TAP}' diamond")
    elif TAP not in after_tap["excursion"]:
        failures.append(f"the tapped diamond is not labelled although it was "
                        f"tapped (got {after_tap['excursion']})")
    elif TAP not in after_tap["selectedExcursion"]:
        failures.append("the tapped diamond's label is not marked selected")

    # 4. Zooming in REVEALS more names, with no tap involved: the gate is
    #    screen separation, so the count can only rise as the camera closes on
    #    the cluster. This is the "when zooming in" half of the ask, asserted
    #    as a direction of travel rather than a zoom constant.
    if zoomed["zoom"] is not None and wide["zoom"] is not None:
        if zoomed["zoom"] > wide["zoom"] and len(zoomed["excursion"]) < len(after_tap["excursion"]):
            failures.append(f"zooming in ({wide['zoom']} -> {zoomed['zoom']}) did not reveal "
                            f"more venue names ({len(wide['excursion'])} -> "
                            f"{len(zoomed['excursion'])})")
    if not zoomed["excursion"]:
        failures.append("no venue labels after zooming in — the layer never appears")
    # The curve is the honest evidence for "when zooming in": zooming toward the
    # town must never REMOVE a name, and the deep camera must resolve more of
    # the cluster than the journey camera could.
    # `curve` is sorted DEEPEST first, so `deep` is the closer camera and
    # `shallow` the wider one: zooming OUT must never reveal a name. Walking it
    # the other way round flagged the layer's own reveal curve as a regression.
    steps = list(zip(list(curve)[:-1], list(curve)[1:]))
    regressions = [(d, s) for d, s in steps if curve[s] > curve[d]]
    if regressions:
        failures.append(
            "zooming out revealed names (the layer should only reveal on the way in): "
            + str([(d, curve[d], s, curve[s]) for d, s in regressions])
        )
    if peak <= len(wide["excursion"]) and len(curve) > 2:
        failures.append(f"zooming from {min(curve)} to {max(curve)} never revealed a new "
                        f"name (peak {peak}, journey {len(wide['excursion'])}) — "
                        "the labels are not answering the camera")

    # 5. THE PROMINENCE CONSTRAINT, which the ask made explicit.
    if zoomed["spineVisible"] == 0:
        failures.append("the numbered place labels vanished — the spine lost")
    if len(zoomed["excursion"]) > LABEL_MAX:
        failures.append(f"{len(zoomed['excursion'])} venue labels — over the cap of {LABEL_MAX}")
    if len(zoomed["excursion"]) > zoomed["spineVisible"]:
        failures.append(f"{len(zoomed['excursion'])} venue labels vs "
                        f"{zoomed['spineVisible']} numbered — the diamonds outnumber the spine")

    # 6. COMPARATIVE containment, not absolute. The first version of this
    #    assertion demanded every venue label sit inside the map rect, and it
    #    failed — then measurement showed the PRE-EXISTING numbered labels do
    #    exactly the same (5 of 6 outside the same rect on the same view),
    #    because MapLibre leaves off-screen markers in the DOM and the map's
    #    own container clips them. So "inside the box" was never the app's
    #    contract and asserting it would have invented one. The honest
    #    invariant is comparative: the new layer must not paint off-map more
    #    than the vocabulary it joins.
    if zoomed["labelsOutsideBox"] > zoomed["spineOutsideBox"]:
        failures.append(
            f"{zoomed['labelsOutsideBox']}/{len(zoomed['excursion'])} venue labels fall "
            f"outside the map rect vs {zoomed['spineOutsideBox']}/{zoomed['spineTotal']} "
            "numbered labels — the new layer is worse than the vocabulary it joins"
        )

    # 7. SCOPE. The ask was about the itinerary view. The day level already
    #    speaks for itself through letter chips + chip labels (#361), so venue
    #    labels there would be a second vocabulary for one marker.
    if day_level["excursion"]:
        failures.append(f"{len(day_level['excursion'])} excursion labels leaked onto the "
                        f"day level: {day_level['excursion']}")

    if errors:
        failures.append(f"page errors: {errors[:2]}")
    if not canvas:
        failures.append("no map canvas — the map did not mount")

    for f in failures:
        log(f"FAIL: {f}")
    print("\n" + ("PASS — diamonds name themselves, spine stays dominant" if not failures
                  else f"FAILED ({len(failures)})"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
