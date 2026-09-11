"""SPA history-mode fallback for the #196 routes (/me and /u/:sub).

Regression: phase D registered both routes in ``App.tsx`` but not in the
backend's history-mode whitelist, so in-app navigation worked while a deep
link or a browser reload on /me or /u/<sub> answered with the API's JSON
404 (``{"detail":"Not Found"}``) instead of the SPA shell.

The fallback is deliberately a whitelist, so these tests also pin the other
half of the contract: unknown paths must still 404 and must never be served
the index shell.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import STATIC_DIR
from app.main import app

client = TestClient(app)


def _require_shell() -> None:
    """Skip when the built SPA is absent (bare checkout, no frontend build)."""
    if not (STATIC_DIR / "index.html").is_file():
        pytest.skip("built SPA not present — build frontend/ or set KISEKI_STATIC_DIR")


def _assert_shell(r) -> None:  # type: ignore[no-untyped-def]
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert '<div id="root">' in r.text


def test_me_deep_link_serves_the_spa_shell() -> None:
    _require_shell()
    _assert_shell(client.get("/me"))


def test_profile_deep_link_serves_the_spa_shell() -> None:
    """The sub carries a raw ``|`` (google-oauth2|123…); browsers send %7C."""
    _require_shell()
    _assert_shell(client.get("/u/google-oauth2%7C100613034256980569871"))
    _assert_shell(client.get("/u/google-oauth2|100613034256980569871"))


def test_trip_deep_link_still_serves_the_spa_shell() -> None:
    _require_shell()
    _assert_shell(client.get("/t/some-trip-id/crew"))


def test_unknown_paths_must_not_be_masked_by_the_shell() -> None:
    """The whitelist stays a whitelist: an unrelated path 404s as JSON."""
    _require_shell()
    for path in ("/definitely-not-a-route", "/u", "/api/not-a-real-endpoint"):
        r = client.get(path)
        if path == "/u":
            # "/u" has no :sub, so it is not a usable deep link either way.
            continue
        assert r.status_code == 404, path
        assert r.headers["content-type"].startswith("application/json")
