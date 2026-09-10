#!/usr/bin/env python3
"""Trip-page render smoke probe — loads /t/<id> in a REAL headless browser.

Why this exists: the frontend test suite renders components with
``renderToString`` (single render, no DOM), so it cannot see a crash that only
happens when a mounted component re-renders — the v0.25.8 outage was exactly
that (React #310, hook order), and it replaced *every* trip page with the
app-wide boundary's "Something went wrong. Please refresh the page and try
again." Nothing short of loading a page catches that class, so run this after
every deploy that touches the frontend:

    PROBE_TOKEN=<jwt> python3 backend/scripts/probe_trip_page.py

Exit 0 = every trip page rendered its title; 1 = at least one crashed or
rendered nothing recognisable.

Auth: the SPA's e2e mode (``?kiseki_e2e=1``) stubs Auth0 as signed-in and
feeds ``window.__KISEKI_ACCESS_TOKEN__`` to every API call — the same bypass
the PDF renderer uses. It grants nothing: the backend still enforces the
token. This probe only reads; it never writes to the deployment.

Mint the token with the workspace wrapper (see
profiles/kiseki/skills/.../kiseki-trip-content for the alias), or reuse
``backend/scripts/api_write.py``'s token plumbing.

Environment:
  PROBE_TOKEN   (required) bearer token for the API
  PROBE_BASE    frontend origin, default https://kiseki.konnektr.io
  PROBE_API     API origin, defaults to PROBE_BASE
  PROBE_SHOTS   screenshot dir, default /tmp/kiseki-probe
"""
from __future__ import annotations

import glob
import json
import os
import sys
import urllib.request

try:  # pragma: no cover - environment-dependent import
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sys.path.insert(0, "/opt/data/home/.local/lib/python3.13/site-packages")
    from playwright.sync_api import sync_playwright

BASE = os.environ.get("PROBE_BASE", "https://kiseki.konnektr.io")
API = os.environ.get("PROBE_API", BASE)
SHOTS = os.environ.get("PROBE_SHOTS", "/tmp/kiseki-probe")
CRASH_TEXT = "Something went wrong"
CHROME_GLOB = "/opt/hermes/.playwright/*/chrome-headless-shell-linux64/chrome-headless-shell"
SETTLE_MS = 6000


def _token() -> str:
    token = os.environ.get("PROBE_TOKEN")
    if not token:
        print("PROBE_TOKEN is required", file=sys.stderr)
        raise SystemExit(2)
    return token


def api_get(path: str, token: str) -> dict:
    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.load(response)


def collect_trips(ids: list[str], token: str) -> list[dict]:
    """Every trip, or just `ids`. The list endpoint keys a trip as `dtId`."""
    data = api_get("/api/trips?limit=50", token)
    trips = data["trips"] if isinstance(data, dict) else data
    for trip in trips:
        trip["_id"] = trip.get("dtId") or trip.get("id") or trip.get("slug")
    trips = [t for t in trips if t["_id"]]
    if ids:
        wanted = set(ids)
        trips = [t for t in trips if t["_id"] in wanted]
    return trips


def main() -> int:
    token = _token()
    trips = collect_trips(sys.argv[1:], token)
    if not trips:
        print("no trips matched", file=sys.stderr)
        return 1
    os.makedirs(SHOTS, exist_ok=True)
    print(f"probing {len(trips)} trip page(s) at {BASE}", file=sys.stderr)

    shells = sorted(glob.glob(CHROME_GLOB))
    results: list[dict] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=shells[-1] if shells else None, args=["--no-sandbox"]
        )
        try:
            for trip in trips:
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                errors: list[str] = []
                page.on("pageerror", lambda e, errs=errors: errs.append(f"pageerror: {e}"))
                page.on(
                    "console",
                    lambda m, errs=errors: errs.append(f"console.error: {m.text}")
                    if m.type == "error"
                    else None,
                )
                page.add_init_script(f"window.__KISEKI_ACCESS_TOKEN__ = {json.dumps(token)};")
                try:
                    page.goto(f"{BASE}/t/{trip['_id']}?kiseki_e2e=1", wait_until="domcontentloaded",
                              timeout=45000)
                    page.wait_for_timeout(SETTLE_MS)
                    body = page.inner_text("body")
                except Exception as exc:  # noqa: BLE001 - a dead page is a result, not a crash
                    body, errors = "", errors + [f"navigation: {exc}"]
                crash = CRASH_TEXT in body
                title = trip.get("title") or ""
                title_shown = bool(title) and title[:28] in body
                results.append({
                    "id": trip["_id"],
                    "title": title,
                    "stage": trip.get("stage"),
                    "crash": crash,
                    "title_rendered": title_shown,
                    "body_head": " ".join(body.split())[:180],
                    "errors": errors[:4],
                })
                page.screenshot(
                    path=os.path.join(
                        SHOTS, f"trip-{str(trip['_id'])[:8]}-{'crash' if crash else 'ok'}.png"
                    )
                )
                page.close()
        finally:
            browser.close()

    print(json.dumps(results, indent=2))
    crashed = [r for r in results if r["crash"]]
    broken = [r for r in results if not r["title_rendered"]]
    print(f"\n--- {len(results) - len(crashed)}/{len(results)} rendered, {len(crashed)} crashed ---")
    for row in crashed:
        print(f"  CRASH    {row['id'][:8]}  {row['title']!r}  err={row['errors'][:1]}")
    for row in broken:
        if not row["crash"]:
            print(f"  NO-TITLE {row['id'][:8]}  {row['title']!r}  body={row['body_head'][:90]!r}")
    return 1 if (crashed or broken) else 0


if __name__ == "__main__":
    sys.exit(main())
