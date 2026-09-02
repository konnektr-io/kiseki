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

Map parity (#37): the booklet's maps are the SAME MapLibre GL JS maps as on
screen (OpenFreeMap positron, themed route/markers). They render live during
the PDF pass via SwiftShader software GL — no static-map proxy. That is why
the renderer launches Chromium with ANGLE+SwiftShader and waits for
``document.fonts.ready`` + MapLibre ``idle`` before printing; same silent
half-loaded bug class as the font fallback.

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
    last_error: Exception | None = None

    for candidates_dir in _browser_path_candidates():
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(candidates_dir)
        try:
            async with async_playwright() as p:
                try:
                    browser = await p.chromium.launch(
                        args=[
                            "--no-sandbox",
                            "--disable-dev-shm-usage",
                            "--use-gl=angle",
                            "--use-angle=swiftshader",
                            "--enable-webgl",
                            "--enable-webgl2",
                        ]
                    )
                except Exception as exc:
                    last_error = exc
                    continue
                try:
                    page = await browser.new_page()
                    if access_token:
                        await page.set_extra_http_headers(
                            {"Authorization": f"Bearer {access_token}"}
                        )
                    # Flag must be set before the SPA loads so it skips Auth0
                    # and mounts MapLibre eagerly (IntersectionObserver bypass).
                    await page.add_init_script(_PDF_RENDER_FLAG)

                    # Booklet maps are MapLibre live renders (#37) — they must
                    # mount during the PDF pass. `TripMap` is no longer split
                    # into screen/print halves, so the choice of emulated media
                    # at navigation time no longer decides whether maps mount.
                    # Emulate print BEFORE navigation so @media print / @page
                    # rules already apply to the loaded DOM (cover bleed, A4).
                    await page.emulate_media(media="print")
                    # Use domcontentloaded — networkidle would be held open by
                    # vector-tile and DEM fetches indefinitely.
                    await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                    # Wait for the actual booklet content instead of capturing
                    # the transient loading/auth state.
                    await page.wait_for_function(
                        "document.querySelector('[data-testid=booklet-ready]') "
                        "|| document.querySelector('.booklet-cover')",
                        timeout=30_000,
                    )
                    # Fonts: the Playwright PDF renderer must await the font
                    # load promise before printing, or text reflows and glyphs
                    # fallback silently (DESIGN.md §12 / §4.1).
                    try:
                        await page.wait_for_function(
                            "document.fonts.status === 'loaded' || document.fonts.ready.then(() => true)",
                            timeout=30_000,
                        )
                        await page.evaluate("document.fonts.ready")
                    except Exception:
                        # Non-fatal — print anyway rather than 500 on a slow
                        # font fetch; the text will fallback but the PDF still
                        # renders.
                        pass

                    # Maps: MapLibre v6 has no WebGL1 fallback, so headless
                    # needs SwiftShader (launch args above). Wait for every
                    # map on the page to reach `idle` (all tiles + layers) —
                    # half-loaded tiles are the same silent-failure class as
                    # the font bug (#37). MapView sets
                    # `[data-maplibre][data-map-ready="true"]` on idle and
                    # `[data-maplibre][data-map-failed="true"]` on style/load
                    # error so the PDF never blocks forever on a dead tile
                    # source. No maps on the page (japan 2028 empty leg) → done.
                    try:
                        await page.wait_for_function(
                            """() => {
                                const els = document.querySelectorAll('[data-maplibre]');
                                if (els.length === 0) return true;
                                return Array.from(els).every(el =>
                                    el.dataset.mapReady === 'true' || el.dataset.mapFailed === 'true'
                                );
                            }""",
                            timeout=30_000,
                        )
                    except Exception:
                        # Tiles or DEM stalled — print what we have rather
                        # than timing out the whole booklet.
                        pass

                    # Small settle for terrain hillshade/contours (async, never
                    # awaited in MapView) — they are atmosphere, not content,
                    # but give them a beat to land if the DEM already arrived.
                    await page.wait_for_timeout(800)

                    await page.pdf(
                        path=str(out_path),
                        prefer_css_page_size=True,
                        print_background=True,
                    )
                finally:
                    await browser.close()
            return
        except Exception:
            # Render error after successful browser launch (TimeoutError,
            # navigation failure, etc.) — propagate as-is instead of masking
            # it with the fallback path's "Executable doesn't exist".
            raise

    raise last_error or RuntimeError("No usable Playwright browser found")
