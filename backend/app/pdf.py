"""Playwright-based PDF booklet rendering.

Renders the SPA's print-optimised /t/<key>/booklet route to an A4 PDF.
The route does its own data fetching, so the PDF always reflects live content.

The booklet is a CREW feature (issue #13): the endpoint is id-based and
protected (JWT + crew role via ``authorize_trip_path``), so it works for
private trips too. The renderer hits the SAME ``/t/<key>/booklet`` SPA route
the browser user visits.

Auth bypass (#58, hardened after the v0.15.6 incidents): the backend is
ALREADY protected (JWT + crew role), so the SPA's Auth0 sign-in gate is
redundant for the PDF render. The renderer sets
``window.__KISEKI_PDF_RENDER__ = true`` before the app loads; the SPA skips
its UI auth gate in that mode and uses the injected access token for its API
calls. The token is injected via ``add_init_script`` — NOT via the SPA-shell
``<script>`` replace: that path depends on the loopback navigation carrying
an Authorization header, and if it ever doesn't, the SPA falls into
``getAccessTokenSilently()``, whose Auth0 iframe can never complete in a
headless browser. The render then hangs with no API call at all and dies at
the booklet-content timeout (the nondeterministic first-click failure).
The init-script injection is unconditional and cannot fail silently.

The renderer also strips the Authorization header from every third-party
request (tiles.openfreemap.org, fonts, DEM) — the SPA's own API fetches keep
their header, but nothing the page loads from other origins sees the
caller's bearer token.

Map parity (#37): the booklet's maps are the SAME MapLibre GL JS maps as on
screen (OpenFreeMap positron, themed route/markers). They render live during
the PDF pass via SwiftShader software GL — no static-map proxy. That is why
the renderer launches Chromium with ANGLE+SwiftShader and waits for
``document.fonts.ready`` + MapLibre ``idle`` before printing; same silent
half-loaded bug class as the font fallback.

Atomic output: ``page.pdf()`` writes to a sibling temp file that is
``os.replace``d onto ``out_path`` only after it is fully written. A consumer
must never be able to read a half-written PDF (the "damaged and could not
be repaired" download).

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


def _token_init_script(access_token: str | None) -> str:
    """Inject the access token as a page global BEFORE any app script runs.

    Injected unconditionally (empty string when absent) so TripLayout's
    ``window.__KISEKI_ACCESS_TOKEN__ ?? getAccessTokenSilently()`` can never
    fall into the Auth0 SDK in a headless browser — an iframe flow that
    cannot complete there and hangs the whole render (#58 follow-up).
    """
    safe = (access_token or "").replace("\\", "\\\\").replace('"', '\\"')
    return f'window.__KISEKI_ACCESS_TOKEN__ = "{safe}";'


async def render_booklet_pdf(
    base_url: str, key: str, out_path: Path, access_token: str | None = None
) -> None:
    url = f"{base_url}/t/{key}/booklet"
    last_error: Exception | None = None

    # page.pdf() writes progressively — render to a private sibling and swap
    # into place atomically, so no reader ever observes a truncated file.
    out_path = Path(out_path)
    tmp_path = out_path.with_suffix(out_path.suffix + ".part")

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
                    # Flag + token must be set before the SPA loads so it skips
                    # Auth0 entirely and mounts MapLibre eagerly (observer bypass).
                    await page.add_init_script(_PDF_RENDER_FLAG)
                    await page.add_init_script(_token_init_script(access_token))

                    # The SPA may legitimately send its bearer token to /api/*,
                    # but no third-party origin (tiles.openfreemap.org, fonts,
                    # DEM host) has any business seeing it. Route on the page
                    # level: drop the header for every cross-origin request.
                    base_origin = "http://" + url.split("/", 3)[2]
                    await page.route(
                        "**/*",
                        lambda route: route.continue_(
                            headers=(
                                {
                                    k: v
                                    for k, v in route.request.headers.items()
                                    if k.lower() != "authorization"
                                }
                                if not route.request.url.startswith(base_origin)
                                else None
                            )
                        ),
                    )

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
                        path=str(tmp_path),
                        prefer_css_page_size=True,
                        print_background=True,
                    )
                finally:
                    await browser.close()
            os.replace(tmp_path, out_path)
            return
        except Exception:
            # Render error after successful browser launch (TimeoutError,
            # navigation failure, etc.) — propagate as-is instead of masking
            # it with the fallback path's "Executable doesn't exist".
            tmp_path.unlink(missing_ok=True)
            raise

    raise last_error or RuntimeError("No usable Playwright browser found")
