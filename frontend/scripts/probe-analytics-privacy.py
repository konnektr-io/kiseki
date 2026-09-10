#!/usr/bin/env python3
"""Rendered-browser verification for the PostHog integration (issue #21).

Run it against a production build of the SPA:

    cd frontend && pnpm build
    python3 scripts/probe-analytics-privacy.py

It loads the REAL built bundle with the REAL config, drives several trip/join
pages, decodes the gzip bodies the SDK actually POSTs to PostHog EU, and asserts:

  1. events are delivered at all (a silent no-op is the failure mode that makes
     analytics look "installed" while collecting nothing),
  2. the trip id and claim token are rewritten to `:token` in EVERY URL-bearing
     property — not just `$current_url`, but `$pathname`, `$referrer` and the
     `$initial_*` values the SDK stores in `$set_once`,
  3. no raw trip id / claim token appears in any URL, path or referrer field,
  4. per-trip metrics DO arrive as a `trip_id` PROPERTY (the $dtId) — that is the
     sanctioned way to segment by trip (#21), so it must survive scrubbing,
  5. no session-replay traffic.

WHY THE UA SPOOFING — a test-harness requirement, not an app change.
posthog-js drops events from detected bots (`opt_out_useragent_filter`). Its bot
matcher substring-matches a blocklist containing "headlesschrome" against BOTH
`navigator.userAgent` and `navigator.userAgentData.brands`, and treats
`navigator.webdriver === true` as a bot. Playwright-driven Chromium trips all
three, so without the init script below EVERY config variant reports "nothing
sent" — which looks exactly like a broken integration and sends you hunting
through app code for a bug that is not there.

WHY CDP: the SDK delivers `$pageview` on pagehide via `sendBeacon`, and
Playwright's `request.post_data` is empty for beacon requests. CDP's
`Network.requestWillBeSent` still carries `postData`. Bodies are raw gzip.
"""
import base64
import gzip
import json
import re
import sys
import threading
import urllib.parse
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / "dist"
CHROME = (
    "/opt/hermes/.playwright/chromium_headless_shell-1243/"
    "chrome-headless-shell-linux64/chrome-headless-shell"
)
REAL_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
NOT_A_BOT = """
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
Object.defineProperty(navigator, 'userAgentData', {
  get: () => ({
    brands: [
      { brand: 'Chromium', version: '131' },
      { brand: 'Google Chrome', version: '131' },
      { brand: 'Not_A Brand', version: '24' },
    ],
    mobile: false,
    platform: 'macOS',
  }),
  configurable: true,
});
"""

TRIP_ID = "bf29a027-1f6c-4a3b-9d21-7c0e5a4b8f13"
CLAIM_TOKEN = "c66b1f42f0e94d5c8a7b3e2d1c0f9a8b7e6d5c4b3a291807f6e5d4c3b2a1908"
PORT = 8819

TRIP = {
    "id": TRIP_ID,
    "slug": "canada-2027",
    "title": "Canada 2027 — Heliski",
    "stage": "booked",
    "visibility": "public",
    "crew": [{"id": "p1", "name": "Niko Raes", "role": "owner"}],
    "practical": {"todos": [], "links": [], "contacts": []},
    "days": [{"id": "d1", "date": "2027-02-06", "title": "Arrival", "blocks": []}],
    "sections": [{"id": "s1", "title": "Arrival", "days": [0, 0]}],
}

# Properties that carry a location and therefore must never contain a raw secret.
URL_LIKE_KEYS = (
    "$current_url",
    "$pathname",
    "$referrer",
    "$entry_url",
    "$exit_url",
    "$initial_current_url",
    "$initial_pathname",
    "$initial_referrer",
)


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


def decode_event_body(url: str, post_data: str) -> str | None:
    """Decode a PostHog /e/ body: `data=` param or the raw gzip body itself."""
    candidates = []
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    if "data" in q:
        candidates.append(q["data"][0])
    if post_data:
        candidates.append(post_data)
    for cand in candidates:
        if not cand:
            continue
        if cand.lstrip().startswith("{"):
            return cand
        for encoding in ("latin-1", "utf-8"):
            try:
                raw = cand.encode(encoding)
            except Exception:
                continue
            for decompress in (
                gzip.decompress,
                zlib.decompress,
                lambda d: gzip.decompress(base64.b64decode(d)),
                base64.b64decode,
            ):
                try:
                    out = decompress(raw)
                except Exception:
                    continue
                if b"{" in out[:400]:
                    return out.decode("utf-8", "replace")
    return None


def flatten(value, prefix="", out=None):
    if out is None:
        out = {}
    if isinstance(value, dict):
        for k, v in value.items():
            flatten(v, f"{prefix}.{k}" if prefix else str(k), out)
    else:
        out[prefix] = value
    return out


def main() -> int:
    from playwright.sync_api import sync_playwright

    if not (DIST / "index.html").is_file():
        print(f"!! no built SPA at {DIST} — run `pnpm build` first")
        return 2

    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), SPAHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    posts: list[dict] = []
    replay_hits: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        ctx = browser.new_context(user_agent=REAL_UA, viewport={"width": 1440, "height": 900})
        ctx.add_init_script(NOT_A_BOT)
        page = ctx.new_page()
        cdp = ctx.new_cdp_session(page)
        cdp.send("Network.enable")

        def on_request(e):
            req = e.get("request", {})
            url = req.get("url", "")
            if "posthog.com" not in url:
                return
            if re.search(r"/(e|i/v0/e)/", url):
                posts.append({"url": url, "method": req.get("method"), "postData": req.get("postData", "")})
            if re.search(r"replay|recorder|/s/", url):
                replay_hits.append(url)

        cdp.on("Network.requestWillBeSent", on_request)
        page.route(
            re.compile(r"/api/trips/[^/]+$"),
            lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(TRIP)),
        )

        visits = [
            ("landing", "/"),
            ("trip overview", f"/t/{TRIP_ID}"),
            ("itinerary", f"/t/{TRIP_ID}/itinerary"),
            ("day level", f"/t/{TRIP_ID}/day/0"),
            ("practical", f"/t/{TRIP_ID}/practical"),
            ("join page", f"/join/{CLAIM_TOKEN}"),
        ]
        for label, path in visits:
            print(f"  visit {label:14s} {path}")
            page.goto(f"http://127.0.0.1:{PORT}{path}", wait_until="networkidle")
            page.wait_for_timeout(3000)

        browser.close()
    httpd.shutdown()

    events = []
    for post in posts:
        decoded = decode_event_body(post["url"], post["postData"])
        if not decoded:
            continue
        try:
            body = json.loads(decoded)
        except Exception:
            continue
        for ev in body.get("batch", [body]) if isinstance(body, dict) else [body]:
            events.append(ev)

    print(f"\ndecoded analytics events: {len(events)}")

    failures = []
    if not events:
        failures.append("no analytics events were delivered (silent no-op)")

    raw_in_url_field: list[str] = []
    tripped: list[str] = []
    for ev in events:
        for bag_name in ("properties", "$set", "$set_once"):
            bag = ev.get(bag_name)
            if not isinstance(bag, dict):
                continue
            flat = flatten(bag)
            for key, value in flat.items():
                leaf = key.split(".")[-1]
                if leaf in URL_LIKE_KEYS and isinstance(value, str):
                    if TRIP_ID in value:
                        raw_in_url_field.append(f"{bag_name}.{key} = {value}")
                    if CLAIM_TOKEN in value:
                        raw_in_url_field.append(f"{bag_name}.{key} = {value}")
                if isinstance(value, str) and (TRIP_ID in value or CLAIM_TOKEN in value):
                    tripped.append(f"{bag_name}.{key}")

    if raw_in_url_field:
        failures.append("raw secret in a URL/path field: " + "; ".join(raw_in_url_field[:4]))

    # Sanity: the scrubbing must be OBSERVABLE, otherwise the checks above pass
    # vacuously (e.g. if every body failed to decode).
    blob = json.dumps(events)
    if "/t/:token" not in blob:
        failures.append("no normalized /t/:token anywhere — is the scrubber even running?")
    if "/join/:token" not in blob:
        failures.append("no normalized /join/:token anywhere")
    if '"trip_id"' not in blob:
        failures.append("trip_id property missing — per-trip metrics would be impossible")
    if TRIP_ID not in blob:
        failures.append("trip_id value missing")
    if replay_hits:
        failures.append("session-replay traffic observed: " + ", ".join(replay_hits[:2]))

    print("\n--- sample of what a trip pageview actually carries ---")
    for ev in events:
        props = ev.get("properties", {})
        if props.get("$pathname", "").startswith("/t/"):
            for key in ("$current_url", "$pathname", "$referrer", "trip_id"):
                if key in props:
                    print(f"    {key:16s} = {props[key]}")
            break

    print("\n--- secret-bearing fields found (must be empty) ---")
    print("   ", raw_in_url_field or "none")
    print("\n--- fields holding the trip id (should be trip_id only) ---")
    print("   ", sorted(set(tripped)) or "none")

    print("\n=== RESULT ===")
    if failures:
        for f in failures:
            print("  FAIL:", f)
        return 1
    print("  PASS — events delivered; every URL/path/referrer field normalized to :token;")
    print("         no raw trip id or claim token in any location field; per-trip metrics")
    print("         keyed on the trip_id property; no replay traffic.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
