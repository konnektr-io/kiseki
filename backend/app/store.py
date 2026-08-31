"""Trip store — reads trips from the graph (P1) with trip.json fallback (P0).

Source of truth is now Konnektr Graph when configured (``KISEKI_GRAPH_URL`` +
``KISEKI_GRAPH_TOKEN``). The baked ``trip.json`` files remain the fallback for
first boot and graceful degradation, so the swap is invisible to the frontend
(``GET /api/trips/{token}`` keeps its P0 contract).

Read flow for a token:
  1. graph enabled? query Trip twins for ``token`` → get the Trip ``$dtId``
  2. walk the subgraph → ADT twin/relationship bundle (source-agnostic shape)
  3. ``graph_to_trip`` rebuilds the ``Trip`` model
  4. on any failure, fall back to the trip.json file
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .config import TRIPS_DIR
from .models import Trip

_GRAPH_CLIENT = None
_GRAPH_CLIENT_READY = False


def _graph_client():
    """Lazily build (and cache) the graph read client; None if not configured."""
    global _GRAPH_CLIENT, _GRAPH_CLIENT_READY
    if _GRAPH_CLIENT_READY:
        return _GRAPH_CLIENT
    _GRAPH_CLIENT_READY = True
    try:
        from .graph.client import GraphReadClient

        c = GraphReadClient()
        _GRAPH_CLIENT = c if c.is_enabled() else None
    except Exception:  # pragma: no cover - defensive
        _GRAPH_CLIENT = None
    return _GRAPH_CLIENT


def load_trips() -> list[Trip]:
    """Read every trip.json file from the trips directory (P0 source / fallback).

    Simple and intentionally dumb: one file per trip, re-read on every call so
    content updates are immediate. Trip files are tiny; this keeps content
    updates immediate (no cache invalidation).
    """
    trips: list[Trip] = []
    if not TRIPS_DIR.is_dir():
        return trips
    for d in sorted(p for p in TRIPS_DIR.iterdir() if p.is_dir()):
        f = d / "trip.json"
        if f.is_file():
            try:
                trips.append(Trip.model_validate_json(f.read_text(encoding="utf-8")))
            except Exception as exc:  # keep the app up if one trip file is broken
                print(f"[kiseki] skipping broken trip file {f}: {exc}")
    return trips


def get_trip_by_token(token: str) -> Trip | None:
    # P1: read from the graph when configured, falling back to trip.json.
    client = _graph_client()
    if client is not None:
        try:
            dtid = client.find_trip_dtid_by_token(token)
            if dtid:
                graph = client.fetch_graph(dtid)
                if graph:
                    from .graph.convert import graph_to_trip

                    return graph_to_trip(graph)
        except Exception as exc:
            print(f"[kiseki] graph read for token {token!r} failed, falling back: {exc}")
    # Fallback: baked trip.json files.
    for t in load_trips():
        if t.token == token:
            return t
    return None


def get_trip_by_slug(slug: str) -> Trip | None:
    for t in load_trips():
        if t.slug == slug:
            return t
    return None


def seed_from_baked_data(baked_dir: Path) -> None:
    """Copy the baked-in seed trips into the live trips dir on first boot.

    The container image ships a seed copy (backend/data/trips) so a fresh PVC
    starts with content; afterwards the PVC wins so content updates never
    require an image rebuild.
    """
    if not baked_dir.is_dir() or baked_dir.resolve() == TRIPS_DIR.resolve():
        return
    if TRIPS_DIR.is_dir() and any(TRIPS_DIR.iterdir()):
        return
    TRIPS_DIR.mkdir(parents=True, exist_ok=True)
    for d in baked_dir.iterdir():
        if d.is_dir():
            shutil.copytree(d, TRIPS_DIR / d.name, dirs_exist_ok=True)
            print(f"[kiseki] seeded trip {d.name} into {TRIPS_DIR}")
