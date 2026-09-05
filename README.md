# Kiseki (軌跡)

**The trip as a living, agent-maintained document.**

Kiseki turns a trip plan into a responsive web experience with a printable PDF booklet — itinerary, dynamic maps with live traffic, bookings, checklists and contacts, all in one private link. Content is data, not code: updating a trip never requires a rebuild.

- **Living documents** — plans change; the trip updates in place. No more stale PDFs.
- **Access that matches the trip** — public trips are readable by anyone with the id link; private trips are crew-only behind Auth0. Each crew member claims their own identity via a join link and gets a role (owner / editor / viewer / follower) that drives what the app lets them do (editors get inline write affordances — the write path, #46).
- **PDF booklet export** — one click, print-ready, matches the on-screen design; gated by the trip's visibility.
- **Maps that mean something** — real driving routes (Directions API) and live drive times in the web app; the PDF renders the same MapLibre maps, so screen and paper agree. Itinerary and Day run on one map surface — the map stays alive between the scan and the day (DESIGN.md §7.6); there is no separate map tab. All generated from trip data — no per-trip hardcoding.

## Stack

- **Backend** — FastAPI (Python): serves the SPA, trip data, and Playwright-rendered PDF booklets. Single container.
- **Frontend** — React 19 + Vite + TypeScript + Tailwind v4 (shadcn-style components).
- **Identity** — Auth0 SPA (PKCE + refresh-token rotation); the backend validates access tokens statelessly against the tenant JWKS (RS256).
- **Data** — Konnektr Graph (AGE/PostgreSQL, DTDL v4 models) is the live source of truth; `trip.json` remains the authoring format and seed source. No file fallback at runtime.
- **Deploy** — container image via GitHub Actions → home k8s; content updates copy straight to the volume (no rebuild).

## Layout

```
backend/    FastAPI app (app/, data/trips/, tests/)
frontend/   React SPA (src/pages, src/components/blocks, src/lib)
deployments/docker/Dockerfile
docs/spec.md   ← product spec
DESIGN.md      ← design system & UX direction
.claude/skills ← repo-local agent skills (design system, map UX, trip identity)
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

Open `http://localhost:8000/` — trips are reached at `/t/<trip-id>/` (seed data in `backend/data/trips/<slug>/trip.json`; the live store is the Konnektr Graph).

## Auth & access

Trips are `visibility: public | private` (no share tokens since #64) and are reached by trip id:

- **Public** — anyone with `/t/<id>` reads the trip anonymously; the PDF booklet follows the trip's visibility (public trips download anonymously, #64).
- **Private** — signed-in crew only: a valid Auth0 token whose `sub` carries a `hasCrew` edge on the trip (`viewer+` to read, `follower+` for the booklet).
- **Crew identity = claiming, never matching** (issue #6): names/emails are self-asserted, so they grant nothing. The trip owner shares a **join link** (`/join/<claimToken>` — a second secret per trip); the invitee signs in and taps *"This is me"* on their crew entry. The server creates the user's twin (`$dtId` = auth `sub`), transfers the `hasCrew` edge (role + order) from the placeholder, and deletes the placeholder. A placeholder is claimable once.
- **Roles** live on the `hasCrew` edge: `owner` > `editor` > `viewer` > `follower`; the write path (#46) gates on `editor+`, `owner` gates visibility, crew roles, archiving and the join-link endpoint.
- **Signed-in landing** (issue #7): `/` becomes *My trips* (cards with cover, stage, dates, your role); anonymous visitors get the hero.
- `claimToken` is **never** included in trip responses (any route); the owner-only `GET /api/trips/{id}/join-link` is the only way to obtain a join link.
- Secrets are public SPA values: `AUTH0_DOMAIN` / `AUTH0_CLIENT_ID` / `AUTH0_AUDIENCE` ride as plain env; the frontend defaults mirror them via `VITE_AUTH0_*`.

## Content model

A trip is one JSON file: `stage` (idea → options → shortlist → planned → booked → live), dates, cover + stats, `locations` (with coordinates — the single source for markers AND maps), an itinerary of days with typed content blocks, editorial "features" for the overview, crew, and a practical page (checklist with booking links, contacts, notes). `backend/app/models.py` is authoritative; the map gotchas (Google Static Maps quirks with encoded polylines) are documented in the skill + AGENTS.md.

## Testing

```bash
cd backend && uv run pytest
```

## Roadmap

- **P0/P1 (done)** — booklet-faithful web + PDF; content-as-data pipeline; trips live in the Konnektr Graph (DTDL v4 models, no file fallback).
- **P2 (done — auth & roles)** — Auth0 login, crew identity via join-link claiming, role-based access, logged-in landing, visibility-gated PDF. Issues #5, #6, #7, #13 closed.
- **Design foundation (done)** — [`DESIGN.md`](DESIGN.md) is the visual and interaction law; token layer + accessibility floor shipped (#36, #41).
- **Information architecture (done)** — continuous itinerary with sections as a first-class unit (#43); the Today surface reaches today's plan in one tap (#42).
- **Map stack (done)** — MapLibre GL JS replaces the Google Maps JS API with no key in the client (#18, #27); the booklet PDF renders the same MapLibre maps via Playwright, so screen and paper agree (#37); hillshade and runtime contours from a keyless Mapterhorn DEM (#38).
- **Map primitives (done) — the map surface (2026-09)** — the `Sheet` (three detents) and `SplitView` ratio ladder shipped with the route map (#39); the standalone route *page* is then **retired** — Itinerary and Day run on one map surface with the map staying alive between levels (DESIGN.md §7.6, #90/#92/#93). The booklet keeps its block minimaps (#94 declined). Backlog: route-surface semantics (#91), Places photos (#95).
- **Media (done)** — trip media lives in Garage object storage, namespaced by trip `$dtId`, out of the repo (#47).

### Order of work

The backlog is sequenced by dependency, not by issue number. Each line is independently shippable.

| | Issue | Notes |
|---|---|---|
| 1 | ~~#64 — `Trip.visibility` enum, no secret in the URL~~ | **Done** — routes are id-based, trips are `public`/`private`. |
| 2 | ~~#65 — Non-crew followers via `claimToken`~~ | **Done.** |
| 3 | ~~#46 — Write-path (edit a trip in the UI)~~ | **Done** (v0.18, milestone C). |
| 4 | #40 — Per-trip theme presets | Next. Also owns per-**marker** stage (DESIGN.md §8.3): legs are stage-coloured, pins are not. |
| 5 | Map surface IA (2026-09) — #90–#93 | Itinerary and Day become ONE map surface (DESIGN.md §7.6): scan level #92, day level #90, tab/nav retirement #93. #88 (mode glyphs) and the #89 write-API enablers shipped (#97–#100); #91 (route-surface semantics) feeds the levels; #95 (Places photos) is independent; #94 (per-day booklet maps) declined — the booklet keeps its minimaps. |
| 6 | #21 — Analytics | Cheap, and much cheaper after #64 retired the secret-link URL. **Required before #14.** |
| 7 | #15 — Google Places suggestions | The embedded maps' sheets are where results will land; the photo pipeline is #95. Re-derive the cost model first — the write-up predates Google retiring the universal credit. |
| 8 | #48 — Live capture during travel | Unblocked: #42 (timezone) and #47 (media) are closed. |
| 9 | #11 — Installable PWA / offline | After the map stack — offline vector tiles depend on the tile source. |
| 10 | #12 — Events & notifications | P2–3 platform. |
| 11 | #9 — Agent backend + chat UI | |
| 12 | #10 — Agent memory per user / trip | After #9. |
| 13 | #14 — Social: feed, followers | P4. Last, by design. |

Parallelizable: **#40**, then the map-IA group — #88 first (fast bug), #89/#91 feeding #90/#92/#93, #94 after the media change, #95 anytime.

## License

Private until further notice.
