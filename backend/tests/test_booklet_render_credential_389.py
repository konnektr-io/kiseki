"""The booklet renderer's credential injection (issue #389).

`GET /api/trips/<id>/booklet.pdf` gates the DOWNLOAD, but the headless page
fetches the trip document itself. Only a bearer token was forwarded into that
page, so the content agent (admin API key + act-as, issue #324 — no bearer
token at all) got a 500 on every private trip: the SPA's own trip fetch went
out anonymous, 401'd, the booklet-ready marker never appeared, and the render
died at the 30s content timeout. Live evidence: two `401` lines from 127.0.0.1
for `/api/trips/<id>` inside a single render, then `booklet.pdf → 500`.

These tests pin the page globals (the seam the SPA reads in
`frontend/src/lib/auth-headers.ts`) and the cross-origin strip that keeps the
credential away from third-party tile/font/DEM hosts.
"""

from __future__ import annotations

import inspect

from app import pdf


def test_api_key_globals_are_injected_for_an_api_key_caller() -> None:
    script = pdf._api_key_init_script("ksk_admin", "google-oauth2|42")

    assert 'window.__KISEKI_API_KEY__ = "ksk_admin";' in script
    assert 'window.__KISEKI_ACT_AS_SUB__ = "google-oauth2|42";' in script


def test_no_api_key_means_no_globals() -> None:
    """A bearer caller (or a public render) must not gain a key global — an
    empty one would still switch `authHeaders()` onto the key branch."""
    assert pdf._api_key_init_script(None) == ""
    assert pdf._api_key_init_script("") == ""
    assert pdf._credential_init_scripts(None) == [pdf._token_init_script(None)]


def test_the_token_global_is_always_set() -> None:
    """#58 invariant, kept for API-key callers: an unset token global sends the
    SPA into `getAccessTokenSilently()`, whose Auth0 iframe can never complete
    headless — the render hangs with no API call at all."""
    scripts = pdf._credential_init_scripts(None, "ksk_admin", "google-oauth2|42")

    assert scripts[0] == 'window.__KISEKI_ACCESS_TOKEN__ = "";'
    assert len(scripts) == 2


def test_both_credentials_ride_one_page_when_a_bearer_is_present() -> None:
    scripts = pdf._credential_init_scripts("user-token", "ksk_admin", "google-oauth2|42")

    assert 'window.__KISEKI_ACCESS_TOKEN__ = "user-token";' in scripts[0]
    assert "ksk_admin" in scripts[1]


def test_quotes_and_backslashes_are_escaped() -> None:
    """The globals are built by string interpolation — a value that could close
    the literal would inject arbitrary JS into a page holding a live session."""
    script = pdf._api_key_init_script('ksk_"; alert(1); //', "sub\\with\\slashes")

    assert '\\"' in script
    assert "alert(1)" in script  # present, but inside the literal
    assert 'window.__KISEKI_API_KEY__ = "ksk_\\"; alert(1); //";' in script
    assert '"sub\\\\with\\\\slashes"' in script


def test_credential_headers_are_stripped_cross_origin() -> None:
    assert pdf._CREDENTIAL_HEADERS == frozenset(
        {"authorization", "x-api-key", "x-act-as-sub"}
    )


def test_render_accepts_the_credential_pair() -> None:
    params = inspect.signature(pdf.render_booklet_pdf).parameters

    assert list(params)[:3] == ["base_url", "key", "out_path"]
    for name in ("access_token", "api_key", "act_as_sub"):
        assert params[name].default is None  # backwards-compatible call shape
