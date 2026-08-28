"""Playwright-based PDF booklet rendering.

Renders the SPA's print-optimised /t/<token>/booklet route to an A4 PDF.
The route does its own data fetching, so the PDF always reflects live content.

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


def _browser_path_candidates() -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if configured:
        candidates.append(Path(configured))
    candidates.append(Path.home() / ".cache" / "ms-playwright")
    return candidates


async def render_booklet_pdf(base_url: str, token: str, out_path: Path) -> None:
    url = f"{base_url}/t/{token}/booklet"
    last_error: Exception | None = None

    for candidates_dir in _browser_path_candidates():
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(candidates_dir)
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(args=["--no-sandbox"])
                try:
                    page = await browser.new_page()
                    await page.goto(url, wait_until="networkidle", timeout=60_000)
                    await page.pdf(path=str(out_path), format="A4", print_background=True)
                finally:
                    await browser.close()
            return
        except Exception as exc:  # wrong revision / missing browser → try next
            last_error = exc

    raise last_error or RuntimeError("No usable Playwright browser found")
