"""Kiseki backend configuration.

All paths are overridable via env vars so the container can point at a
PVC-mounted data dir while local dev uses the repo's `backend/data`.
"""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

# Legacy scratch path for local authoring scripts (trip_to_graph.py,
# seed_graph.py, migrate_assets_to_s3.py). Not used by the app runtime —
# the graph is the only store. These files are git-ignored.
TRIPS_DIR = Path(os.environ.get("KISEKI_TRIPS_DIR", BACKEND_DIR / "data" / "trips"))

# Trip media (covers, gallery images), served under /media/<trip>/<file>.
# P0 legacy local assets dir (dev / old checkouts); repo assets removed (#47).
# The local store only activates when this dir exists AND S3 env is unset.
ASSETS_DIR = Path(os.environ.get("KISEKI_ASSETS_DIR", BACKEND_DIR / "data" / "assets"))

# P1 media backend — S3-compatible Garage object storage (issue #47).
# When all four are set, /media/<trip>/<file> streams from the bucket instead
# of the (now-removed) local assets dir. Bucket is private; this proxy is the
# only reader, so media inherits trip-level ACL (enforced here, expanded in #64).
# Mirrored into the pod via a Kubernetes Secret named `kiseki-s3` (home-k8s).
KISEKI_S3_ENDPOINT = os.environ.get("KISEKI_S3_ENDPOINT", "")
KISEKI_S3_BUCKET = os.environ.get("KISEKI_S3_BUCKET", "")
KISEKI_S3_ACCESS_KEY = os.environ.get("KISEKI_S3_ACCESS_KEY", "")
KISEKI_S3_SECRET_KEY = os.environ.get("KISEKI_S3_SECRET_KEY", "")
KISEKI_S3_REGION = os.environ.get("KISEKI_S3_REGION", "us-east-1")

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

# Auth0 — SPA access-token validation for /api/auth/me + ACLs (#5).
# Domain + client id are public (the SPA ships them); bake defaults like the
# frontend, override via env.
#
# AUTH0_AUDIENCE is REQUIRED for real use: Auth0 issues JWE-ENCRYPTED access
# tokens (alg: dir / A256GCM) to SPA clients when no audience is requested,
# and a JWE cannot be verified by the backend. The audience must match an API
# created in the tenant (identifier https://kiseki.konnektr.io/api) and the
# SPA's authorizationParams.audience (frontend/src/lib/auth.ts).
AUTH0_DOMAIN = os.environ.get("AUTH0_DOMAIN", "dev-zv5urb33g0msy7bc.eu.auth0.com")
AUTH0_CLIENT_ID = os.environ.get("AUTH0_CLIENT_ID", "jbMyX3scNHkECOF1lNJTOovXe8fOBmiq")
AUTH0_AUDIENCE = os.environ.get(
    "AUTH0_AUDIENCE", "https://kiseki.konnektr.io"
)

# Konnektr Graph (P1 source of truth, issue #4). The graph is the ONLY
# store for trips — there is no file fallback. The backend serves
# trips from the graph; without KISEKI_GRAPH_URL/KISEKI_GRAPH_TOKEN the
# read path returns 404/empty (tests inject a fake client). Point these
# at the in-cluster `graph-cluster-api` service.
KISEKI_GRAPH_URL = os.environ.get("KISEKI_GRAPH_URL", "")
KISEKI_GRAPH_TOKEN = os.environ.get("KISEKI_GRAPH_TOKEN", "")

# The sanctioned agent M2M client (issue #46 identity model). When set, a
# client_credentials token from this client resolves to an agent ACTOR:
#   - with KISEKI_AGENT_ACT_AS set (this Niko profile only — never the
#     dedicated end-user profile), the actor IS that user: ACL + x-user-id
#     are the user's own (their real crew role, never widened);
#   - without it, the actor is an OWNER-level service principal for
#     unattended changes that cannot be linked to a user.
# Either way NOTHING is provisioned in the graph — no User twin, no edge.
KISEKI_AGENT_CLIENT_ID = os.environ.get("KISEKI_AGENT_CLIENT_ID", "")
KISEKI_AGENT_ACT_AS = os.environ.get("KISEKI_AGENT_ACT_AS", "")

# TriCount (bunq) expense integration (issue #111). Tricount device
# credentials are NOT secrets (anonymous installation registration: an app
# GUID + an RSA *public* key — the private key never leaves the generator),
# so the service self-generates them per process. Point
# KISEKI_TRICOUNT_CREDS_FILE at a JSON file ({"app_id", "public_key_pem"})
# to pin a stable installation across restarts; snapshot reads are cached
# for KISEKI_TRICOUNT_TTL seconds to stay friendly to the bunq API.
KISEKI_TRICOUNT_CREDS_FILE = os.environ.get("KISEKI_TRICOUNT_CREDS_FILE", "")
KISEKI_TRICOUNT_TTL = int(os.environ.get("KISEKI_TRICOUNT_TTL", "600"))
