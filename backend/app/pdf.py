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
its UI auth gate in that mode and uses the injected credential for its API
calls. The token is injected via ``add_init_script`` — NOT via the SPA-shell
``<script>`` replace: that path depends on the loopback navigation carrying
an Authorization header, and if it ever doesn't, the SPA falls into
``getAccessTokenSilently()``, whose Auth0 iframe can never complete in a
headless browser. The render then hangs with no API call at all and dies at
the booklet-content timeout (the nondeterministic first-click failure).
The init-script injection is unconditional and cannot fail silently.

Two credential shapes reach this page, and BOTH must be injected (#389):
a bearer token (the UI's "Download PDF", forwarded as
``window.__KISEKI_ACCESS_TOKEN__``) and an admin API key + act-as sub (the
content agent's ``api_write.py``, which has no bearer token at all) forwarded
as ``window.__KISEKI_API_KEY__`` / ``window.__KISEKI_ACT_AS_SUB__`` — the same
page-global seam the browser probes use (``frontend/src/lib/auth-headers.ts``).
Without the key pair a private trip's booklet render fetches the trip
anonymously, gets 401, never mounts the booklet content, and dies at the
booklet-content timeout — a 500 that names nothing.

The renderer also strips the credential headers (Authorization, X-API-Key,
X-Act-As-Sub) from every third-party request (tiles.openfreemap.org, fonts,
DEM) — the SPA's own API fetches keep theirs, but nothing the page loads from
another origin sees the caller's credential.

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


def _js_string(value: str | None) -> str:
    """A JS string literal for ``value`` — always a string, never undefined."""
    safe = (value or "").replace("\\", "\\\\").replace('"', '\\"')
    return f'"{safe}"'


def _token_init_script(access_token: str | None) -> str:
    """Inject the access token as a page global BEFORE any app script runs.

    Injected unconditionally (empty string when absent) so TripLayout's
    ``window.__KISEKI_ACCESS_TOKEN__ ?? getAccessTokenSilently()`` can never
    fall into the Auth0 SDK in a headless browser — an iframe flow that
    cannot complete there and hangs the whole render (#58 follow-up).
    """
    return f"window.__KISEKI_ACCESS_TOKEN__ = {_js_string(access_token)};"


def _api_key_init_script(api_key: str | None, act_as_sub: str | None = None) -> str:
    """Inject the admin API key + act-as sub as page globals (#389).

    The content agent has no bearer token: it authenticates with ``X-API-Key``
    + a mandatory ``X-Act-As-Sub`` (#324). The headless page must present the
    SAME credential, or a PRIVATE trip's booklet fetch goes out anonymous and
    401s — the SPA then never reaches its booklet-ready marker and the render
    dies at the content timeout with a 500 that names nothing.

    Empty when no key was presented (the bearer path, or a public trip):
    ``authHeaders()`` treats a falsy global as absent and falls back to the
    bearer token, so a public render stays exactly as anonymous as before.
    """
    if not api_key:
        return ""
    return (
        f"window.__KISEKI_API_KEY__ = {_js_string(api_key)};"
        f"window.__KISEKI_ACT_AS_SUB__ = {_js_string(act_as_sub)};"
    )


def _credential_init_scripts(
    access_token: str | None,
    api_key: str | None = None,
    act_as_sub: str | None = None,
) -> list[str]:
    """The page globals for whichever credential the caller presented.

    The token global is ALWAYS set (see ``_token_init_script``); the key pair
    rides on top when the caller is an API-key client. Both are plain strings
    with no interpolation of untrusted structure — the values are escaped by
    ``_js_string``.
    """
    scripts = [_token_init_script(access_token)]
    key_script = _api_key_init_script(api_key, act_as_sub)
    if key_script:
        scripts.append(key_script)
    return scripts


# The credential headers the renderer must never let a third-party origin see.
_CREDENTIAL_HEADERS = frozenset({"authorization", "x-api-key", "x-act-as-sub"})


async def render_booklet_pdf(
    base_url: str,
    key: str,
    out_path: Path,
    access_token: str | None = None,
    api_key: str | None = None,
    act_as_sub: str | None = None,
) -> None:
    """Render one trip's booklet to ``out_path``.

    ``access_token`` / ``api_key``+``act_as_sub`` are the caller's credential
    as the endpoint received it — exactly one shape is forwarded into the page
    (see ``_credential_init_scripts``), because the SPA's own trip fetch is
    what needs it.
    """
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
                    # A4 portrait at 96 CSS dpi (210×297mm) minus the @page
                    # margins (12mm sides). The print content column measures
                    # 531pt = 708px in the generated PDF, so the viewport is set
                    # to exactly that width BEFORE navigation: the SPA mounts
                    # its MapLibre maps eagerly during goto, and each map fits
                    # its camera (fitBounds) to the container size it measures
                    # at mount. If the viewport is wider than the print content
                    # box (e.g. the Playwright default 1280px, or a full A4
                    # 794px viewport), maps fit a container that page.pdf()
                    # later shrinks to the content column — the canvas does not
                    # follow the re-layout and the wider map gets clipped,
                    # cropping route ends and edge markers off-frame (#37; seen
                    # on the road-trip loop map, where markers ①/② sat outside
                    # the visible area).
                    page = await browser.new_page(
                        viewport={"width": 708, "height": 1123}
                    )
                    # Flag + credential must be set before the SPA loads so it
                    # skips Auth0 entirely and mounts MapLibre eagerly
                    # (observer bypass).
                    await page.add_init_script(_PDF_RENDER_FLAG)
                    for script in _credential_init_scripts(
                        access_token, api_key, act_as_sub
                    ):
                        await page.add_init_script(script)

                    # The SPA may legitimately send its credential to /api/*,
                    # but no third-party origin (tiles.openfreemap.org, fonts,
                    # DEM host) has any business seeing it. Route on the page
                    # level: drop the credential headers for every cross-origin
                    # request.
                    base_origin = "http://" + url.split("/", 3)[2]
                    await page.route(
                        "**/*",
                        lambda route: route.continue_(
                            headers=(
                                {
                                    k: v
                                    for k, v in route.request.headers.items()
                                    if k.lower() not in _CREDENTIAL_HEADERS
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
                    # Invariant with lazy per-preset fonts (#40 D5): this await
                    # is correct only because it runs AFTER the booklet content
                    # (above) renders — TripProvider's font effect fires with
                    # the trip, so the preset's families are requested before
                    # fonts.ready is observed. A fonts.ready awaited before the
                    # CSS asked for the family would resolve early and print
                    # the fallback stack with no error anywhere.
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
