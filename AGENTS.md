# Kiseki — Agent Context

Kiseki (軌跡) — **the trip as a living, agent-maintained document.**

Product spec: [`docs/spec.md`](docs/spec.md) — **read it before large changes.**

## What this is

A private web app that renders "trip documents" — the travel booklets Niko and his agent build in chat (Canada 2027 heliski, Chile-Peru 2027, Japan 2028 …) — as a responsive, multi-page site with PDF booklet export. **Content is data (JSON), not code**: updating a trip never requires rebuilding the image.

- Domain: `kiseki.konnektr.io` (home k8s, Envoy Gateway, `*.konnektr.io` cert already exists)
- **Private repo** — trip data (incl. trip tokens) lives here. Never make it public.

## Stack & layout

| Path | What |
|---|---|
| `backend/` | FastAPI (Python 3.13, uv). Serves the built React app from `app/static`, trip JSON from `data/trips/`, PDF via Playwright. **Single container.** |
| `backend/data/trips/<slug>/trip.json` | **The content.** One file per trip. Edit these to update a trip. |
| `frontend/` | React 19 + Vite + TypeScript + Tailwind v4 (shadcn-style components via `class-variance-authority`). Read-only SPA. |
| `deployments/docker/Dockerfile` | Multi-stage: node build → python runtime (+ Playwright chromium). |
| `.github/workflows/build-image.yml` | Builds + pushes `ghcr.io/konnektr-io/kiseki` on main / tags / release. |
| `k8s/` | **Not in this repo** — deployment manifests live in the `home-k8s` repo under `konnektr/kiseki/`. |

## Commands

```bash
# Backend (uv)
cd backend && uv sync
uv run uvicorn app.main:app --reload --port 8000

# Frontend (pnpm)
cd frontend && pnpm install
pnpm dev            # Vite dev server, proxies /api → http://127.0.0.1:8000
pnpm build          # tsc (noEmit) && vite build → dist/

# Tests
cd backend && uv run pytest

# Local prod-like run (single process, like the container)
pnpm --dir frontend build
rm -rf backend/app/static && cp -r frontend/dist backend/app/static   # NOTE: replace, don't nest (cp -r src dst nests when dst exists!)
cd backend && uv run uvicorn app.main:app --port 8000
# → http://127.0.0.1:8000/t/<token>/  (token lives inside each backend/data/trips/<slug>/trip.json)
```

## Content update (deployed — no rebuild, no redeploy)

1. Edit `backend/data/trips/<slug>/trip.json` in this repo, commit + push (the repo is the versioned source of truth).
2. Copy to the cluster PVC:

   ```bash
   export KUBECONFIG=/opt/data/home/home-k8s/kubeconfig
   for d in backend/data/trips/*/; do
     kubectl -n kiseki cp "$d" "kiseki/$(basename "$d"):/data/trips/"
   done
   ```

3. The pod seeds `/data/trips` from the image on first boot **only if empty**; afterwards `/data/trips` wins. No image rebuild, no pod restart.

## Trip JSON schema

`backend/app/models.py` is authoritative. Summary:

- **Top level**: `slug`, `title`, `subtitle`, `stage` (`idea|options|shortlist|planned|booked|live|archive`), `startDate`, `endDate`, `token` (the secret share key — appears in URLs; rotate by editing the field), `cover` (image URL), `coverCredit`, `summary` (markdown), `theme` `{primary, accent, font}` (hex colors — UI uses CSS variables, never hardcoded hex), `crew` `[{name, role: owner|editor|viewer|follower, note}]`, `practical` `{todos: [{label, done}], links: [{label, url}], notes (markdown)}`, `days` `[{date (ISO), title, notes (markdown), blocks [...]}]`.
- **Block kinds — exactly these ten**: `activity`, `transport`, `lodging`, `meal`, `todo`, `note`, `gallery`, `link`, `booking`, `custom`.
  - Shared fields: `title`, `time`, `description` (markdown), `links` `[{label, url}]`, `cost` (number), `currency` (code), `status` (`planned|booked|done`), `bookingCode`, `order`.
  - `todo`: `items` `[{label, done}]` · `gallery`: `items` (image URLs) · `custom`: `html` (sanitized client-side).
- **Keep the model coarse.** Never invent a block kind without updating `models.py` + `frontend/src/components/blocks.tsx` + the spec. Stage drives the UI (badge, day highlights) — set it honestly per trip.

## Media / image storage (P0 → P1)

- **P0**: images live in `backend/data/assets/<trip>/` — next to the trip data, served by the FastAPI app at `/media/<trip>/<file>`. Reference them in `trip.json` with **relative URLs** (`/media/canada-2027/sths-hero-full.jpg`), never base64. The repo is private, so shipping images in git is fine at this stage.
- **P1 (graph backend)**: when trip content moves into Konnektr Graph, media moves **out of the repo** into object storage (MinIO on the home cluster, S3-compatible) and the graph stores the **URL as a string field**. Keep every image reference a plain URL in the data model — swapping the media backend then only changes the URL prefix, nothing else. (The `/media` mount disappears; the backend serves or redirects from the bucket.)

## Conventions / rules

- **Content-first**: prefer editing `trip.json` over touching code. Code changes → image rebuild (tag → release → CI → home-k8s manifest bump). Content changes → PVC copy only.
- **Tokens are secrets-in-effect**: private repo + private link. Never commit a token to a public place. Rotate by editing the field.
- Dates ISO (`YYYY-MM-DD`); costs = number + currency code; links always `{label, url}`.
- Markdown (GFM) allowed in `summary`, day `notes`, block `description`.
- The **booklet** is a print stylesheet in the frontend (`BookletPage`, A4). Keep it A4-friendly — it becomes the PDF.
- Tailwind v4 theme tokens are CSS variables in `frontend/src/index.css` (`@theme inline`); per-trip theming injects `--trip-*` vars at runtime. Colors always behind tokens.

## Deployment flow (home-k8s)

1. `git tag v0.x.y && git push origin v0.x.y` + `gh release create v0.x.y --repo konnektr-io/kiseki` (CI builds the image).
2. Verify the tag exists: `gh api "/orgs/konnektr-io/packages/container/kiseki/versions?per_page=5" --jq '.[].metadata.container.tags'`.
3. In `home-k8s`: edit `konnektr/kiseki/deployment.yaml` image tag (**no `v` prefix** — metadata-action strips it).
4. `kubectl apply` + `rollout status` (KUBECONFIG = `home-k8s/kubeconfig`).
5. Verify: `curl -s https://kiseki.konnektr.io/api/health`.

## Notes for coding agents

- Read `docs/spec.md` before large changes. Ask before changing the data model or adding dependencies.
- Backend is small and boring on purpose. Frontend is **read-only by design** (P2 adds the manage UI).
- Do not add SSR, a state library, or a component framework to the frontend without checking in first.
- Playwright browsers: the Docker image installs chromium (`--with-deps`); locally, `python -m playwright install chromium` if you need the PDF endpoint (optional — API tests skip it when browsers are missing).
