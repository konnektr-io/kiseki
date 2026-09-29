#!/usr/bin/env python3
"""Rendered-browser verification for the home globe's starting point (#393).

Run against a production build of the SPA:

    cd frontend && npx tsc --noEmit && npx vite build
    backend/.venv/bin/python frontend/scripts/probe-home-start-fix.py

It loads the REAL built bundle at REAL phone width (390x844), signs the SPA in
through the E2E auth seam (`?kiseki_e2e=1` + an injected token — the backend
would enforce the token, and here the API is fulfilled locally), and drives the
browser's geolocation through Playwright's own permission + position mocking.
Chromium really answers the Geolocation API; nothing in the app is stubbed.

What it proves, in the order the feature is defined:

  1. ALREADY GRANTED — the traveler allowed location for this origin before: the
     globe asks the browser ONCE (a `getCurrentPosition`, counted by wrapping the
     real API before the bundle runs), NEVER watches, and reports that the
     camera opened on the traveler (`[data-home-start]` = `device`).
  2. NO PERMISSION — a fresh visitor (the state Niko asked not to disturb): NOTHING
     is asked at all — zero calls of either kind — the camera opens `default`,
     and the globe is otherwise exactly the app's previous behaviour.
  3. THE TRIPS STILL WIN — with the fix set in Amsterdam and the pins in Canada
     and the Dolomites, every pin still sits inside the map box at phone width:
     a starting point that displaced the pin fit would be a bug, not a feature.

WHAT THIS CANNOT COVER, stated so nobody reads green as more than it is: the
first PAINTED frame (the camera lives inside a WebGL canvas, unreadable from the
DOM — the same limit `probe-device-location.py` documents). The seam asserted
here is the component's own `data-home-start`, and the constructor's centre is
pinned by the fake map in `src/components/HomeMap.test.tsx`.

Screenshots of both states land in $KISEKI_PROBE_OUT (default
/tmp/kiseki-probe-home-start-fix) as the phone-width evidence for the PR.
"""
import json
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = (
    Path(os.environ["KISEKI_PROBE_DIST"]).resolve()
    if os.environ.get("KISEKI_PROBE_DIST")
    else Path(__file__).resolve().parent.parent / "dist"
)
CHROME = (
    "/opt/hermes/.playwright/chromium_headless_shell-1243/"
    "chrome-headless-shell-linux64/chrome-headless-shell"
)
PORT = 8824
PHONE = {"width": 390, "height": 844}
OUT = Path(os.environ.get("KISEKI_PROBE_OUT", "/tmp/kiseki-probe-home-start-fix"))

# Amsterdam — deliberately far from every pin, so "the fit still framed the
# trips" is provable from the rendered DOM: if the starting point had won, the
# Canadian and Italian pins could not both be inside the box.
FIX = {"latitude": 52.0907, "longitude": 5.1214, "accuracy": 120}

TRIPS = [
    {
        "dtId": "t-canada",
        "visibility": "private",
        "title": "Canada Heliski",
        "subtitle": "Powder",
        "stage": "booked",
        "startDate": "2027-02-01",
        "endDate": "2027-02-17",
        "slug": "canada",
        "role": "owner",
    },
    {
        "dtId": "t-dolomites",
        "visibility": "public",
        "title": "Dolomites",
        "subtitle": "",
        "stage": "planned",
        "startDate": "2027-06-01",
        "endDate": "2027-06-08",
        "slug": "dolomites",
        "role": "owner",
    },
]

GEO = {
    "trips": [
        {
            "dtId": "t-canada",
            "title": "Canada Heliski",
            "stage": "booked",
            "origin": "mine",
            "anchor": {"lat": 51.1784, "lng": -114.06, "name": "Revelstoke"},
        },
        {
            "dtId": "t-dolomites",
            "title": "Dolomites",
            "stage": "planned",
            "origin": "mine",
            "anchor": {"lat": 46.4102, "lng": 11.844, "name": "Val Gardena"},
        },
    ]
}

# Counts the app's OWN calls to the Geolocation API, installed before the bundle
# so nothing can slip past. The whole point of #393 is the NEGATIVE: a surface
# that wants a starting point must never be the reason a traveler sees a prompt,
# and a call count is the only way to see that from outside the app.
GEO_COUNTER = """
(() => {
  window.__geo = { watch: 0, current: 0, cleared: 0 };
  window.__KISEKI_ACCESS_TOKEN__ = "probe-token";
  const g = navigator.geolocation;
  if (!g) return;
  const watch = g.watchPosition.bind(g);
  g.watchPosition = function () { window.__geo.watch += 1; return watch.apply(null, arguments); };
  const current = g.getCurrentPosition.bind(g);
  g.getCurrentPosition = function () { window.__geo.current += 1; return current.apply(null, arguments); };
  const clear = g.clearWatch.bind(g);
  g.clearWatch = function () { window.__geo.cleared += 1; return clear.apply(null, arguments); };
})();
"""

# Deliver the browser's answer LATE, the way a real first fix arrives.
#
# Playwright's mocked geolocation answers in ~0 ms, which is precisely why the
# first version of #393 passed this probe while doing nothing on a real device:
# a real first fix is a network round-trip to the platform's location service
# (~1.5 s and up), and that version's 1 s window dropped it. The implementation
# here is still Chromium's own (real permission + real position); only the
# TIMING is made real — `__LATE_MS__` is how long the read takes.
LATE_FIX = """
(() => {
  const LATE = __LATE_MS__;
  const g = navigator.geolocation;
  if (!g) return;
  const current = g.getCurrentPosition.bind(g);
  // No counting here: `GEO_COUNTER` already wrapped this method, and counting
  // twice would report 2 for one question.
  g.getCurrentPosition = function (ok, err, opts) {
    // Generous browser timeout so the BROWSER does not error first: the shape
    // being tested is our own deadline, not the engine's.
    return current(function (pos) { setTimeout(() => ok(pos), LATE); }, err,
                   Object.assign({}, opts, { timeout: 60000 }));
  };
})();
"""

# A map box with no height: the state in which the pin fit cannot claim the
# camera (#368 — a padding that leaves no room), which a phone can measure while
# its sheet is still laying out. Injected at document-start so the box is already
# collapsed when the map's first frame is measured, which makes "the fit had
# nothing to say" a fact of the fixture rather than a race.
COLLAPSE_BOX = """
(() => {
  const style = document.createElement("style");
  style.textContent = "[data-home-map]{height:0 !important}";
  const add = () => document.head && document.head.appendChild(style);
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
})();
"""


class SPAHandler(SimpleHTTPRequestHandler):
    """Static files + SPA history fallback (mirrors the FastAPI catch-all)."""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def log_message(self, *a):  # quiet
        pass

    def send_head(self):
        if not Path(self.translate_path(self.path)).is_file() and not self.path.startswith("/api/"):
            self.path = "/index.html"
        return super().send_head()


class Probe:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def check(self, ok: bool, what: str, detail: str = "") -> bool:
        print(f"  {'OK  ' if ok else 'FAIL'} {what}{f' — {detail}' if detail else ''}")
        if not ok:
            self.failures.append(what)
        return ok

    def shot(self, page, name: str) -> None:
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f"{name}.png"))

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def dismiss_consent(page) -> None:
        """Decline analytics on a first load: the banner sits over the sheet and
        makes the screenshots useless as evidence, and declining is the state a
        fresh visitor starts in — so the run also shows the map with analytics
        OFF (no coordinate can leak into an SDK that never initialized)."""
        decline = page.locator('button:has-text("No thanks")')
        if decline.count():
            decline.first.click()
            page.wait_for_timeout(300)

    @staticmethod
    def geo_calls(page) -> dict:
        return page.evaluate("window.__geo")

    @staticmethod
    def start_attr(page):
        return page.evaluate(
            "(() => { const el = document.querySelector('[data-home-map]');"
            " return el ? el.getAttribute('data-home-start') : null; })()"
        )

    @staticmethod
    def map_state(page):
        return page.evaluate(
            "(() => { const el = document.querySelector('[data-home-map]');"
            " return el ? el.getAttribute('data-home-map') : null; })()"
        )

    @staticmethod
    def pins(page) -> list[dict]:
        """Every trip pin's box — the trip's own framing evidence."""
        return page.evaluate(
            """(() => Array.from(document.querySelectorAll('[data-pin]')).map((el) => {
                 const r = el.getBoundingClientRect();
                 return { id: el.getAttribute('data-pin'), cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height };
               }))()"""
        )

    @staticmethod
    def labels(page) -> int:
        return page.evaluate("document.querySelectorAll('[data-home-label]').length")

    @staticmethod
    def map_box(page):
        return page.evaluate(
            """(() => {
                 const el = document.querySelector('[data-home-map]');
                 if (!el) return null;
                 const r = el.getBoundingClientRect();
                 return { x: r.x, y: r.y, w: r.width, h: r.height };
               })()"""
        )

    @staticmethod
    def inside(box, element, margin: float = 2.0) -> bool:
        if box is None or element is None:
            return False
        return (
            element["cx"] >= box["x"] - margin
            and element["cx"] <= box["x"] + box["w"] + margin
            and element["cy"] >= box["y"] - margin
            and element["cy"] <= box["y"] + box["h"] + margin
        )

    def wait_for_map(self, page) -> bool:
        """The map is up when a pin is on screen (the canvas itself is opaque)."""
        for _ in range(40):
            if page.locator("[data-home-map]").count() and page.locator("[data-pin]").count():
                page.wait_for_timeout(2500)  # let tiles + the camera settle
                return True
            page.wait_for_timeout(250)
        return False

    # ------------------------------------------------------------------- runs
    def run(self) -> int:
        from playwright.sync_api import sync_playwright

        if not (DIST / "index.html").is_file():
            print(f"!! no built SPA at {DIST} — build it first")
            return 2

        server = ThreadingHTTPServer(("127.0.0.1", PORT), SPAHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        host = f"http://127.0.0.1:{PORT}"

        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])

            def api(route):
                """One handler for the whole API, so the fixture never depends on
                Playwright's route precedence (registered last wins): the shapes
                the home page reads are spelled out, everything else is `{}`."""
                url = route.request.url
                if url.endswith("/api/trips/geo"):
                    body = GEO
                elif url.endswith("/api/trips"):
                    body = {"trips": TRIPS}
                elif "/api/showcase" in url:
                    body = {"trips": []}
                elif "/api/feed" in url:
                    body = {"items": []}
                else:
                    body = {}
                route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

            def context(late_ms: int = 0, collapse: bool = False, **kwargs):
                ctx = browser.new_context(viewport=PHONE, **kwargs)
                ctx.add_init_script(GEO_COUNTER)
                if collapse:
                    ctx.add_init_script(COLLAPSE_BOX)
                if late_ms:
                    ctx.add_init_script(LATE_FIX.replace("__LATE_MS__", str(late_ms)))
                ctx.route(re.compile(r".*/api/.*$"), api)
                return ctx

            # ------------------------------------- 1. permission already granted
            print("phase 1 — permission already granted: the globe opens on the traveler")
            ctx = context(permissions=["geolocation"], geolocation=FIX)
            page = ctx.new_page()
            page.goto(f"{host}/?kiseki_e2e=1", wait_until="networkidle")
            up = self.wait_for_map(page)
            self.dismiss_consent(page)
            self.check(up, "the home globe mounted with its pins")
            self.check(
                self.map_state(page) == "ready",
                "the map reached `ready` (the canvas is not the placeholder)",
                str(self.map_state(page)),
            )
            calls = self.geo_calls(page)
            self.check(
                calls["current"] >= 1,
                "an already-granted permission asks the browser once",
                f"getCurrentPosition={calls['current']}",
            )
            self.check(
                calls["watch"] == 0,
                "the home globe never starts a tracked session",
                f"watchPosition={calls['watch']}",
            )
            self.check(
                self.start_attr(page) == "device",
                "the camera opened on the traveler, not null island",
                str(self.start_attr(page)),
            )
            box = self.map_box(page)
            pins = self.pins(page)
            self.check(len(pins) == 2, "both trip pins are on the canvas", f"{len(pins)} pins")
            self.check(
                all(self.inside(box, pin) for pin in pins),
                "the pin fit still owns the camera — every pin is inside the box",
                json.dumps([pin["id"] for pin in pins]),
            )
            self.check(
                self.labels(page) >= 1,
                "the trip labels rode the same rebuild",
                f"{self.labels(page)} labels",
            )
            self.shot(page, "01-granted-opens-on-traveler")
            ctx.close()

            # -------------------------------------------- 2. a fresh visitor
            print("phase 2 — no permission: nothing is asked at all")
            ctx = context(geolocation=FIX)  # position available, permission NOT granted
            page = ctx.new_page()
            page.goto(f"{host}/?kiseki_e2e=1", wait_until="networkidle")
            up = self.wait_for_map(page)
            self.dismiss_consent(page)
            self.check(up, "the home globe mounted with its pins")
            calls = self.geo_calls(page)
            self.check(
                calls["current"] == 0 and calls["watch"] == 0,
                "the app asks for NOTHING without a granted permission",
                f"watch={calls['watch']} getCurrentPosition={calls['current']}",
            )
            self.check(
                self.start_attr(page) == "default",
                "the camera opens as it always did (MapLibre's own default)",
                str(self.start_attr(page)),
            )
            box = self.map_box(page)
            pins = self.pins(page)
            self.check(
                len(pins) == 2 and all(self.inside(box, pin) for pin in pins),
                "the globe still frames the trips — no regression for a fresh visitor",
                json.dumps([pin["id"] for pin in pins]),
            )
            self.shot(page, "02-no-permission-unchanged")
            ctx.close()

            # ------------- 3. a fix that takes a REAL device's time to arrive
            print("phase 3 — the fix arrives as late as a real first fix does")
            # The box is collapsed so the pin fit has nothing to claim (the #368
            # shape: no room), which is the state a phone can be in while its
            # sheet lays out and the ONLY state where the starting point decides
            # the camera. The read takes 3 s: well past the 1 s window that
            # shipped in v0.95.0 and dropped it, turning the globe back into
            # null island for every traveler without a cached fix.
            ctx = context(permissions=["geolocation"], geolocation=FIX, late_ms=3000, collapse=True)
            page = ctx.new_page()
            page.goto(f"{host}/?kiseki_e2e=1", wait_until="networkidle")
            up = self.wait_for_map(page)
            self.dismiss_consent(page)
            self.check(up, "the home globe mounted with its pins")
            # The canvas is up while the read is still in flight: the first paint
            # never waits for the network.
            self.check(
                self.start_attr(page) in ("default", "device", "device-fallback"),
                "the map is up before the fix arrives (the paint does not wait)",
                str(self.start_attr(page)),
            )
            page.wait_for_timeout(4000)  # let the 3 s read land
            calls = self.geo_calls(page)
            self.check(
                calls["current"] == 1 and calls["watch"] == 0,
                "still one question, still no tracked session",
                f"getCurrentPosition={calls['current']} watch={calls['watch']}",
            )
            self.check(
                self.start_attr(page) == "device-fallback",
                "the late fix STILL takes the camera instead of null island",
                str(self.start_attr(page)),
            )
            self.shot(page, "03-late-fix-still-lands")
            ctx.close()

            browser.close()

        print()
        if self.failures:
            print(f"FAILED — {len(self.failures)} check(s):")
            for f in self.failures:
                print(f"  - {f}")
            return 1
        print(f"PASSED — screenshots in {OUT}")
        return 0


if __name__ == "__main__":
    raise SystemExit(Probe().run())
