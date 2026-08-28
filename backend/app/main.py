"""Kiseki API + SPA server.

One process, one container:
  - /api/health, /api/trips/<token>, /api/trips/<token>/booklet.pdf
  - /media/**        → trip images (backend/data/assets)
  - everything else  → the built React SPA (backend/app/static) with
                       history-mode fallback to index.html
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from .config import ASSETS_DIR, LISTEN_PORT, STATIC_DIR
from .models import Trip
from .pdf import render_booklet_pdf
from .store import get_trip_by_token, seed_from_baked_data

app = FastAPI(title="Kiseki", version="0.1.0")

# Seed live trips from the baked-in copy on first boot (PVC may be empty).
_baked_seed = Path(__file__).resolve().parent.parent / "data" / "trips"
seed_from_baked_data(_baked_seed)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/trips/{token}")
def get_trip(token: str) -> dict:
    trip = get_trip_by_token(token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip.model_dump(by_alias=True)


@app.get("/api/trips/{token}/booklet.pdf")
async def booklet_pdf(token: str) -> FileResponse:
    trip = get_trip_by_token(token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    base_url = f"http://127.0.0.1:{LISTEN_PORT}"
    try:
        await render_booklet_pdf(base_url, token, Path(path))
    except Exception as exc:
        Path(path).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"PDF rendering failed: {exc}") from exc
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{trip.slug}-booklet.pdf",
        background=BackgroundTask(lambda: Path(path).unlink(missing_ok=True)),
    )


# Trip media (covers, gallery images) — referenced as /media/<trip>/<file>
if ASSETS_DIR.is_dir():
    app.mount("/media", StaticFiles(directory=ASSETS_DIR), name="media")

# Built SPA with history-mode fallback
if STATIC_DIR.is_dir() and (STATIC_DIR / "index.html").is_file():
    _index = STATIC_DIR / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and STATIC_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(_index)
