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
import urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from .config import ASSETS_DIR, LISTEN_PORT, MAPS_KEY, STATIC_DIR
from .maps import build_static_map_url, directions_polyline, resolve_places
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


@app.get("/api/maps/key")
def maps_key() -> dict:
    """JS Maps API key for the private SPA (restrict by referrer in Cloud Console)."""
    return {"key": MAPS_KEY}


@app.get("/api/maps/static/{token}")
def maps_static(
    token: str,
    places: str = Query(..., description="comma-separated place names"),
    loop: int = Query(0, description="1 = close the loop back to the first place"),
) -> Response:
    """Static map proxy: real driving route (Directions API, key stays server-side)
    rendered as an encoded polyline + numbered markers. Used by the booklet PDF."""
    trip = get_trip_by_token(token)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    if not MAPS_KEY:
        raise HTTPException(status_code=404, detail="Maps not configured")
    resolved = resolve_places(trip, [p for p in places.split(",") if p.strip()])
    if len(resolved) < 2:
        raise HTTPException(status_code=404, detail="Need at least two resolvable places")
    polyline = directions_polyline(resolved, MAPS_KEY, loop=bool(loop))
    # route color = trip theme (theme.primary is a hex like #1e3a8a → 0x1e3a8a)
    path_color = "0x" + (trip.theme.primary or "1e3a8a").lstrip("#")
    url = build_static_map_url(resolved, MAPS_KEY, polyline=polyline, loop=bool(loop), path_color=path_color)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            body = resp.read()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Static map fetch failed: {exc}") from exc
    return Response(
        content=body,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
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
