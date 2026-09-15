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

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import STATIC_DIR
from app.main import app

client = TestClient(app)

# The shell's empty root: what every SPA route except "/" serves, and what "/"
# must NOT — the landing is prerendered into that element (see `main.py`).
EMPTY_ROOT = '<div id="root"></div>'


def _require_shell() -> None:
    """Refuse to run without the built SPA.

    Locally a missing build is acceptable (skip — a bare checkout has no ``dist/``).
    In CI it is a hard failure: the workflow must point ``KISEKI_STATIC_DIR`` at
    ``frontend/dist``, otherwise the history-mode catch-all is never registered and
    every test below silently proves nothing. That is exactly how the v0.29.0 deep-link
    404 shipped with a green release run (453 passed, 2 skipped).
    """
    if (STATIC_DIR / "index.html").is_file():
        return
    msg = (
        "built SPA not present — build frontend/ or set KISEKI_STATIC_DIR "
        f"(STATIC_DIR={STATIC_DIR})"
    )
    if os.environ.get("CI"):
        pytest.fail(f"{msg} — refusing to skip in CI: this test would prove nothing")
    pytest.skip(msg)


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


def test_feed_deep_link_serves_the_spa_shell() -> None:
    """#199's /feed joined the whitelist in App.tsx — and here.

    Same trap as phase D: an in-app link to the feed would work while a reload
    or a bookmark 404s with the API's JSON.
    """
    _require_shell()
    _assert_shell(client.get("/feed"))


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


def test_missing_shell_is_fatal_in_ci(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guard itself is under test: in CI a missing shell must FAIL, not skip.

    Without this, the guard could rot back into a silent skip and nobody would
    notice — which is the exact failure mode it exists to prevent.
    """
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(sys.modules[__name__], "STATIC_DIR", Path("/nonexistent-spa-dir"))
    with pytest.raises(pytest.fail.Exception):
        _require_shell()


def test_missing_shell_still_skips_locally(monkeypatch: pytest.MonkeyPatch) -> None:
    """Off CI the same missing shell is a skip — a bare checkout stays runnable."""
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setattr(sys.modules[__name__], "STATIC_DIR", Path("/nonexistent-spa-dir"))
    with pytest.raises(pytest.skip.Exception):
        _require_shell()


def test_root_serves_the_prerendered_landing_and_no_other_route_does() -> None:
    """"/" ships the landing's copy inside the shell; nobody else does (#249, E4).

    The prerendered head has to be where a crawler — or a visitor whose bundle has
    not run yet — lands, and it must be ONLY there: every other SPA route paints a
    different document, and inheriting the marketing copy would flash the wrong page
    before the app takes over.
    """
    _require_shell()
    if not (STATIC_DIR / "landing.html").is_file():
        msg = (
            f"no prerendered landing.html in {STATIC_DIR} — the frontend build has to "
            "run scripts/prerender.mjs (it is part of `pnpm build`)"
        )
        if os.environ.get("CI"):
            pytest.fail(f"{msg} — refusing to skip in CI: this test would prove nothing")
        pytest.skip(msg)

    root = client.get("/")
    assert root.status_code == 200
    # The contract is STRUCTURAL, not copy. This test used to assert the landing's
    # headline text, so a frontend copy rewrite broke a backend test (it did, on the
    # demo-trips rewrite) — the assertion was pinned to the one thing this layer does
    # not own. What "/" promises is a shell that arrives with content already inside
    # #root; every other route promises an empty one.
    assert EMPTY_ROOT not in root.text, "the prerendered landing was not injected"
    assert '<div id="root"><' in root.text

    for path in ("/t/abc", "/me", "/feed", "/u/google-oauth2%7C1"):
        other = client.get(path)
        assert other.status_code == 200, path
        assert EMPTY_ROOT in other.text, f"{path} was served the prerendered landing"
