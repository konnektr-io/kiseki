# Deployment

Kiseki deploys as **one container**: the FastAPI backend serves the API, the built SPA and the
Playwright-rendered booklets. Content lives in the graph, so updating a trip is a data change — not a
deployment. Most deploys exist only to change code.

## The image

`deployments/docker/Dockerfile` is a two-stage build:

1. **Frontend stage** — `node:22-alpine`, pnpm 11, `pnpm build` → `dist/`.
2. **Runtime stage** — `python:3.13-slim`, installs the backend package, then
   `playwright install --with-deps chromium` (the booklet renderer), copies the built SPA into the
   image at `/app/app/static` (the backend's default `KISEKI_STATIC_DIR`, i.e. `app/static` inside the
   package), creates a non-root user (UID 1001, to match a `runAsUser: 1001` security context) and runs
   `uvicorn app.main:app --host 0.0.0.0 --port 8000`.

The container therefore contains a headless Chromium — that is required, not incidental: without it
`/api/trips/{id}/booklet.pdf` cannot render. Nothing else needs a browser.

Built by GitHub Actions and published to **`ghcr.io/konnektr-io/kiseki`**, tagged with:

| Trigger | Tags |
|---|---|
| push to `main` | `main`, `latest` |
| tag `v*` | `vX.Y.Z`, `vX.Y`, `vX` |
| pull request | `pr-<n>` (build only — never pushed) |

```bash
docker run --rm -p 8000:8000 \
  -e KISEKI_GRAPH_URL=… -e KISEKI_GRAPH_TOKEN=… \
  ghcr.io/konnektr-io/kiseki:latest
```

`GET /api/health` is the liveness endpoint.

## Configuration

All configuration is environment-driven (`backend/app/config.py`). Only two kinds of value are ever
browser-visible — the Auth0 domain/SPA client id and the PostHog ingest key — and both are public by
design; every service key stays server-side.

| Variable | Required for | Notes |
|---|---|---|
| `KISEKI_GRAPH_URL`, `KISEKI_GRAPH_TOKEN` | Real trips | Unset → the app serves the committed anonymised samples. Point at the in-cluster graph API service. |
| `KISEKI_S3_ENDPOINT`, `KISEKI_S3_BUCKET`, `KISEKI_S3_ACCESS_KEY`, `KISEKI_S3_SECRET_KEY` | Trip media | With these four set → S3/Garage store; otherwise a local `data/assets` dir is used if it exists (dev). `KISEKI_S3_REGION` defaults to `us-east-1`. The bucket is private; `/media/...` is the only reader. |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE` | Login | `AUTH0_AUDIENCE` must match an API identifier in the tenant, or the issued token is a JWE the backend cannot verify. The frontend mirrors all three via `VITE_AUTH0_*` at build time. |
| `KISEKI_ASSETS_DIR`, `KISEKI_STATIC_DIR`, `KISEKI_TRIPS_DIR` | Local paths | Where a local media dir, the built SPA and the authoring `trip.json` files live. |
| `GOOGLE_PLACES_URL`, `HERE_ROUTES_URL`, `HERE_TOKEN_ENDPOINT_URL` | Overrides | Point the external integrations at a test double; the defaults are the real endpoints. |
| `HERE_ACCESS_KEY_ID`, `HERE_ACCESS_KEY_SECRET` | Driving routes + live drive times | Unset → legs render without route geometry. |
| `GOOGLE_MAPS_API_KEY` | Place ratings/reviews/photos | Never sent to the browser; all access goes through `/api/places/*` (Google compliance: only storable fields are ever persisted). |
| `KISEKI_HERMES_URL`, `KISEKI_HERMES_KEY` | The chat agent | Unset → `/api/chat` returns 503. |
| `KISEKI_AGENT_CLIENT_ID`, `KISEKI_AGENT_ACT_AS` | Sanctioned agent machine-to-machine access | The agent never becomes a graph identity; it acts as a real user (interim single-user pin) or as an owner-level service principal. |
| `KISEKI_API_KEYS` | Admin API keys (#324) | `name:sha256hex` pairs, comma-separated (only the digest is deployed; the plaintext lives in the agent profile `.env`s). Presented as `X-API-Key` with mandatory per-request `X-Act-As-Sub` — quota-free, so agents never touch Auth0's metered M2M grants. Empty → no API-key auth. |
| `KISEKI_LISTEN_PORT`, `KISEKI_STATIC_DIR` | Runtime | Port (default 8000) and where the built SPA lives (default `app/static`). |
| `KISEKI_TRICOUNT_CREDS_FILE`, `KISEKI_TRICOUNT_TTL` | TriCount expenses | Credentials are a public app id + RSA public key; a file pins a stable installation across restarts. |
| `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | Analytics | Build-time only; analytics is a no-op with an empty key. |

The `*_PORT` naming matters: don't rename `KISEKI_LISTEN_PORT` — Kubernetes injects
`<SERVICE>_PORT` variables for a service named `kiseki`, which would collide with a plain `PORT`.

## Operating notes

- **Content is not in the image.** Publishing trips, changing days or adding crew never requires a
  build or a restart — it is a graph write through the write API.
- **Media is not in the image either.** Trip media lives in object storage and is streamed through the
  app's `/media/<trip-id>/<file>` route, addressed by the trip's durable id plus the filename recorded
  in the trip document (a crew-level media ACL is the planned plug-in point, [#64]).
- **Statically verified auth.** Tokens are validated against the Auth0 tenant JWKS; there is no
  session store, so the app scales horizontally with no shared state.
- **Rendering is the heavy part.** Booklet PDFs spin a headless browser per request; if you deploy
  under a tight memory limit, that is the workload to watch.
- **Secrets in Kubernetes** (as the reference deployment does it) are plain secret objects mounted as
  environment variables: graph credentials, S3 keys, HERE, Google Places, the agent key and the
  Auth0 client.
- **After a graph-model change**, run the DTDL conformance check before believing the deploy —
  see [post-deploy-dtdl-check.md](post-deploy-dtdl-check.md).

## Reference deployment

The author runs Kiseki on a home Kubernetes cluster behind Envoy Gateway with a TLS certificate for
`*.konnektr.io`, at <https://kiseki.konnektr.io>. Cluster manifests are not part of this repository;
everything they need to set is the configuration table above. Any environment that can run a
container and reach a graph instance and an S3-compatible bucket can host Kiseki.

## Releases

`backend/scripts/release.sh` cuts a release: it tags, writes the notes and records the release, and
includes the post-deploy DTDL check. Releasing is deliberately boring — a tag builds and publishes the
image, and nothing about trip content is involved.
