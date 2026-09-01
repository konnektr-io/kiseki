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
    """Init script that seeds the SPA's auth0 session cache with a token.

    The SDK needs BOTH entries to consider the session valid:
    - the access-token entry (``@@auth0spajs@@::{clientId}::{audience}::{scope}``)
      — returned by ``getAccessTokenSilently()``, so the protected trip fetch
      carries the real caller token;
    - the id-token entry at the **client-only** key (``@@auth0spajs@@::{clientId}::@@user@@``)
      with its ``decodedToken`` — ``isAuthenticated``/``user`` read the DECODED
      user from that key (the SDK re-verifies only at login, so a fabricated id
      token is fine here).

    Bug #58: previously the id-token was stored at ``base_key + '@@user@@'``
    (the audience-scoped key), but auth0-spa-js v2's ``getIdTokenCacheKey``
    produces the client-only key ``@@auth0spajs@@::{clientId}::@@user@@``.
    The fallback on the access-token entry checks ``entryByScope.id_token``
    which never exists, so ``getUser()``/``getIdToken()`` returned undefined
    and ``isAuthenticated`` stayed false → the PDF captured the sign-in gate.
    """
    base_key = f"@@auth0spajs@@::{AUTH0_CLIENT_ID}::{AUTH0_AUDIENCE}::{_AUTH0_SCOPE}"
    id_token_key = f"@@auth0spajs@@::{AUTH0_CLIENT_ID}::@@user@@"
    now = "Math.floor(Date.now() / 1000)"
    access_entry = {
        "body": {
            "access_token": access_token,
            "expires_in": 3600,
            "scope": _AUTH0_SCOPE,
            "token_type": "Bearer",
            "audience": AUTH0_AUDIENCE,
            "client_id": AUTH0_CLIENT_ID,
        },
        "expiresAt": 0,  # replaced in-page
    }
    fake_id_token = (
        "eyJhbG...VCJ9."
        "eyJzdW...pIn0."
        "ZmFrZS1zaWduYXR1cmU"
    )
    # aud must be the CLIENT_ID (mirrors real ID tokens); the API resolves
    # the caller's identity from the *access* token, not this entry.
    id_entry = {
        "id_token": fake_id_token,
        "decodedToken": {
            "claims": {
                "sub": "crew",
                "name": "Crew member",
                "aud": AUTH0_CLIENT_ID,
                "azp": AUTH0_CLIENT_ID,
                "iss": "https://kiseki.invalid/",
                "exp": 4_102_444_800,
            },
            "user": {"sub": "crew", "name": "Crew member"},
        },
    }
    return (
        "const cache = JSON.parse(localStorage.getItem('auth0.spa.js') || '{}');"
        f"cache[{json.dumps(base_key)}] = {json.dumps(access_entry)};"
        f"cache[{json.dumps(base_key)}].expiresAt = {now} + 3600;"
        f"cache[{json.dumps(id_token_key)}] = {json.dumps(id_entry)};"
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
                    # Guard against capturing the transient "Sign in" screen
                    # during the isAuthenticated === false → true flip. Wait
                    # until auth0.spa.js is seeded AND the booklet cover is
                    # mounted (data-testid=booklet-ready), falling back to the
                    # auth-cache key that the seed script writes.
                    if access_token:
                        await page.wait_for_function(
                            "localStorage.getItem('auth0.spa.js') !== null "
                            "&& (document.querySelector('[data-testid=booklet-ready]') "
                            "|| document.querySelector('.booklet-cover'))",
                            timeout=30_000,
                        )
                    else:
                        await page.wait_for_function(
                            "document.querySelector('[data-testid=booklet-ready]') "
                            "|| document.querySelector('.booklet-cover')",
                            timeout=30_000,
                        )
                    await page.pdf(path=str(out_path), prefer_css_page_size=True, print_background=True)
                finally:
                    await browser.close()
            return
        except Exception as exc:  # wrong revision / missing browser → try next
            last_error = exc

    raise last_error or RuntimeError("No usable Playwright browser found")
