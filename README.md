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

**Phase 0 is live (2026-08-28, v0.5.2)** at **kiseki.konnektr.io** — three trips at three stages, booklet-faithful design:

| Trip | Stage | Notes |
|---|---|---|
| Canada Heliski 2027 | `booked` | The reference trip — every feature validated against the original booklet |
| Chile-Peru 2027 | `planned` | Content round next (family trip, Jul 2027) |
| Japan Campervan 2028 | `idea` | Route skeleton + two missions + open days (rebuilt 2026-08-28) |

**Shipped so far**: booklet typography (Bebas Neue/Oswald/Inter), itinerary sections + expandable days, per-kind block styling (flight/drive/stay), full-bleed cover with stats, features as editorial cards (centerpiece/road trip/route), bookings table with Day/When, Key info, dynamic Google Maps (JS in web + static proxy in PDF, real routes via Directions API, traffic + live drive time), locations-as-data markers, secret-link auth, PDF 12–18 pp per trip.

**Content workflow proven**: trip.json edits → `kubectl cp` to the PVC (no rebuild, no redeploy). Images ship in the image.

**Remaining for Phase 0 close**: Chile-Peru content round (next session), then Phase 0 done. Phase 1+ (Konnektr Graph, events, MinIO media) per spec §11.

See [`AGENTS.md`](AGENTS.md) for the full command surface and the `kiseki-trip-content` skill for the trip-content playbook.
