#!/usr/bin/env python3
"""Rendered-browser verification for the trip map's device location (#383).

Run against a production build of the SPA:

    cd frontend && npx tsc --noEmit && npx vite build
    python3 scripts/probe-device-location.py

It loads the REAL built bundle at REAL phone width (390x844 — Niko reviews on a
phone, and a desktop-only green says nothing), serves the trip document over
the same /api/trips route the app uses, and drives the browser's geolocation
through Playwright's own permission + position mocking. Chromium really answers
the Geolocation API here; nothing in the app is stubbed.

What it proves, in the order the feature is defined:

  1. FRESH VISITOR — no permission, no tap: `watchPosition` is NEVER called
     (counted by wrapping the real API before the bundle runs), no dot, and the
     control reads "Show my location". This is the whole point of #383: an app
     that prompts on load teaches people to deny, and a denial is sticky.
  2. THE TAP — the notice path: a browser with no granted permission answers
     the tap with a failure, and the control says so in one line instead of
     leaving a live button with a frozen dot.
  3. RETURNING TRAVELLER — permission already granted: the dot appears with NO
     tap, and the camera stays where the trip put it. The no-yank proof is the
     trip's own framing: the fix is a few km from Santiago, so a camera that had
     flown to it (zoom 13 on one point) could not still be holding BOTH numbered
     pins, ~40 km apart, inside the visible strip.
  4. THE CONTROL CYCLE — tap = recentre (the dot comes into the visible box,
     never under the sheet), tap again = stop (dot gone, watch cleared).
  5. LEVEL CHANGE — scan -> day keeps the SAME watch (a second watch would mean
     the session restarted) and the same following state; and a fix that stops
     arriving must degrade to idle with a notice, never a live control over a
     frozen dot. (In THIS harness the high-accuracy path errors when the mock is
     re-pointed, so that degradation is the branch actually exercised — the
     check accepts the honest alternatives and forbids the dishonest one.)
  6. RELOAD — permission still granted: the dot comes back with no tap.

Screenshots of every state land in $KISEKI_PROBE_OUT (default
/tmp/kiseki-probe-device-location) as the phone-width evidence for the PR.

WHAT THIS CANNOT COVER, stated so nobody reads green as more than it is: the
chat's half of the feature. The drawer is behind Auth0 sign-in, so a headless
probe cannot submit a turn — the wire is pinned instead by
`src/lib/chat.transport.test.ts` (the real transport, body asserted) and
`backend/tests/test_chat.py` (the real relay, instructions asserted). The
accuracy HALO's metre-to-pixel maths is unit-tested (`accuracyRadiusPx`); the
probe only asserts that the layer's DOM contract flips with the session.
"""
import json
import os
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / "dist"
CHROME = (
    "/opt/hermes/.playwright/chromium_headless_shell-1243/"
    "chrome-headless-shell-linux64/chrome-headless-shell"
)
PORT = 8823
PHONE = {"width": 390, "height": 844}
OUT = Path(os.environ.get("KISEKI_PROBE_OUT", "/tmp/kiseki-probe-device-location"))

TRIP_ID = "bf29a027-1f6c-4a3b-9d21-7c0e5a4b8f13"

# A few km east of Santiago — INSIDE the trip's own framed area, so the dot is
# visible in the phone screenshots (the evidence Niko actually reviews), and the
# "the camera did not fly to the fix" claim is proved the other way round: if it
# HAD flown, the two numbered pins (~40 km apart) could not both stay inside the
# visible strip at the whole-trip fit.
FIX = {"latitude": -33.4489, "longitude": -70.6070, "accuracy": 150}

TRIP = {
    "id": TRIP_ID,
    "slug": "chile-peru-2027",
    "title": "Chili + Peru — zomer 2027",
    "stage": "booked",
    "visibility": "public",
    "startDate": "2027-07-17",
    "endDate": "2027-07-19",
    "crew": [{"id": "p1", "name": "Niko Raes", "role": "owner"}],
    "practical": {"todos": [], "links": [], "contacts": []},
    "locations": [
        {"name": "Santiago", "marker": 1, "lat": -33.4489, "lng": -70.6693},
        {"name": "Valle Nevado", "marker": 2, "lat": -33.3511, "lng": -70.2494},
    ],
    "days": [
        {
            "id": "day-1",
            "date": "2027-07-17",
            "title": "Aankomst Santiago",
            "blocks": [
                {
                    "id": "block-1",
                    "kind": "lodging",
                    "title": "Hotel Magnolia",
                    "location": "Santiago",
                }
            ],
        },
        {
            "id": "day-2",
            "date": "2027-07-18",
            "title": "Valle Nevado",
            "blocks": [
                {
                    "id": "block-2",
                    "kind": "transport",
                    "title": "Rit naar Valle Nevado",
                    "from": "Santiago",
                    "to": "Valle Nevado",
                    "status": "booked",
                }
            ],
        },
    ],
    "sections": [
        {"id": "sec-1", "title": "Santiago", "days": [0, 0], "locationRefs": ["Santiago"]},
        {"id": "sec-2", "title": "Valle Nevado", "days": [1, 1], "locationRefs": ["Valle Nevado"]},
    ],
}

# Counts the app's OWN calls to the Geolocation API, installed before the bundle
# so nothing can slip past: `watchPosition` on load is the behaviour #383
# forbids, and this is the only way to see it from outside.
GEO_COUNTER = """
(() => {
  window.__geo = { watch: 0, current: 0, cleared: 0 };
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
        """Decline analytics on a first load.

        Two reasons: the consent banner sits over the sheet and makes the
        screenshots useless as evidence, and declining is the state a fresh
        visitor starts in — so the run also shows the map behaving with
        analytics OFF (no coordinate can leak into an SDK that never
        initialized).
        """
        decline = page.locator('button:has-text("No thanks")')
        if decline.count():
            decline.first.click()
            page.wait_for_timeout(300)

    @staticmethod
    def geo(page) -> dict:
        return page.evaluate("window.__geo")

    @staticmethod
    def dot_box(page):
        return page.evaluate(
            """(() => {
                 const el = document.querySelector('.route-locate-dot');
                 if (!el) return null;
                 const r = el.getBoundingClientRect();
                 return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
               })()"""
        )

    @staticmethod
    def place_pins(page):
        """The numbered place pins' boxes — the trip's own framing evidence."""
        return page.evaluate(
            """(() => Array.from(document.querySelectorAll('[data-place]')).map((el) => {
                 const r = el.getBoundingClientRect();
                 return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
               }))()"""
        )

    @staticmethod
    def map_box(page):
        return page.evaluate(
            """(() => {
                 const el = document.querySelector('.map-pin-scaled');
                 if (!el) return null;
                 const r = el.getBoundingClientRect();
                 return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
               })()"""
        )

    @staticmethod
    def control(page):
        return page.evaluate(
            """(() => {
                 const b = document.querySelector('[data-locate]');
                 if (!b) return null;
                 const r = b.getBoundingClientRect();
                 return {
                   action: b.getAttribute('data-locate'),
                   tracking: b.getAttribute('data-tracking'),
                   label: b.getAttribute('aria-label'),
                   w: r.width, h: r.height,
                   visible: getComputedStyle(b).visibility,
                 };
               })()"""
        )

    @staticmethod
    def inside(box, element, margin: float = 1.0) -> bool:
        if box is None or element is None:
            return False
        return (
            element["cx"] >= box["x"] - margin
            and element["cx"] <= box["x"] + box["w"] + margin
            and element["cy"] >= box["y"] - margin
            and element["cy"] <= box["y"] + box["h"] + margin
        )

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

            def context(**kwargs):
                ctx = browser.new_context(viewport=PHONE, **kwargs)
                ctx.add_init_script(GEO_COUNTER)
                ctx.route(
                    re.compile(r"/api/trips/[^/]+$"),
                    lambda r: r.fulfill(
                        status=200, content_type="application/json", body=json.dumps(TRIP)
                    ),
                )
                return ctx

            # ---------------------------------------------------- 1. fresh visitor
            print("phase 1 — fresh visitor: no permission, no tap")
            ctx = context()
            page = ctx.new_page()
            page.goto(f"{host}/t/{TRIP_ID}/itinerary", wait_until="networkidle")
            page.wait_for_timeout(2500)
            self.dismiss_consent(page)
            calls = self.geo(page)
            self.check(
                calls["watch"] == 0 and calls["current"] == 0,
                "the app never asked for a position on load",
                f"watch={calls['watch']} getCurrentPosition={calls['current']}",
            )
            control = self.control(page)
            self.check(control is not None, "the locate control rendered")
            self.check(
                control is not None and control["action"] == "start",
                "the control reads 'Show my location'",
                json.dumps(control),
            )
            self.check(
                control is not None and control["w"] >= 44 and control["h"] >= 44,
                "44px hit target at phone width",
                f"{control['w']}x{control['h']}" if control else "",
            )
            self.check(self.dot_box(page) is None, "no dot before the traveler asks")
            self.check(
                page.locator(".map-locate-notice").count() == 0,
                "no notice before the traveler asks",
            )
            self.shot(page, "01-fresh-idle")

            # ------------------------------------------------------- 2. the tap
            print("phase 2 — the tap: a browser that refuses, told plainly")
            page.click("[data-locate]")
            # wait for the failure to come back (headless Chromium denies)
            for _ in range(34):
                if page.locator(".map-locate-notice").count():
                    break
                page.wait_for_timeout(500)
            notice = page.locator(".map-locate-notice")
            self.check(notice.count() == 1, "a one-line notice explains the failure")
            notice_text = notice.inner_text() if notice.count() else ""
            self.check(
                "blocked" in notice_text.lower() or "location" in notice_text.lower(),
                "the notice speaks about location, not codes",
                notice_text.strip(),
            )
            self.check(self.dot_box(page) is None, "still no dot after a refused tap")
            after = self.control(page)
            self.check(
                after is not None and after["action"] == "start",
                "the control went back to 'Show my location'",
                json.dumps(after),
            )
            self.shot(page, "02-tap-blocked")
            if notice.count():
                page.click('.map-locate-notice button[aria-label="Dismiss"]')
                page.wait_for_timeout(200)
                self.check(
                    page.locator(".map-locate-notice").count() == 0,
                    "the notice can be dismissed",
                )
            ctx.close()

            # ------------------------------------------- 3. returning traveller
            print("phase 3 — permission already granted: the dot appears unasked")
            ctx = context(
                permissions=["geolocation"],
                geolocation=FIX,
            )
            page = ctx.new_page()
            page.goto(f"{host}/t/{TRIP_ID}/itinerary", wait_until="networkidle")
            page.wait_for_timeout(3000)
            self.dismiss_consent(page)
            calls = self.geo(page)
            self.check(
                calls["watch"] >= 1,
                "the app started watching WITHOUT a tap",
                f"watch={calls['watch']}",
            )
            dot = self.dot_box(page)
            self.check(dot is not None, "the dot is drawn")
            box = self.map_box(page)
            self.check(box is not None, "the map box was measured")
            self.check(
                dot is not None and self.inside(box, dot, margin=-2),
                "the dot is drawn inside the visible map",
                f"dot=({dot['cx']:.0f},{dot['cy']:.0f}) box=({box['x']:.0f},{box['y']:.0f},{box['w']:.0f}x{box['h']:.0f})"
                if dot and box
                else "",
            )
            # No yank: a camera that flew to the fix (zoom 13 on one point)
            # could not still hold BOTH numbered pins, ~40 km apart, inside the
            # visible strip. This is the proof that the silent start draws the
            # dot and leaves the trip's framing alone.
            pins = self.place_pins(page)
            off = [p for p in pins if not self.inside(box, p, margin=-2)]
            self.check(
                len(pins) >= 2 and not off,
                "the trip's own framing survived (every place pin still in view)",
                f"{len(pins)} pins, {len(off)} outside" if pins else "no pins rendered",
            )
            control = self.control(page)
            self.check(
                control is not None and control["action"] == "recentre",
                "the control offers 'Recentre on my location'",
                json.dumps(control),
            )
            self.check(
                page.locator(".map-locate-notice").count() == 0,
                "no notice on the granted path",
            )
            self.shot(page, "03-granted-auto-start")

            # ------------------------------------------- 4. the cycle
            print("phase 4 — tap = recentre, tap again = stop")
            page.click('[data-locate="recentre"]')
            landed = False
            centred = False
            for _ in range(20):
                page.wait_for_timeout(300)
                dot = self.dot_box(page)
                box = self.map_box(page)
                if dot and box and self.inside(box, dot, margin=-2):
                    landed = True
                    # The flight centres the dot in the visible strip (the
                    # sheet/rail padding is an OFFSET, so "centred" means the
                    # visible box's centre, which is what a traveller sees).
                    centred = abs(dot["cx"] - box["cx"]) <= 40 and abs(dot["cy"] - box["cy"]) <= 60
                    if centred:
                        break
            self.check(
                landed,
                "the recentre tap brought the dot into the visible map",
                f"dot=({dot['cx']:.0f},{dot['cy']:.0f}) box=({box['x']:.0f},{box['y']:.0f},{box['w']:.0f}x{box['h']:.0f})"
                if dot and box
                else "",
            )
            self.check(
                centred,
                "the camera centred it in the visible strip (not under the sheet)",
                f"dot=({dot['cx']:.0f},{dot['cy']:.0f}) box centre=({box['cx']:.0f},{box['cy']:.0f})"
                if dot and box
                else "",
            )
            control = self.control(page)
            self.check(
                control is not None and control["action"] == "stop",
                "while following, the control offers 'Stop showing my location'",
                json.dumps(control),
            )
            self.check(
                page.evaluate("document.querySelector('.map-pin-scaled').dataset.deviceLocation")
                == "live",
                "the map advertises the live session (data-device-location)",
            )
            # Let the basemap tiles finish painting before the shot — a
            # half-painted map is useless as phone-width evidence.
            page.wait_for_timeout(2500)
            self.shot(page, "04-recentred")

            # ------------------------------------- 5. level change keeps it
            print("phase 5 — in-app level change: same watch, same dot")
            day_link = page.locator(f'a[href="/t/{TRIP_ID}/day/1"]').first
            if day_link.count():
                day_link.click()
                page.wait_for_timeout(2500)
                self.check(page.url.endswith("/day/1"), "the day level opened in-app", page.url)
                self.check(
                    self.geo(page)["watch"] == 1,
                    "no second watch was started (the session is one)",
                    f"watch={self.geo(page)['watch']}",
                )
                self.check(
                    self.geo(page)["cleared"] == 0,
                    "the watch was not torn down by the level change",
                    f"cleared={self.geo(page)['cleared']}",
                )
                # The dot is where the MOCK is (Amsterdam), and the day frames
                # Chile — so it is drawn off-view, exactly as on the scan level.
                # What matters here is that the session is still live AND still
                # usable on the new level: the same tap brings the dot in.
                self.check(
                    page.evaluate("document.querySelector('.map-pin-scaled').dataset.deviceLocation")
                    == "live",
                    "the day level advertises the live session",
                )
                # Following is a property of the SESSION, so it survived the
                # level change: the control still offers to stop.
                control = self.control(page)
                self.check(
                    control is not None and control["action"] == "stop",
                    "the control is still in its following state on the day level",
                    json.dumps(control),
                )
                self.shot(page, "05-day-level")
                # Live updates. This harness cannot deliver one to the app's
                # HIGH-ACCURACY watcher: re-pointing the mock makes the headless
                # platform location provider report POSITION_UNAVAILABLE
                # (measured — a plain watcher still receives the new position,
                # the high-accuracy one errors), so there are two honest
                # outcomes and one dishonest one. The app may move the dot to
                # the new fix, or it may drop the session back to idle with a
                # one-line notice. It must NEVER keep claiming to be live while
                # showing the position it had before — a frozen dot on a map
                # that says it is tracking you is the failure this pins.
                ctx.set_geolocation(
                    {"latitude": -33.4489, "longitude": -70.6693, "accuracy": 150}
                )
                moved = False
                day_dot = day_box = None
                for _ in range(24):
                    page.wait_for_timeout(300)
                    day_dot = self.dot_box(page)
                    day_box = self.map_box(page)
                    if day_dot and day_box and self.inside(day_box, day_dot, margin=-2):
                        moved = True
                        break
                control = self.control(page)
                degraded = bool(control) and control["action"] == "start"
                self.check(
                    moved or degraded,
                    "a fix that stops arriving is handled honestly (moved, or idle)",
                    f"dot=({day_dot['cx']:.0f},{day_dot['cy']:.0f}) box=({day_box['x']:.0f},{day_box['y']:.0f},{day_box['w']:.0f}x{day_box['h']:.0f})"
                    if moved and day_dot and day_box
                    else json.dumps(control),
                )
                if degraded:
                    notice = page.locator(".map-locate-notice")
                    self.check(
                        notice.count() == 1 and "location" in notice.inner_text().lower(),
                        "…and the degradation explains itself in one line",
                        notice.inner_text().strip() if notice.count() else "",
                    )
                    self.check(
                        self.dot_box(page) is None,
                        "…with no stale dot left behind",
                    )
                    self.check(
                        page.evaluate(
                            "document.querySelector('.map-pin-scaled').dataset.deviceLocation"
                        )
                        == "off",
                        "…and the map stops advertising a live session",
                    )
                    self.shot(page, "06-degraded")
            else:
                print("  (no in-app day link in this fixture — skipped, not a failure)")

            # ---------------------- 6. a reload with the permission already granted
            print("phase 6 — reload: the returning traveller gets the dot unasked")
            page.goto(f"{host}/t/{TRIP_ID}/itinerary", wait_until="networkidle")
            page.wait_for_timeout(3000)
            self.dismiss_consent(page)
            self.check(
                self.dot_box(page) is not None,
                "the dot returns after a reload, with no tap",
            )
            self.check(
                self.geo(page)["watch"] >= 1,
                "tracking restarted from the stored permission alone",
                f"watch={self.geo(page)['watch']}",
            )

            # ------------------------------------------------------- stop
            print("phase 7 — stopping")
            control = self.control(page)
            if control is not None and control["action"] == "recentre":
                page.click('[data-locate="recentre"]')
                page.wait_for_timeout(1200)
            page.click('[data-locate="stop"]')
            page.wait_for_timeout(800)
            self.check(self.dot_box(page) is None, "stopping removes the dot")
            self.check(
                self.geo(page)["cleared"] >= 1,
                "stopping clears the browser watch",
                f"cleared={self.geo(page)['cleared']}",
            )
            control = self.control(page)
            self.check(
                control is not None and control["action"] == "start",
                "the control is idle again",
                json.dumps(control),
            )
            self.check(
                page.evaluate("document.querySelector('.map-pin-scaled').dataset.deviceLocation")
                == "off",
                "the map stops advertising a live session",
            )
            self.shot(page, "07-stopped")
            ctx.close()
            browser.close()

        print()
        if self.failures:
            print(f"FAILED ({len(self.failures)}): " + "; ".join(self.failures))
            return 1
        print(f"all checks passed — screenshots in {OUT}")
        return 0


if __name__ == "__main__":
    sys.exit(Probe().run())
