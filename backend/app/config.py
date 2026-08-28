"""Kiseki backend configuration.

All paths are overridable via env vars so the container can point at a
PVC-mounted data dir while local dev uses the repo's `backend/data`.
"""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

# Where trip.json files live. In the container this is /data/trips (PVC);
# locally it is backend/data/trips.
TRIPS_DIR = Path(os.environ.get("KISEKI_TRIPS_DIR", BACKEND_DIR / "data" / "trips"))

# Trip media (covers, gallery images), served under /media/<trip>/<file>.
ASSETS_DIR = Path(os.environ.get("KISEKI_ASSETS_DIR", BACKEND_DIR / "data" / "assets"))

# Built SPA (frontend/dist copied here by the Dockerfile or manually).
STATIC_DIR = Path(os.environ.get("KISEKI_STATIC_DIR", Path(__file__).resolve().parent / "static"))

# Google Maps — dynamic JS map (served to the private SPA) + static map proxy (PDF/print).
# Set in the container via the kiseki-maps secret; absent → maps simply don't render.
MAPS_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")

# Port the app listens on (used to build the base URL for Playwright).
# NOTE: deliberately NOT named KISEKI_PORT — Kubernetes injects
# <SERVICE_NAME>_PORT (e.g. KISEKI_PORT=tcp://10.x.x.x:8000) into pods for a
# Service named "kiseki", which collides with a plain-number env var.
LISTEN_PORT = int(os.environ.get("KISEKI_LISTEN_PORT", "8000"))
