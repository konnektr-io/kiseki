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
| `backend/` | FastAPI (Python 3.13, uv). Serves the built React app from `app/static`, **trip documents from the Konnektr Graph** (write API since #46 — `trip.json`/PVC are migration-only), PDF via Playwright. **Single container.** |
| Konnektr Graph twins | **The content.** Trip/Day/Block/Person… twins + relationships. Live source of truth. |
| `frontend/` | React 19 + Vite + TypeScript + Tailwind v4 (shadcn-style components via `class-variance-authority`). Read-only for viewers/followers; `editor+` get role-gated inline edit affordances (#46). |
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
# → http://127.0.0.1:8000/t/<trip-id>/  (trip ids live in the anon mocks / live graph)
```

## Content update (deployed — no rebuild, no redeploy)

Content lives in the **graph**; edit it through the **write API (#46)** —
role-gated (`editor+` via the `hasCrew` edge; `owner` for `visibility`, crew
roles, archive/backward stage), per-field JSON PATCH, `x-user-id` attribution.
Every write returns the canonical trip document and retires the read cache, so
the next GET / booklet PDF reflects the edit — no rebuild, no reseed, no PVC.

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/trips/{trip_id}` | scalars + stage + theme + dates; `visibility` owner-only |
| PUT | `/api/trips/{trip_id}/practical` | whole practical object |
| POST | `/api/trips/{trip_id}/practical/todos` | append todo |
| POST | `/api/trips/{trip_id}/practical/todos/{i}/toggle` | per-item `{"done": bool}` |
| PUT | `/api/trips/{trip_id}/days/{day_id}` | title/notes/meta/map (date immutable) |
| PUT | `/api/trips/{trip_id}/sections/{section_id}` | title, `locationRefs`, or `days` (inclusive `[first, last]` 0-based; rewires the section's `hasDay` edges + twin property; in-bounds + no overlap with another section — a day renders under exactly one section) |
| POST | `/api/trips/{trip_id}/sections` | create a section chapter — `title` (+ optional `days` range, `locationRefs`); no `days` = pure ideation section |
| POST | `/api/trips/{trip_id}/blocks` | create — `container: {"type": "day"\|"section", "id"}` |
| PUT | `/api/trips/{trip_id}/blocks/{block_id}` | edit fields (kind immutable; transport fields only on `transport`) |
| DELETE | `/api/trips/{trip_id}/blocks/{block_id}` | |
| POST | `/api/trips/{trip_id}/blocks/{block_id}/move` | promote/demote day ↔ section (§7.5) |
| PUT | `/api/trips/{trip_id}/containers/{id}/block-order` | exact-set reorder `{block_ids: [...]}` |
| PATCH | `/api/trips/{trip_id}/crew/{person_id}` | `note` editor+ · `role` owner |
| POST | `/api/trips/{trip_id}/crew` | add placeholder person (they claim later) |
| DELETE | `/api/trips/{trip_id}/crew/{person_id}` | owner-only |
| PUT | `/api/trips/{trip_id}/locations` | replace registry (`locations: [...]`) |

`order` is always server-managed (never send it); `claimToken` is never
accepted or returned. Agent one-liner: `backend/scripts/api_write.py <method>
<path> [--json '…'|--file -]`.

**Relationship writes are scoped under the edge's SOURCE twin (issue #89).**
The Konnektr Graph stores every relationship with a `$relationshipId`
(unique per source twin) and only knows an edge *under its source* — so
deleting/updating a relationship requires passing the edge's `$sourceId`, not
the trip. Trip-sourced edges (`hasCrew`, root `atLocation`, `hasSection`,
trip `hasDay`) take the trip id; section/day/block-sourced edges
(`atLocation`/`hasDay` on a section, `hasBlock` on a day/section) take that
container's id. The fetched trip bundle now carries every relationship's
`$relationshipId`, so server round-trips always agree. Chapter splits are two
calls — trim the old range, then add the closing chapter:

```bash
python scripts/api_write.py put /api/trips/<trip_id>/sections/<sec_id> --json '{"days": [12, 14]}'
python scripts/api_write.py post /api/trips/<trip_id>/sections --json '{"title": "The way home", "days": [15, 15]}'
```

**Live smoke after any write-path deploy**: unit tests run against
`FakeGraph`, which cannot prove the HTTP layer talks to the graph — #89's
relationship-write breakage passed CI. Run the reversible live smoke
(`backend/scripts/smoke_write_path.py --trip <id>`, editor+ token) which
exercises block create/move/delete + section locationRefs + section day-range
writes against the real graph and restores every mutation.

**Identity model (#46)**: the agent has no identity of its own in the graph.
Three modes, in order of preference:
1. **User's own token** (dedicated end-user profile / UI chat): present the
   acting user's access token — ACL + `x-user-id` follow its `sub`.
2. **Act-as (this Niko home profile only)**: the agent authenticates with the
   sanctioned M2M client token and the backend resolves the actor as Niko
   (`KISEKI_AGENT_ACT_AS`) — ACL = Niko's real crew role, attribution = his
   sub. No user token needed; never configured on the end-user profile.
3. **Unattended fallback**: M2M token with no act-as → owner-level service
   principal (`KISEKI_AGENT_CLIENT_ID`), last resort only.
Nothing is ever provisioned for the agent (no User twin, no hasCrew edge).
Audience for all tokens: `https://kiseki.konnektr.io`.

**Not the content path anymore**: `backend/data/trips/*/trip.json` (local
scratch), reseed scripts (`trip_to_graph.py`, `seed_graph.py`,
`reseed_crew_safe.py`) and PVC copies are MIGRATION-ONLY tooling. Media
(images) still goes through the Garage S3 pipeline (`migrate_assets_to_s3.py`)
— the API accepts and returns bare filenames.

## Trip JSON schema

`backend/app/models.py` is authoritative. Summary:

- **Top level**: `slug`, `title`, `subtitle`, `stage` (`idea|options|shortlist|planned|booked|live|archive`), `startDate`, `endDate`, `token` (the secret share key — appears in URLs; rotate by editing the field), `cover` (image URL), `coverCredit`, `map` (overview route map), `summary` (markdown), `theme` `{primary, accent, font}` (hex colors — UI uses CSS variables, never hardcoded hex), `coverStats` (string[] — cover strip lines), `locations` `[{name, marker?, alias[], lat?, lng?}]` (places; marker number = position in the array unless `marker` set — drives the ① ②… loop markers AND map generation), `stats` `[{label, value}]` (at-a-glance row), `features` `[{kicker, title, description (md), image, images[], chips[], cards: [{title, value, description, image, links}], map?, links}]` (editorial overview cards: centerpiece / road trip), `sections` `[{title, days: [first, last], locationRefs?: string[], blocks?: Block[]}]` — `days` is an **INCLUSIVE RANGE**, expanded via `expandSectionDays()` (itinerary + booklet). A section also groups by place (`locationRefs`) and can hold unscheduled ideation `blocks` (before any day exists). In the graph, `TripSection` is a twin with `hasDay`/`atLocation`/`hasBlock` edges. `crew` `[{name, role: owner|editor|viewer|follower, note, contact?}]` — `role` is a `hasCrew` edge property in the graph (trip-relative), kept here only as the data carrier. `practical` `{todos: [{label, done, when?}], links: [{label, url}], notes (markdown), contacts: [{label, value, link}]}`, `days` `[{date (ISO), title, notes (markdown), map (image), meta: [{label, value}], blocks [...]}]`.
- **Block kinds — exactly these ten**: `activity`, `transport`, `lodging`, `meal`, `todo`, `note`, `gallery`, `link`, `booking`, `custom`.
  - Shared fields: `title`, `time`, `description` (markdown), `links` `[{label, url}]`, `cost` (number), `currency` (code), `status` (`planned|booked|done`), `bookingCode`, `order`, `location` (place name/alias → auto Google Maps pill + mini MapLibre thumbnail), `mapsQuery` (precise query for the ACTUAL place — still drives the Google Maps pill; thumbnail now centers on the town's `locations` coordinates), `images` (asset URLs → 1–2 image media strip).
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

- **Media (shipped, #47 — Garage, not git)**: images live in the S3-compatible
  **Garage** bucket (private, bucket `kiseki`, key prefix `media/`), **never in
  the repo**. The FastAPI app serves them at `/media/<trip_id>/<file>` where
  `trip_id` is the trip's `$dtId` (the `id` field) — the durable identity,
  **never the repo-folder slug** (organizational; can collide). Object keys are
  **content-addressed and unguessable**: `media/<trip_id>/<sha256[:32]><ext>`,
  so a leaked slug-based URL 404s.
  - **The data stores bare filenames**: media fields in `trip.json` / graph
    (`cover`, `map`, `image`, `images`, gallery `items`) hold just
    `c383ce57….jpg` — NO path, NO slug. The API canonicalizes them to
    `/media/<trip_id>/<file>` at serialization time (`resolve_media_urls` in
    `app/media.py`), so the frontend / booklet PDF only ever see full URLs and
    never care where bytes live.
  - To add/update media: set the media field to the file's name (e.g.
    `sths-hero-full.jpg`), drop the file in `backend/data/assets/<trip>/`
    (gitignored; slug is just the local scratch folder), run
    `uv run python scripts/migrate_assets_to_s3.py` (uploads to Garage under
    `media/<trip_id>/…` AND rewrites the field to its content-addressed key),
    then commit the trip.json only.
  - One-time layout migrations (2026-09, #47 follow-up): `--rekey-to-id`
    copied `media/<slug>/…` → `media/<trip_id>/…` (slug keys purged with
    `--purge-slug-keys` after switchover).
  - Config: `KISEKI_S3_ENDPOINT/_BUCKET/_ACCESS_KEY/_SECRET_KEY` (k8s Secret
    `kiseki-s3`). Without S3 config the route falls back to a local
    `backend/data/assets/` tree only when one exists (dev scratch / legacy
    checkout); the repo ships none, so prod serves 404 without the bucket.

## Maps (dynamic + print)

- **Data**: `trip.locations` `[{name, marker?, alias[], lat?, lng?}]` is the single source for ALL maps — marker numbers (① ② …) derive from it (`useLocationMarkers`), and every map renders from its coordinates. No per-trip hardcoding.
- **Web (dynamic map)**: `MapView` — **MapLibre GL JS v6** (#18) over a keyless basemap, rendering numbered markers + the real driving route for a set of places. Used inside drive cards (`from`/`to` → the exact leg), the route feature (`"map": true`), and block card thumbnails (single pin, `compact`). Route geometry comes from `GET /api/maps/route/<id>?places=A,B` (backend calls HERE Routing v8 — #15 provider decision, 2026-09; `duration` is HERE's live time-aware `summary.duration` behind the drive-time chip).
- **Map surface (2026-09 direction, #92/#90/#93)**: the standalone route *page*
  (`RouteMapPage` at `/t/<id>/map`) is **retired** (redirects to `/itinerary`). **Itinerary
  and Day are ONE map surface** with two levels on the #39 layout (DESIGN.md §7.6): the scan
  level (#92) shows the whole trip with the existing itinerary content in the rail/sheet; the
  day level (#90) shows that day's world — **the map stays alive between levels** (state
  transitions + history sync; never remount in-app). The #39 primitives are reused: `SplitView`
  (ratio ladder), `RouteMap` (numbered pins, legs styled by state), `lib/route-surface.ts`
  (journey derivation — semantics below). Minimap policy: block-card minimaps are **hidden on
  the web** and **kept in the PDF** (print-only rule; booklet unchanged — #94 declined). The
  booklet renders its own maps through `MapView` (#37).
- **Route-surface derivation semantics (#91)** — what `lib/route-surface.ts` reports is
  *derived*, so it must never invent content. Four rules, each enforced in code and pinned
  by `route-surface.test.ts` (fixtures `canadaLive` + `chile` are live-shaped and assert the
  calendar-truth labels — if a future edit changes them, the derivation drifted):
  1. **Stop vs excursion (`placeRole`)**: a place is a journey STOP iff the trip re-bases
     there — a section `locationRefs` base, an endpoint of a transport block (explicit
     `from`/`to` fields only), or a flight gateway (flight titles count — flights often
     carry no endpoint fields). Anything merely toured from a base elsewhere (Rogers Pass
     from Revelstoke) is an EXCURSION: excluded from `journeyOrder` entirely, carried in
     `Journey.excursions`, rendered as a secondary diamond marker (no number — it must not
     claim a slot in the ① ② ③ index). Exclusion is structural: only chain members are
     paired into legs, so a phantom through-leg cannot exist.
  2. **Road facts vs visits (`blockPlaces`)**: day attribution scans only explicit
     `from`/`to`/`location` fields, the block title, and the day title. `via`/`route` are
     deliberately NOT scanned ("into Banff NP", "Via Banff, Canmore" describe the road) —
     under the old derivation Banff grew phantom days 13/15 and the pass drew solid legs
     nobody travels. `blockEndpoints` STILL reads via/route to fill a transport's missing
     endpoints (leg matching needs that leniency) — do not "fix" the asymmetry, it is the
     point.
  3. **Clamped section refs (`placeDays`)**: a place's days = its explicitly located days
     PLUS section `locationRefs` ranges, clamped — a ref-day is granted only when the day
     carries no located content for a different place AND falls within the place's own
     [first, last] located span (a chapter that trails past the drive-out is the chapter
     outliving the stay). A place with no located days trusts its ref over the full range.
  4. **Leg stages (`legStage`)**: a leg the derivation joins but nobody authored (no
     transport block) is PROVISIONAL, full stop — it never inherits the trip's stage. On a
     booked trip that is dashed-and-dim, not a solid leg with a status it was never given.
     Trip-stage fallback applies only when a speaking block exists but carries no status.
  Scaffold fallback: when NO place has any re-base evidence (curated locations, no
  transports/sections — a trip still being sketched), the registry itself chains in marker
  order (`isRegistryScaffold`) instead of exiling every place to excursion.
  `daysAtLocation` remains as an alias of `placeDays` for existing callers.
- **Basemap tiles**: OpenFreeMap `positron` — no key, no proxy, desaturated ("quiet basemap, loud trip", DESIGN.md §8.5). One constant, `MAP_STYLE_URL` in `lib/maps.ts`, overridable via `VITE_MAP_STYLE_URL` — that is the seam for self-hosted PMTiles on Garage or per-trip styling (#40).
- **No provider in the browser (#27)**: `GET /api/maps/key` is **gone** (explicit 404 — the SPA catch-all would otherwise answer 200 with the index shell). Routing stays server-side (MapLibre renders, it does not route); the client only ever talks to `/api/maps/route`. **Never reintroduce a client-side credential.** Traffic-awareness comes from HERE Routing v8 (`summary.duration`, live time-aware — `app/here.py`); there is no client-side traffic layer to load.
- **Addressing**: `/api/maps/route` takes the trip **`$dtId`** (id-based since #64 — no share
  tokens remain). Public trips are reachable anonymously; the unguessable id and the rate
  limiter (60/min, `app/ratelimit.py`, per pod) are the bounds.
- **PDF/booklet (#37)**: the SAME `MapView` renders live in the booklet via Playwright+SwiftShader — basemap, marker numbering and route colours are identical on screen and on paper. Headless Chromium launches with `--use-gl=angle --use-angle=swiftshader` (WebGL2 via software) and the renderer waits for `document.fonts.ready` + every `[data-maplibre]` to reach `data-map-ready` (MapLibre `idle`) before `page.pdf()`. `TripMap` is now a thin wrapper around `MapView` — the old `print:hidden` / `hidden print:block` split and the `GET /api/maps/static` proxy are deleted.
- **Terrain (#38)**: `lib/terrain.ts` adds a shared `raster-dem` source (Mapterhorn, terrarium, keyless), an `igor` hillshade and runtime contours (`maplibre-contour`, minzoom 10) BELOW the basemap's roads and labels — found by layer *type*, not id, so a style swap (#40) does not break the ordering. `DEM_MAXZOOM = 12` is deliberate: global GLO-30 coverage stops there (Sahara/Outback/Andes 404 at z13; BC reaches z15), so capping upscales instead of leaving holes. 3D terrain attaches lazily on `pitchstart` (invisible at pitch 0, so the flat view pays nothing) behind `TERRAIN_3D`; the compass reveals itself only when the map is off north or tilted, and resets both. #40 wires the per-trip switch. Failures are swallowed: no hillshade beats no route.
- **WebGL2 is mandatory** in MapLibre v6 (no WebGL1 fallback) — `MapView` shows a styled placeholder when WebGL2 is absent or the style/tiles fail (`data-map-failed="true"` so the PDF waiter can resolve). Never an empty grey box.
- Routing credentials live in the `kiseki-here` k8s secret (`HERE_ACCESS_KEY_ID` / `HERE_ACCESS_KEY_SECRET` / `HERE_TOKEN_ENDPOINT_URL`; see `app/here.py`) for Routing v8. Absent → routes simply don't render (straight dashed lines; no crash). OAuth2 bearer tokens are minted server-side (`app/here.py` — RFC 5849 client_credentials) and cached for their ~24 h validity.

## Conventions / rules

- **Content-first**: trip content lives in the graph and is edited through the write API (`backend/scripts/api_write.py`, #46). The image contains only app code; a content change never rebuilds or redeploys. Local `trip.json` scratch + reseed scripts are migration-only tooling.
- **Tokens are secrets-in-effect**: private repo + private link. Never commit a token to a public place. Rotate by editing the field.
- Dates ISO (`YYYY-MM-DD`); costs = number + currency code; links always `{label, url}`.
- Markdown (GFM) allowed in `summary`, day `notes`, block `description`.
- The **booklet** is a print stylesheet in the frontend (`BookletPage`, A4). Keep it A4-friendly — it becomes the PDF.
- Tailwind v4 theme tokens are CSS variables in `frontend/src/index.css` (`@theme inline`); per-trip theming injects `--trip-*` vars at runtime. Colors always behind tokens.
- **UI work follows [`DESIGN.md`](DESIGN.md)**: every component is a *document*, *map*, or *chrome* surface (they obey different rules and different print behavior); no hex literals in components; a11y floor (focus rings, 44px targets, reduced motion) is not optional.
- **Authoring rules for map truth (2026-09)**: a transport block whose endpoint is a trip
  place sets `from`/`to` to the location name/alias — flights included (trip-side airport
  gateways get explicit endpoints; out-of-region origins like BRU are NOT registry locations).
  A section's `days` range ends on the last day the place actually anchors; a pure travel/home
  day gets its own slim section with no `locationRefs`. Map day labels, pills and legs are all
  *derived* — content that follows these rules keeps the derivations honest (#91).

## Auth (Auth0 SPA — issue #5 groundwork)

- `@auth0/auth0-react` — `Auth0Provider` wrapper lives in `frontend/src/components/AuthProvider.tsx`; config (domain + client ID) in `frontend/src/lib/auth.ts` with `VITE_AUTH0_*` env overrides. Domain/client ID are **public** (SPA, PKCE) — no secrets.
- Provider options: `useRefreshTokens` (rotation) + `cacheLocation="localstorage"` + **`useRefreshTokensFallback`** — when a returning user's cached refresh token is missing/dead (expired or rotation chain revoked), the SDK first retries silently via the `prompt=none` iframe against the Auth0 SSO session, and clears the dead local session (→ signed-out hero) if that's gone too. Without the fallback the SDK dead-ends on `Missing Refresh Token (audience: …)`. Callers of `getAccessTokenSilently` that gate UI on success must route the unrecoverable codes (`missing_refresh_token`, `login_required`, `consent_required`, `interaction_required`, `invalid_grant` — see `isSessionExpiredError` in `lib/auth.ts`) to a "Sign in again" CTA, not a Retry.
- Anonymous visitors keep the full secret-link experience: when unconfigured, the provider is a passthrough and `AuthButton` renders nothing.
- Login/logout UI: `frontend/src/components/AuthButton.tsx` (on the landing page top-right).
- **Dev port is pinned** (`strictPort: 5173`) — Auth0 callback URLs are origin-exact; a drifting Vite port breaks login with a callback mismatch. `http://localhost:5173` must be in the Auth0 app's Allowed Callback/Logout URLs + Web Origins.
- Auth0 tenant `dev-zv5urb33g0msy7bc.eu.auth0.com`, app client `jbMyX3scNHkECOF1lNJTOovXe8fOBmiq` (SPA; Refresh Token Rotation on).
- Backend identity layer (issue #5): `backend/app/auth.py` — stateless RS256 JWT validation against the tenant JWKS (PyJWT; keys cached, re-fetched on rotation). `GET /api/auth/me` returns `sub` (+ profile claims if the token carries them); `get_current_user` / `get_current_user_optional` FastAPI dependencies for future endpoints. Trip endpoints stay anonymous (public-by-link). `AUTH0_AUDIENCE` env optional — without a custom API, tokens are issued for the client itself (aud = client id); with a tenant API, set it and `VITE_AUTH0_AUDIENCE` to match.
- ACL enforcement (issue #5, `app/acl.py`): `GET /api/trips/<dashed-uuid>` is PROTECTED — valid Auth0 token + crew role (`hasCrew` edge, viewer+). `GET /api/trips/<token>` stays public-by-link. One route branches on the param SHAPE (Starlette's `:uuid` converter accepts compact dashless UUIDs, indistinguishable from share tokens — do NOT reintroduce it). Role matches ONLY the User twin whose `$dtId` IS the auth `sub` — **never name/email** (self-asserted claims are not credentials). Until a user claims their identity (issue #6), protected routes are 403.
- **Public vs private trips (#64)** — `visibility` on the Trip twin: `public` serves anonymously at `GET /api/trips/{id}`, `private` requires a crew `hasCrew` edge. Join links carry `claimToken` (copy of the trip's `claimToken`) to let a new user `follow` as `follower` or claim a `Person` placeholder. The graph is the only store; there is no `token` flag and no file fallback.
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
- Backend is small and boring on purpose. Frontend is read-only for `viewer`/`follower`/anonymous; `editor+` see inline write affordances (todo toggles, block edit/reorder/delete, section→day promote, stage, owner-only visibility) — **the server is always the enforcement point** (hiding a button is not access control; the ACL matrix is tested in `backend/tests/test_write_api.py`). Booklet/PDF output stays untouched (`no-print` chrome, no editable surfaces in the print route).
- Do not add SSR, a state library, or a component framework to the frontend without checking in first.
- Playwright browsers: the Docker image installs chromium (`--with-deps`); locally, `python -m playwright install chromium` if you need the PDF endpoint (optional — API tests skip it when browsers are missing).
