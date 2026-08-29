# Kiseki (軌跡)

**The trip as a living, agent-maintained document.**

Kiseki turns a trip plan into a responsive web experience with a printable PDF booklet — itinerary, dynamic maps with live traffic, bookings, checklists and contacts, all in one private link. Content is data, not code: updating a trip never requires a rebuild.

- **Living documents** — plans change; the trip updates in place. No more stale PDFs.
- **Private by design** — every trip lives behind its own secret link (no auth, no index). Search engines and AI crawlers are explicitly blocked.
- **PDF booklet export** — one click, print-ready, matches the on-screen design.
- **Maps that mean something** — real driving routes (Directions API), live traffic colors and drive times in the web app, static route maps in the PDF. All generated from trip data — no per-trip hardcoding.

## Stack

- **Backend** — FastAPI (Python): serves the SPA, trip JSON, and Playwright-rendered PDF booklets. Single container.
- **Frontend** — React 19 + Vite + TypeScript + Tailwind v4 (shadcn-style components).
- **Data** — one `trip.json` per trip: locations, days, blocks, features, practical info. P0 source of truth; a graph backend is the P1+ direction.
- **Deploy** — container image via GitHub Actions → any k8s cluster; content updates copy straight to the volume (no rebuild).

## Layout

```
backend/    FastAPI app (app/, data/trips/, tests/)
frontend/   React SPA (src/pages, src/components/blocks, src/lib)
deployments/docker/Dockerfile
docs/spec.md   ← product & design spec
```

## Quick start

```bash
# Backend (uv)
cd backend && uv sync
uv run uvicorn app.main:app --reload --port 8000   # API + SPA on :8000

# Frontend (pnpm)
cd frontend && pnpm install
pnpm dev        # Vite dev server on :5173 (proxies /api)
pnpm build      # tsc + vite build → dist/
```

Production-like single process:

```bash
pnpm --dir frontend build
rm -rf backend/app/static && cp -r frontend/dist backend/app/static
cd backend && uv run uvicorn app.main:app --port 8000
```

Open `http://localhost:8000/` — trips are reached at `/t/<token>/` (tokens live inside each `backend/data/trips/<slug>/trip.json`).

## Content model

A trip is one JSON file: `stage` (idea → options → shortlist → planned → booked → live), dates, cover + stats, `locations` (with coordinates — the single source for markers AND maps), an itinerary of days with typed content blocks, editorial "features" for the overview, crew, and a practical page (checklist with booking links, contacts, notes). `backend/app/models.py` is authoritative; the map gotchas (Google Static Maps quirks with encoded polylines) are documented in the skill + AGENTS.md.

## Testing

```bash
cd backend && uv run pytest
```

## Roadmap

- **P0 (current)** — booklet-faithful web + PDF for any trip; content-as-data pipeline proven end-to-end.
- **P1** — trips into a graph backend (Konnektr Graph), media to object storage, live capture during travel (photos, activity data).
- **P2** — accounts and roles, sharing with a real group experience, agent-written trip building from a prompt.

## License

Private until further notice.
