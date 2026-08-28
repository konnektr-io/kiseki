# Kiseki

**The trip as a living, agent-maintained document.**

Kiseki (軌跡 — "the trail you leave behind") turns the travel booklets Niko's agent builds in chat into a responsive, always-up-to-date web experience with PDF booklet export. Friends plan together, family follows along, and content changes never require a rebuild.

## Stack

- **Backend**: FastAPI (Python) — serves the SPA, trip JSON, and Playwright-rendered PDF booklets. Single container.
- **Frontend**: React 19 + Vite + TypeScript + Tailwind v4 (shadcn-style components).
- **Data**: one `trip.json` per trip in `backend/data/trips/` (P0) → Konnektr Graph (P1+).
- **Deploy**: home Kubernetes, `kiseki.konnektr.io` via Envoy Gateway; images from ghcr.io via GitHub Actions.

## Layout

```
backend/    FastAPI app (app/, data/trips/, tests/)
frontend/   React SPA (src/pages, src/components/blocks, src/lib)
deployments/docker/Dockerfile
docs/spec.md   ← product & design spec (v0.2)
```

## Quick start

See [`AGENTS.md`](AGENTS.md) for full commands. Short version:

```bash
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000   # API on :8000
cd frontend && pnpm install && pnpm dev                                     # SPA on :5173 (proxies /api)
```

Production-like: `pnpm build` → copy `frontend/dist` → `backend/app/static/` → run uvicorn.

## Status

Phase 0 — proof: three trips live (Canada 2027 · Chile-Peru 2027 · Japan 2028) at three stages. See `docs/spec.md`.
