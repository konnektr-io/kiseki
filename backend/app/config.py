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

# Auth0 — SPA access-token validation for /api/auth/me (and future ACL checks).
# Domain + client id are public (the SPA ships them), so defaults are baked in
# like the frontend; override via env. AUTH0_AUDIENCE is optional: when the
# tenant exposes a custom API, set it to that audience; otherwise tokens are
# issued for the client itself (aud = client id).
AUTH0_DOMAIN = os.environ.get("AUTH0_DOMAIN", "dev-zv5urb33g0msy7bc.eu.auth0.com")
AUTH0_CLIENT_ID = os.environ.get("AUTH0_CLIENT_ID", "jbMyX3scNHkECOF1lNJTOovXe8fOBmiq")
AUTH0_AUDIENCE = os.environ.get("AUTH0_AUDIENCE", "")

# Konnektr Graph (P1 source of truth, issue #4). When BOTH are set the backend
# serves trips from the graph; otherwise it falls back to baked trip.json files
# (graceful first boot / zero-downtime rollout). Point these at the in-cluster
# `graph-cluster-app` service (e.g. http://graph-cluster-app.kiseki.svc.cluster.local:8080).
KISEKI_GRAPH_URL = os.environ.get("KISEKI_GRAPH_URL", "")
KISEKI_GRAPH_TOKEN = os.environ.get("KISEKI_GRAPH_TOKEN", "")
