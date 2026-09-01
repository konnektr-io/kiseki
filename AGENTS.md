# Kiseki — Agent Context

Kiseki (軌跡) — **the trip as a living, agent-maintained document.**

Product spec: [`docs/spec.md`](docs/spec.md) — **read it before large changes.**
Design system & UX direction: [`DESIGN.md`](DESIGN.md) — **read it before any user-visible change.**

Repo-local agent skills live in `.claude/skills/`: `kiseki-design-system` (tokens, components,
responsive, a11y), `kiseki-map-ux` (map surfaces, MapLibre, markers/routes, print parity),
`kiseki-trip-identity` (per-trip presets, palettes, fonts, album coherence).

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
2. Copy to the cluster PVC (per-file — `kubectl cp <dir>` nests like `cp -r`):

   ```bash
   export KUBECONFIG=/opt/data/home/home-k8s/kubeconfig
   POD=$(kubectl get pod -n kiseki -l app.kubernetes.io/name=kiseki -o jsonpath='{.items[0].metadata.name}')
   for slug in canada-2027 chile-peru-2027 japan-campervan-2028; do
     kubectl -n kiseki cp backend/data/trips/$slug/trip.json $POD:/data/trips/$slug/trip.json
   done
   ```

3. The pod seeds `/data/trips` from the image on first boot **only if empty**; afterwards `/data/trips` wins. No image rebuild, no pod restart.

## Trip JSON schema

`backend/app/models.py` is authoritative. Summary:

- **Top level**: `slug`, `title`, `subtitle`, `stage` (`idea|options|shortlist|planned|booked|live|archive`), `startDate`, `endDate`, `token` (the secret share key — appears in URLs; rotate by editing the field), `cover` (image URL), `coverCredit`, `map` (overview route map), `summary` (markdown), `theme` `{primary, accent, font}` (hex colors — UI uses CSS variables, never hardcoded hex), `coverStats` (string[] — cover strip lines), `locations` `[{name, marker?, alias[], lat?, lng?}]` (places; marker number = position in the array unless `marker` set — drives the ① ②… loop markers AND map generation), `stats` `[{label, value}]` (at-a-glance row), `features` `[{kicker, title, description (md), image, images[], chips[], cards: [{title, value, description, image, links}], map?, links}]` (editorial overview cards: centerpiece / road trip), `sections` `[{title, days: [first, last], locationRefs?: string[], blocks?: Block[]}]` — `days` is an **INCLUSIVE RANGE**, expanded via `expandSectionDays()` (itinerary + booklet). A section also groups by place (`locationRefs`) and can hold unscheduled ideation `blocks` (before any day exists). In the graph, `TripSection` is a twin with `hasDay`/`atLocation`/`hasBlock` edges. `crew` `[{name, role: owner|editor|viewer|follower, note, contact?}]` — `role` is a `hasCrew` edge property in the graph (trip-relative), kept here only as the data carrier. `practical` `{todos: [{label, done, when?}], links: [{label, url}], notes (markdown), contacts: [{label, value, link}]}`, `days` `[{date (ISO), title, notes (markdown), map (image), meta: [{label, value}], blocks [...]}]`.
- **Block kinds — exactly these ten**: `activity`, `transport`, `lodging`, `meal`, `todo`, `note`, `gallery`, `link`, `booking`, `custom`.
  - Shared fields: `title`, `time`, `description` (markdown), `links` `[{label, url}]`, `cost` (number), `currency` (code), `status` (`planned|booked|done`), `bookingCode`, `order`, `location` (place name/alias → auto Google Maps pill + mini static-map thumbnail), `mapsQuery` (precise query for the ACTUAL place — geocodes the thumbnail pin to the hotel/restaurant, not the town), `images` (asset URLs → 1–2 image media strip).
  - `todo`: `items` `[{label, done}]` · `gallery`: `items` (image URLs) · `custom`: `html` (sanitized client-side).
  - **Transport** (drive cards, booklet style): `distance` ("143 km"), `duration` ("1 h 35"), `route` ("Hwy 1 West"), `via` ("Rogers Pass (Glacier NP)"), `from`/`to` (place names → auto Google Maps directions link).
- **Keep the model coarse.** Never invent a block kind without updating `models.py` + `frontend/src/components/blocks.tsx` + the spec. Stage drives the UI (badge, day highlights) — set it honestly per trip.

## Graph data model (P1 — Konnektr Graph / DTDL v4)

The same `models.py` drives the graph. `backend/dtdl/README.md` is the authoritative
writeup; in short:

- **DTDL v4 models auto-generated** from `models.py` → `backend/dtdl/kiseki-models.json`
  (`uv run python scripts/gen_dtdl.py`; structural check via `scripts/validate_dtdl.py`).
  Twins: `Trip` `Day` `Block` `Location` `Person` `User` (extends Person) `Feature` `TripSection`; inline value
  objects (`Link`, `Stat`, `Theme`, `TodoItem`, `BlockItem` …); enums `BlockKind`/`Stage`/
  `BlockStatus`/`Role`. Entities are linked by **relationship edges** (`hasDay`, `hasBlock`,
  `atLocation`, `hasCrew`, `hasFeature`, `hasSection`), not nested documents.
- **`$dtId` is an opaque GUID**, stored verbatim from each node's `id` field in
  `trip.json` (e.g. `bf29a027-…`). No type/slug/date prefix — all meaning lives
  in `$metadata.$model` + content. `token` and `slug` are editable Properties
  (slug is just the repo folder name). Re-seed **replaces** by id (no drift).
- **ADT-compat**: twins keep `$metadata.$model`, strip `$lastUpdatedBy`; relationships strip
  the entire `$metadata`; media is a plain URL field.
- **Mock the read-path before the SDK lands** (`uv run python scripts/trip_to_graph.py
  data/trips/<slug>/trip.json [--anonymize]`) → `backend/data/mocks/<slug>.graph{,.anon}.json`
  (the latter is the P1 seed/anonymized fixture). See issue #4 + #8.

- **P0**: images live in `backend/data/assets/<trip>/` — next to the trip data, served by the FastAPI app at `/media/<trip>/<file>`. Reference them in `trip.json` with **relative URLs** (`/media/canada-2027/sths-hero-full.jpg`), never base64. The repo is private, so shipping images in git is fine at this stage.
- **P1 (graph backend)**: when trip content moves into Konnektr Graph, media moves **out of the repo** into object storage (MinIO on the home cluster, S3-compatible) and the graph stores the **URL as a string field**. Keep every image reference a plain URL in the data model — swapping the media backend then only changes the URL prefix, nothing else. (The `/media` mount disappears; the backend serves or redirects from the bucket.)

## Maps (dynamic + print)

- **Data**: `trip.locations` `[{name, marker?, alias[], lat?, lng?}]` is the single source for ALL maps — marker numbers (① ② …) derive from it (`useLocationMarkers`), and every map renders from its coordinates. No per-trip hardcoding.
- **Web (dynamic map)**: `MapView` — **MapLibre GL JS v6** (#18) over a keyless basemap, rendering numbered markers + the real driving route for a set of places. Used inside drive cards (`from`/`to` → the exact leg) and the route feature (`"map": true`). Route geometry comes from `GET /api/maps/route/<token>?places=A,B` (backend calls Google Directions; `duration` is the live `duration_in_traffic` behind the drive-time chip).
- **Basemap tiles**: OpenFreeMap `positron` — no key, no proxy, desaturated ("quiet basemap, loud trip", DESIGN.md §8.5). One constant, `MAP_STYLE_URL` in `lib/maps.ts`, overridable via `VITE_MAP_STYLE_URL` — that is the seam for self-hosted PMTiles on Garage or per-trip styling (#40).
- **No Google in the browser (#27)**: `GET /api/maps/key` is **gone** (explicit 404 — the SPA catch-all would otherwise answer 200 with the index shell). Directions, Geocoding and Static Maps all run server-side; the client only ever talks to `/api/maps/*`. **Never reintroduce a client-side key.** There is no traffic layer: `TrafficLayer` is exclusive to the Google JS API, and loading that API is what exposed the key.
- **Rate limits**: `/api/maps/route` 60/min and `/api/maps/static` 240/min per client (`app/ratelimit.py`, in-process → per pod). Loopback is exempt because the headless PDF renderer pulls a booklet's worth of static maps in one burst from inside the pod.
- **PDF/print**: the SAME places render via `StaticMapImg` → `GET /api/maps/static/<token>?places=A,B` — a server-side proxy that builds the Google Static Maps URL with the key in the backend (never leaks). `TripMap` switches automatically: MapLibre on screen, static in print. Retiring this path is #37.
- **WebGL2 is mandatory** in MapLibre v6 (no WebGL1 fallback) — `MapView` detects it and degrades to `StaticMapImg`, as it does when the style/tiles fail to load. Never an empty grey box.
- Key lives in the `kiseki-maps` k8s secret (`GOOGLE_MAPS_API_KEY`). Absent → maps simply don't render (no crash).

## Conventions / rules

- **Content-first**: prefer editing `trip.json` over touching code. Code changes → image rebuild (tag → release → CI → home-k8s manifest bump). Content changes → PVC copy only.
- **Tokens are secrets-in-effect**: private repo + private link. Never commit a token to a public place. Rotate by editing the field.
- Dates ISO (`YYYY-MM-DD`); costs = number + currency code; links always `{label, url}`.
- Markdown (GFM) allowed in `summary`, day `notes`, block `description`.
- The **booklet** is a print stylesheet in the frontend (`BookletPage`, A4). Keep it A4-friendly — it becomes the PDF.
- Tailwind v4 theme tokens are CSS variables in `frontend/src/index.css` (`@theme inline`); per-trip theming injects `--trip-*` vars at runtime. Colors always behind tokens.
- **UI work follows [`DESIGN.md`](DESIGN.md)**: every component is a *document*, *map*, or *chrome* surface (they obey different rules and different print behavior); no hex literals in components; a11y floor (focus rings, 44px targets, reduced motion) is not optional.

## Auth (Auth0 SPA — issue #5 groundwork)

- `@auth0/auth0-react` — `Auth0Provider` wrapper lives in `frontend/src/components/AuthProvider.tsx`; config (domain + client ID) in `frontend/src/lib/auth.ts` with `VITE_AUTH0_*` env overrides. Domain/client ID are **public** (SPA, PKCE) — no secrets.
- Anonymous visitors keep the full secret-link experience: when unconfigured, the provider is a passthrough and `AuthButton` renders nothing.
- Login/logout UI: `frontend/src/components/AuthButton.tsx` (on the landing page top-right).
- **Dev port is pinned** (`strictPort: 5173`) — Auth0 callback URLs are origin-exact; a drifting Vite port breaks login with a callback mismatch. `http://localhost:5173` must be in the Auth0 app's Allowed Callback/Logout URLs + Web Origins.
- Auth0 tenant `dev-zv5urb33g0msy7bc.eu.auth0.com`, app client `jbMyX3scNHkECOF1lNJTOovXe8fOBmiq` (SPA; Refresh Token Rotation on).
- Backend identity layer (issue #5): `backend/app/auth.py` — stateless RS256 JWT validation against the tenant JWKS (PyJWT; keys cached, re-fetched on rotation). `GET /api/auth/me` returns `sub` (+ profile claims if the token carries them); `get_current_user` / `get_current_user_optional` FastAPI dependencies for future endpoints. Trip endpoints stay anonymous (public-by-link). `AUTH0_AUDIENCE` env optional — without a custom API, tokens are issued for the client itself (aud = client id); with a tenant API, set it and `VITE_AUTH0_AUDIENCE` to match.
- ACL enforcement (issue #5, `app/acl.py`): `GET /api/trips/<dashed-uuid>` is PROTECTED — valid Auth0 token + crew role (`hasCrew` edge, viewer+). `GET /api/trips/<token>` stays public-by-link. One route branches on the param SHAPE (Starlette's `:uuid` converter accepts compact dashless UUIDs, indistinguishable from share tokens — do NOT reintroduce it). Role matches ONLY the User twin whose `$dtId` IS the auth `sub` — **never name/email** (self-asserted claims are not credentials). Until a user claims their identity (issue #6), protected routes are 403.
- **Public vs private trips (issue #13)** — no flag, the `token` IS the switch: a trip **with** a `token` is *public-by-link* (anyone with the URL can read it anonymously); a trip **without** one (`token: ""` in trip.json) is *private* — no share URL exists, so only crew can reach it (login + `hasCrew` role via the protected `/t/<id>` route; crew joins via the claim-token join link). `get_trip_by_token` can never match an empty token, and the anonymous route needs a non-empty path segment, so an empty token is a hard closure — no code needed. The booklet PDF is a **crew feature**: served via the protected `GET /api/trips/{id}/booklet.pdf` (works for private trips; the renderer seeds the caller's access token into the headless browser's auth0 session cache). To make a trip public/private later (write-path), set/clear `token` (and re-seed or `kubectl cp` the trip.json).
- Placeholder→real-user migration (#6, `app/claims.py`): a **claim token** (separate secret, sibling of `token`) authorizes claiming a crew identity. `GET /join/<claimToken>` shows the trip + crew; `POST /api/claims {claimToken, personId}` creates the User twin (`$dtId` = auth sub) + transfers the `hasCrew` edge (same role/index) + **deletes the placeholder**. No name/email matching — the user picks the person explicitly.
  - **`claimToken` is NEVER included in trip documents** (any route) — it is only obtainable via the owner-only `GET /api/trips/{id}/join-link` (role `owner` required). The read link can never claim.
  - The protected id route reports the caller's `myRole`; the frontend shows an owner-only "Join link" button (copies the join URL).

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
