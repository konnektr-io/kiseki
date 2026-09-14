"""Tests for the canonical Google Maps deep-link helper (issues #15, #95).

The helper builds keyless ``maps/search`` URLs — no API client, no fetch,
no photo/review hotlinking. The frontend mirror (``src/lib/gmaps.ts``) pins
the same contract in ``gmaps.test.ts``; both must produce the same URL for
the same inputs.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.maps_links import gmaps_url  # noqa: E402


def _params(url: str) -> dict:
    assert url.startswith("https://www.google.com/maps/search/?")
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def test_name_only() -> None:
    p = _params(gmaps_url("Niseko, Japan"))
    assert p == {"api": "1", "query": "Niseko, Japan"}


def test_place_id_takes_precedence() -> None:
    p = _params(gmaps_url("Niseko", place_id="ChIJN1t_tDeuEmsRUsoyG83frY4"))
    assert p["query"] == "Niseko"
    assert p["query_place_id"] == "ChIJN1t_tDeuEmsRUsoyG83frY4"


def test_no_free_text_venue_query_branch() -> None:
    """#220 P2: a venue is named by its ``place_id`` only. The old free-text
    ``query=`` override (``Block.mapsQuery``) is gone for good, so a stale
    caller fails loudly instead of silently shipping a bad link."""
    with pytest.raises(TypeError):
        gmaps_url("Niseko", query="Park Hyatt Niseko Hanazono")  # type: ignore[call-arg]


def test_special_chars_are_encoded() -> None:
    url = gmaps_url("A&B / C")
    assert "A&B" not in url  # raw separator must not leak into the query string
    assert _params(url)["query"] == "A&B / C"
