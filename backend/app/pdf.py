"""Playwright-based PDF booklet rendering.

Renders the SPA's print-optimised /t/<key>/booklet route to an A4 PDF.
The route does its own data fetching, so the PDF always reflects live content.

The booklet is a CREW feature (issue #13): the endpoint is id-based and
protected (JWT + crew role via ``authorize_trip_path``), so it works for
private trips too. The renderer hits the SAME ``/t/<key>/booklet`` SPA route
the browser user visits — but the booklet.pdf endpoint forwards the caller's
Bearer token (in the Authorization header) to that route, and the SPA catch-all
injects it as ``window.__KISEKI_ACCESS_TOKEN__``.

Auth bypass (#58): the backend is ALREADY protected (JWT + crew role), so the
SPA's Auth0 sign-in gate is redundant for the PDF render. The renderer sets
``window.__KISEKI_PDF_RENDER__ = true`` before the app loads; the SPA skips its
UI auth gate in that mode and uses the injected access token for its API calls.
No Auth0 cache seeding required — just the flag + the real token.

Browser resolution: try the configured PLAYWRIGHT_BROWSERS_PATH first, then
the standard ~/.cache/ms-playwright location. Each candidate is verified by
actually launching chromium with it, so a path pointing at a different
Playwright revision is skipped instead of failing (keeps local dev working
regardless of what the environment points the var at).
"""

from __future__ import annotations

import os
from pathlib import Path

from playwright.async_api import async_playwright

# Set in the page before the SPA loads; TripLayout skips its isAuthenticated
# gate (and loading spinner) when present (the backend has already enforced
# JWT + crew role; the access token is injected via window.__KISEKI_ACCESS_TOKEN__).
_PDF_RENDER_FLAG = "window.__KISEKI_PDF_RENDER__ = true;"


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
    # access_token is forwarded by booklet.pdf's Authorization header → the SPA
    # catch-all injects it as window.__KISEKI_ACCESS_TOKEN__ in the HTML. The
    # renderer just needs to flag the page so the SPA skips Auth0.
    last_error: Exception | None = None

    for candidates_dir in _browser_path_candidates():
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(candidates_dir)
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(args=["--no-sandbox"])
                try:
                    page = await browser.new_page()
                    if access_token:
                        # The SPA catches this Bearer token from the HTML that
                        # the /t/<key> catch-all injects; no auth0 login here.
                        await page.add_init_script(_PDF_RENDER_FLAG)
                    # Print media BEFORE navigation, not just at page.pdf():
                    # the booklet's maps are `print:hidden` / `hidden print:block`,
                    # so this is what makes the loaded DOM the printed one. It
                    # keeps the dynamic MapLibre maps from ever mounting during
                    # the render — no WebGL contexts, and no vector-tile traffic
                    # to hold `networkidle` open.
                    await page.emulate_media(media="print")
                    await page.goto(url, wait_until="networkidle", timeout=60_000)
                    # Wait for the actual booklet content instead of capturing
                    # the transient loading/auth state.
                    await page.wait_for_function(
                        "document.querySelector('[data-testid=booklet-ready]') "
                        "|| document.querySelector('.booklet-cover')",
                        timeout=30_000,
                    )
                    await page.pdf(
                        path=str(out_path),
                        prefer_css_page_size=True,
                        print_background=True,
                    )
                finally:
                    await browser.close()
            return
        except Exception as exc:  # wrong revision / missing browser → try next
            last_error = exc

    raise last_error or RuntimeError("No usable Playwright browser found")
