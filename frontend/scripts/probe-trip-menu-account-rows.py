#!/usr/bin/env python3
"""#423 probe — the trip actions menu for an anonymous vs signed-in reader.

The menu's rows are a *presentation* contract (who is offered what, and whether
the offer is actionable), and the parts that matter are the ones jsdom cannot
see: that the greyed follow row is really DIMMED, that clicking it is inert, and
that the row goes away because the followed document was applied — not because
a click handler ran.

Serves the built bundle with an SPA fallback and fulfils `/api/trips/<id>` from
an in-file fixture, so it is self-contained: no backend, no graph, no live data,
no Auth0 tenant (requests to the tenant are aborted — a fresh browser context has
no session, and an unresolved auth context leaves the layout on its loading
screen, which is a harness artifact rather than the app under test).

Four cases, each asserted from the DOM of the OPEN menu:
  A  anonymous            → Sign in + greyed Follow, NO booklet row, inert click
  B  signed in, no role   → live Follow + booklet; click → POST /follow once,
                            the row is replaced by the booklet row, menu stays open
  C  signed in, follower  → no Follow row, booklet present
  D  A at desktop width   → same rows for the pointer device

Usage (build first):
    cd frontend && npx tsc --noEmit && npx vite build
    backend/.venv/bin/python frontend/scripts/probe-trip-menu-account-rows.py

Env:
    KISEKI_PROBE_DIST   bundle to drive (default frontend/dist of this checkout)
    KISEKI_PROBE_OUT    screenshot directory (default /tmp/kiseki-423-shots)
    KISEKI_PROBE_CHROME explicit headless-shell path
"""

import glob
import http.server
import json
import os
import sys
import threading

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.environ.get("KISEKI_PROBE_DIST", os.path.join(HERE, "..", "dist"))
OUT = os.environ.get("KISEKI_PROBE_OUT", "/tmp/kiseki-423-shots")
TRIP_ID = "b16680e7-a338-4c76-9cd7-fa13d45be594"


def chromium_path():
    """The headless shell this container actually has (the dir is versioned)."""
    if os.environ.get("KISEKI_PROBE_CHROME"):
        return os.environ["KISEKI_PROBE_CHROME"]
    hits = sorted(
        glob.glob("/opt/hermes/.playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")
    )
    hits += sorted(
        glob.glob(
            os.path.expanduser(
                "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"
            )
        )
    )
    if not hits:
        raise SystemExit("no chromium headless shell found — set KISEKI_PROBE_CHROME")
    return hits[-1]


# A FIXTIONAL trip: the probe must never carry real content (public repo), and
# the row rules only read `visibility` and `myRole`.
TRIP = {
    "id": TRIP_ID,
    "slug": "probe-public-trip",
    "title": "Kayaks & Northern Lights",
    "subtitle": "A public trip the probe serves",
    "stage": "planned",
    "startDate": "2027-02-01",
    "endDate": "2027-02-10",
    "timezone": "Europe/Oslo",
    "visibility": "public",
    "coverStats": [],
    "stats": [],
    "features": [],
    "locations": [{"id": "loc-1", "name": "Tromsø"}],
    "sections": [],
    "crew": [],
    "practical": {},
    "days": [
        {
            "id": "day-1",
            "date": "2027-02-01",
            "title": "Arrival",
            "blocks": [{"id": "blk-1", "kind": "note", "text": "Land, pick up the car."}],
        }
    ],
}

failures = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


class Handler(http.server.SimpleHTTPRequestHandler):
    """The bundle, with the SPA catch-all FastAPI also serves."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST, **kwargs)

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) or (
            os.path.isdir(path) and not os.path.exists(os.path.join(path, "index.html"))
        ):
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, *a):  # quiet
        pass


def serve():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def menu_rows(page):
    return page.eval_on_selector_all(
        '[role="menu"] [role^="menuitem"]',
        "els => els.map(e => ({text: (e.textContent||'').trim(), disabled: e.disabled === true,"
        " tag: e.tagName, opacity: getComputedStyle(e).opacity}))",
    )


def open_menu(page):
    page.wait_for_selector('button[aria-label="Trip actions"]', timeout=25000)
    page.click('button[aria-label="Trip actions"]')
    page.wait_for_selector('[role="menu"]', timeout=10000)
    page.wait_for_timeout(150)


def drop_banner(page):
    """Dismiss the cookie banner by CLICKING it.

    Never `node.remove()`: the banner is React-rendered, so plucking it out of
    the DOM leaves React holding a detached subtree and the next update throws
    (`NotFoundError: removeChild`) — the app-wide boundary then paints
    "Something went wrong", i.e. a harness artifact that reads exactly like a
    regression in the code under test.
    """
    try:
        page.click('button:has-text("No thanks")', timeout=3000)
    except Exception:
        pass  # no banner (already consented, or the opt-in variant)


def run_case(browser, port, name, *, e2e, role, shot_width=390):
    state = {"follow": 0}
    # The document the probe serves: a follower's own read carries the role.
    fixture = {**TRIP, "myRole": "follower"} if role == "follower" else TRIP
    context = browser.new_context(viewport={"width": shot_width, "height": 844}, device_scale_factor=2)
    page = context.new_page()
    if e2e:
        page.add_init_script("window.__KISEKI_ACCESS_TOKEN__ = 'probe-token';")

    def handle(route):
        req = route.request
        url = req.url.split("?")[0]
        if "auth.konnektr.io" in url or "auth0.com" in url:
            route.abort()
            return
        if url.endswith(f"/api/trips/{TRIP_ID}/follow"):
            state["follow"] += 1
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({**TRIP, "myRole": "follower"}),
            )
            return
        if url.endswith(f"/api/trips/{TRIP_ID}") or url.endswith("/api/trips"):
            body = fixture if url.endswith(TRIP_ID) else {"trips": [fixture]}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
            return
        if "/api/" in url:
            route.fulfill(status=404, content_type="application/json", body='{"detail":"probe: not stubbed"}')
            return
        route.continue_()

    page.route("**/*", handle)
    url = f"http://127.0.0.1:{port}/t/{TRIP_ID}" + ("?kiseki_e2e=1" if e2e else "")
    page.goto(url, wait_until="load")
    drop_banner(page)
    print(f"\n=== {name} ===")
    try:
        page.wait_for_selector('button[aria-label="Trip actions"]', timeout=30000)
    except Exception:
        body = (page.inner_text("body") or "")[:400].replace("\n", " | ")
        page.screenshot(path=f"{OUT}/{name}-FAILED.png")
        check(f"{name}: trip page painted (menu trigger present)", False, body)
        context.close()
        return
    page.wait_for_timeout(1500)
    drop_banner(page)
    open_menu(page)

    rows = menu_rows(page)
    texts = [r["text"] for r in rows]
    print("  rows:", json.dumps(rows, ensure_ascii=False))
    box = page.eval_on_selector(
        'button[aria-label="Trip actions"]',
        "e => { const r = e.getBoundingClientRect(); return {x: r.x, y: r.y}; }",
    )
    clip = {"x": max(0, box["x"] - 250), "y": 0, "width": min(shot_width, 300), "height": 420}
    page.screenshot(path=f"{OUT}/{name}-menu.png", clip=clip)
    page.screenshot(path=f"{OUT}/{name}-page.png")
    print("  shots:", f"{OUT}/{name}-menu.png", f"{OUT}/{name}-page.png")

    if role == "anonymous":
        follow = next((r for r in rows if r["text"].startswith("Follow this trip")), None)
        check(f"{name}: Sign in row present", any(t.startswith("Sign in") for t in texts), str(texts))
        check(f"{name}: Follow row present and GREYED", bool(follow) and follow["disabled"], str(follow))
        check(
            f"{name}: the greyed row is actually DIMMED (not merely inert)",
            bool(follow) and float(follow["opacity"]) < 1,
            f"opacity={follow['opacity'] if follow else 'n/a'}",
        )
        check(f"{name}: NO booklet row", not any("Download booklet PDF" in t for t in texts), str(texts))
        check(f"{name}: no follow POST fired", state["follow"] == 0, f"posts={state['follow']}")
        page.eval_on_selector_all(
            '[role="menu"] [role^="menuitem"]',
            "els => { const f = els.find(e => (e.textContent||'').includes('Follow this trip')); f && f.click(); }",
        )
        page.wait_for_timeout(600)
        check(f"{name}: clicking the greyed row is inert", state["follow"] == 0, f"posts={state['follow']}")
    elif role == "stranger":
        check(
            f"{name}: Follow row is live",
            any(r["text"].startswith("Follow this trip") and not r["disabled"] for r in rows),
            str(texts),
        )
        check(f"{name}: booklet row present", any("Download booklet PDF" in t for t in texts), str(texts))
        check(f"{name}: no Sign in row", not any(t.startswith("Sign in") for t in texts), str(texts))
        page.click('[role="menu"] [role^="menuitem"]:has-text("Follow this trip")')
        page.wait_for_timeout(1200)
        after = menu_rows(page)
        after_texts = [r["text"] for r in after]
        print("  rows after follow:", json.dumps(after, ensure_ascii=False))
        check(f"{name}: POST /follow hit exactly once", state["follow"] == 1, f"posts={state['follow']}")
        check(
            f"{name}: Follow row gone after applying the document",
            not any(t.startswith("Follow this trip") for t in after_texts),
            str(after_texts),
        )
        check(f"{name}: booklet row still there", any("Download booklet PDF" in t for t in after_texts), str(after_texts))
        check(
            f"{name}: menu stayed open (the reader sees the change)",
            page.query_selector('[role="menu"]') is not None,
        )
        page.screenshot(path=f"{OUT}/{name}-after-follow.png", clip=clip)
        print("  shot:", f"{OUT}/{name}-after-follow.png")
    elif role == "follower":
        check(f"{name}: NO Follow row", not any(t.startswith("Follow this trip") for t in texts), str(texts))
        check(f"{name}: booklet row present", any("Download booklet PDF" in t for t in texts), str(texts))

    context.close()


def main():
    if not os.path.isdir(DIST):
        raise SystemExit(f"no bundle at {DIST} — run `npx vite build` first")
    os.makedirs(OUT, exist_ok=True)
    httpd, port = serve()
    print(f"serving {DIST} on 127.0.0.1:{port}")
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"], executable_path=chromium_path())
        run_case(browser, port, "A-anonymous", e2e=False, role="anonymous")
        run_case(browser, port, "B-stranger", e2e=True, role="stranger")
        run_case(browser, port, "C-follower", e2e=True, role="follower")
        run_case(browser, port, "D-anonymous-desktop", e2e=False, role="anonymous", shot_width=1280)
        browser.close()
    httpd.shutdown()
    print("\nfailures:", failures if failures else "none")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
