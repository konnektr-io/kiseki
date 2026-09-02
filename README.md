# Kiseki (軌跡)

**The trip as a living, agent-maintained document.**

Kiseki turns a trip plan into a responsive web experience with a printable PDF booklet — itinerary, dynamic maps with live traffic, bookings, checklists and contacts, all in one private link. Content is data, not code: updating a trip never requires a rebuild.

- **Living documents** — plans change; the trip updates in place. No more stale PDFs.
- **Access that matches the trip** — share a secret link for anonymous reading (*public-by-link*), or sign in (Auth0) and join a trip's crew: each crew member claims their own identity via a join link and gets a role (owner / editor / viewer / follower) that drives what the app lets them do.
- **PDF booklet export** — one click, print-ready, matches the on-screen design; gated by the trip's visibility.
- **Maps that mean something** — real driving routes (Directions API), live traffic colors and drive times in the web app, static route maps in the PDF. All generated from trip data — no per-trip hardcoding.

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

Open `http://localhost:8000/` — trips are reached at `/t/<token>/` (tokens live inside each `backend/data/trips/<slug>/trip.json`).

## Auth & access

Trips are reachable two ways, and the model is deliberately simple:

| | Share link (`/t/<token>`) | Trip id route (`/t/<id>`) |
|---|---|---|
| Who | **Anonymous** — anyone with the URL | **Signed-in crew** — valid Auth0 token + a `hasCrew` role |
| Key | secret share token (128-bit) | trip `$dtId` + identity |
| Visibility | *public-by-link* | private by default (only crew) |

- **Public vs private is the `token` itself** (issue #13): a trip **with** a token is public-by-link; a trip **without** one (`token: ""`) is private — no share URL can exist, so only crew can reach it. Making a trip private later is just clearing its token.
- **Crew identity = claiming, never matching** (issue #6): names/emails are self-asserted, so they grant nothing. The trip owner shares a **join link** (`/join/<claimToken>` — a second secret per trip); the invitee signs in and taps *"This is me"* on their crew entry. The server creates the user's twin (`$dtId` = auth `sub`), transfers the `hasCrew` edge (role + order) from the placeholder, and deletes the placeholder. A placeholder is claimable once.
- **Roles** live on the `hasCrew` edge: `owner` > `editor` > `viewer` > `follower`. Today `owner` also gates the join-link endpoint; the ladder exists for the write-path.
- **Signed-in landing** (issue #7): `/` becomes *My trips* (cards with cover, stage, dates, your role); anonymous visitors get the hero.
- **PDF booklet follows the trip's visibility** (#13, #64): `GET /api/trips/{id}/booklet.pdf` — public trips download anonymously, private trips need a JWT + `follower+` crew role. A render costs ~40s and ~2GiB, so it is rate-limited per client and single-flighted pod-wide.
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
- **Media (done)** — trip media lives in Garage object storage, namespaced by trip `$dtId`, out of the repo (#47).

### Order of work

The backlog is sequenced by dependency, not by issue number. Each line is independently shippable.

| | Issue | Notes |
|---|---|---|
| 1 | #64 — `Trip.visibility` enum, no secret in the URL | **In progress.** Ahead of everything else: it renames every trip route, and the backend is already halfway there (`{trip_param}`, map proxies and media addressed by `$dtId`). Doing it after #39 means doing it twice. |
| 2 | #65 — Non-crew followers via `claimToken` | **In progress, alongside #64** — same ACL branch, same store/convert lookups. |
| 3 | #39 — Sheet primitive + map-first route surface | The visible leap. Unblocked: #18, #27, #37, #38, #43 all closed. |
| 4 | #40 — Per-trip theme presets | The album differentiator. |
| 5 | #46 — Write-path (edit a trip in the UI) | The largest single item; the gateway to non-Niko users. Its `token`-flips-visibility criterion is superseded by #64. |
| 6 | #21 — Analytics | Cheap, and much cheaper after #64 retires the secret-link URL. **Required before #14.** |
| 7 | #15 — Google Places suggestions | Needs #39 as somewhere to put results. Re-derive the cost model first — the write-up predates Google retiring the universal credit. |
| 8 | #48 — Live capture during travel | Unblocked: #42 (timezone) and #47 (media) are closed. |
| 9 | #11 — Installable PWA / offline | After the map stack — offline vector tiles depend on the tile source. |
| 10 | #12 — Events & notifications | P2–3 platform. |
| 11 | #9 — Agent backend + chat UI | |
| 12 | #10 — Agent memory per user / trip | After #9. |
| 13 | #14 — Social: feed, followers | P4. Last, by design. |

Parallelizable: **#64/#65** (in flight now), then **#40** alongside **#39**. Everything else serializes.

## License

Private until further notice.
