"""Canonical Google Maps deep links (issues #15, #95).

The deep-link form is a public Google URL spec — no API key, no fetch, no
photo/review hotlinking. It is mirrored 1:1 by
``frontend/src/lib/gmaps.ts``; both must produce the same URL for the same
inputs (pinned by ``tests/test_maps_links.py`` + ``gmaps.test.ts``).

Storage-rule context (#15 pivot): only ``place_id`` may be persisted
indefinitely. This helper never stores anything — it only builds the
keyless ``https://www.google.com/maps/search/?api=1`` URL at render time.
"""

from __future__ import annotations

from urllib.parse import urlencode

_GMAPS_SEARCH = "https://www.google.com/maps/search/"


def gmaps_url(name: str, *, place_id: str | None = None) -> str:
    """Build a keyless Google Maps search URL for a place.

    - ``place_id`` set → the Google-recommended deep-link form
      (``query=<name>&query_place_id=<id>``).
    - else → ``query=<name>``.

    There is deliberately no free-text venue-query branch: a block that names
    a specific venue carries its ``place_id`` (see #220 P2), so the link and
    the photos/reviews overlay can actually resolve it.
    """
    params: list[tuple[str, str]] = [("api", "1")]
    if place_id:
        params.append(("query", name))
        params.append(("query_place_id", place_id))
    else:
        params.append(("query", name))
    return f"{_GMAPS_SEARCH}?{urlencode(params)}"
