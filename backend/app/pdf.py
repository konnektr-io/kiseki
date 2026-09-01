"""Playwright-based PDF booklet rendering.

Renders the SPA's print-optimised /t/<key>/booklet route to an A4 PDF.
The route does its own data fetching, so the PDF always reflects live content.

The booklet is a CREW feature (issue #13): the endpoint is id-based and
protected, so the render key is the trip ``$dtId`` and the renderer seeds the
caller's Auth0 access token into the page (localStorage, the exact
``auth0.spa.js`` cache shape) before the app loads — the SPA then fetches the
protected trip and renders normally. Anonymous share-link visitors no longer
get a PDF button at all.

Browser resolution: try the configured PLAYWRIGHT_BROWSERS_PATH first, then
the standard ~/.cache/ms-playwright location. Each candidate is verified by
actually launching chromium with it, so a path pointing at a different
Playwright revision is skipped instead of failing (keeps local dev working
regardless of what the environment points the var at).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.async_api import async_playwright

from app.config import AUTH0_AUDIENCE, AUTH0_CLIENT_ID

# The exact localStorage cache shape @auth0/auth0-spa-js (v2, localstorage
# cacheLocation) writes for a session: key `auth0.spa.js`, value a map of
# `@@auth0spajs@@::{clientId}::{audience}::{scope}` → {body, expiresAt}.
_AUTH0_SCOPE = "openid profile email offline_access"


def _auth0_cache_seed(access_token: str) -> str:
    """Init script that seeds the SPA's auth0 session cache with a token."""
    cache_key = f"@@auth0spajs@@::{AUTH0_CLIENT_ID}::{AUTH0_AUDIENCE}::{_AUTH0_SCOPE}"
    entry = {
        "body": {
            "access_token": access_token,
            "expires_in": 3600,
            "scope": _AUTH0_SCOPE,
            "token_type": "Bearer",
            "audience": AUTH0_AUDIENCE,
            "client_id": AUTH0_CLIENT_ID,
        },
        "expiresAt": 0,  # set to epoch-seconds in-page (we are not at the page's clock)
    }
    return (
        "const cache = JSON.parse(localStorage.getItem('auth0.spa.js') || '{}');"
        f"cache[{json.dumps(cache_key)}] = {json.dumps(entry)};"
        f"cache[{json.dumps(cache_key)}].expiresAt = Math.floor(Date.now() / 1000) + 3600;"
        "localStorage.setItem('auth0.spa.js', JSON.stringify(cache));"
    )


def _browser_path_candidates() -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if configured:
        candidates.append(Path(configured))
    candidates.append(Path.home() / ".cache" / "ms-playwright")
    return candidates


async def render_booklet_pdf(
    base_url: str, key: str, out_path: Path, access_token: str | None = None
) -> None:
    url = f"{base_url}/t/{key}/booklet"
    last_error: Exception | None = None

    for candidates_dir in _browser_path_candidates():
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(candidates_dir)
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(args=["--no-sandbox"])
                try:
                    page = await browser.new_page()
                    if access_token:
                        # Crew render (id route): the booklet page loads the
                        # PROTECTED trip, so the page must appear signed in.
                        await page.add_init_script(_auth0_cache_seed(access_token))
                    await page.goto(url, wait_until="networkidle", timeout=60_000)
                    await page.pdf(path=str(out_path), prefer_css_page_size=True, print_background=True)
                finally:
                    await browser.close()
            return
        except Exception as exc:  # wrong revision / missing browser → try next
            last_error = exc

    raise last_error or RuntimeError("No usable Playwright browser found")
