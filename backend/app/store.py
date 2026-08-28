"""Trip store — reads trip.json files from the trips directory.

Simple and intentionally dumb: one file per trip, re-read on every request.
Trip files are tiny; this keeps content updates immediate (no cache invalidation).
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .config import TRIPS_DIR
from .models import Trip


def load_trips() -> list[Trip]:
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
