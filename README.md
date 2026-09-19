<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/logo-mark-white.png">
    <img src="frontend/public/logo-mark-transparent.png" alt="Kiseki" width="96">
  </picture>
</p>

<h1 align="center">Kiseki 軌跡</h1>

<p align="center"><strong>Every trip, from first idea to printed book.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href="https://github.com/konnektr-io/kiseki/actions/workflows/build-image.yml"><img alt="Build and push image" src="https://github.com/konnektr-io/kiseki/actions/workflows/build-image.yml/badge.svg"></a>
</p>

---

Kiseki is a self-hosted web app for planning a trip and then living it. The itinerary, the places it
touches, the practicalities around it and the people going all live in **one structured document**
that everyone on the trip opens at the same URL — and that keeps changing as the plan does. You can
edit it in the browser, or simply tell the built-in agent what changed and watch the trip update.

The itinerary *is* the map: one persistent MapLibre surface that scans from the whole route down to a
single day, with real driving geometry and live drive times. Kiseki can still print a booklet — one
click, print-ready PDF, matching the on-screen design — but that is an **export** of the document,
not the product.

| | |
|---|---|
| **Backend** | Python 3.13 · FastAPI · Playwright (PDF) · single container |
| **Frontend** | React 19 · Vite · TypeScript · Tailwind v4 |
| **Data** | [Konnektr Graph](https://github.com/konnektr-io) (AGE/PostgreSQL, DTDL v4 models) as the live store |
| **Identity** | Auth0 SPA (PKCE + refresh rotation), stateless RS256/JWKS validation server-side |
| **Maps** | MapLibre GL JS · HERE Routing v8 · Google Places (web-only overlay) |
| **Media** | Garage (S3-compatible) object storage, proxied per trip |

## Why it exists

Trip plans rot. A PDF sent to the group is stale the moment a hotel changes, and a spreadsheet can't
show you what day 6 looks like on a map. Kiseki keeps the trip as data instead of a document: the
same JSON powers the web pages, the maps and the printable booklet, so there is only ever one
version of the truth — and it never needs a rebuild to change.

## What it does

### The trip document

- **Days with typed blocks.** A day is an ordered list of typed blocks — stays, drives, activities,
  meals, notes, photos — each with its own layout and semantics, grouped into **sections** (a
  multi-day unit you can fold away) and reachable from a **Today** surface while you travel.
- **Stage that tells the truth.** A trip moves through `idea → options → shortlist → planned →
  booked → live`, and the whole app reacts to it.
- **Locations are first-class.** Every place carries coordinates, so markers, routes, maps and the
  booklet all derive from one registry instead of being re-typed per feature.
- **Practicals in the same document.** Checklists with booking links, contacts, notes, and — for
  crew only — a TriCount expense snapshot.
- **Crew as data.** People, their roles and their ordering are part of the trip, not a mailing list.

### The map is the itinerary

- **One persistent map surface.** Itinerary (scan level) and Day (day level) are two zoom levels of
  the same live map instance — the map never re-mounts, and there is no separate "map tab".
- **Real routes, live times.** Driving legs are real HERE Routing v8 geometry with current traffic
  durations, resolved server-side — the map key never reaches the browser.
- **Flights, letters, elevation.** Flight legs draw as great-circle arcs; blocks carry letters that
  sync with the cards; hillshade and contours come from a keyless DEM tile source.
- **Screen and paper agree.** The booklet renders the same MapLibre styles through Playwright, so
  what you print is what you saw.

### Access, crew and roles

- **Public or private, by id — no secrets in URLs.** Public trips are readable by anyone with the
  link; private trips are crew-only behind Auth0.
- **Crew identity is claimed, never matched.** Names and e-mails are self-asserted and grant nothing.
  The owner shares a **join link** (`/join/<claimToken>`); the invitee signs in and taps *"This is
  me"* on their crew entry. The server creates their user twin, moves the crew edge onto it and
  deletes the placeholder. A placeholder is claimable exactly once.
- **Roles on the crew edge:** `owner > editor > viewer > follower`. Reads need `follower+`, writes
  need `editor+`, and invites, visibility, archiving and crew management are `owner`-only.
- **Follows and profiles.** Public trips (and people) can be followed without an invite — follow
  links are deliberately *not* claim links — and the feed on `/feed` is built from the trips and
  people you follow.
- **Claim tokens never leave the server.** They are absent from every trip response; the owner-only
  join-link endpoint is the only way to obtain one.

### Editing — by hand or by agent

- **Inline editing for `editor+`.** Optimistic, role-gated writes straight from the UI.
- **A chat agent that edits the trip.** The in-app assistant is a real agent with the same ACL as the
  user it acts for: ask for a change and it drives the same write API the UI does, streaming its
  progress as it goes.
- **Turns survive disconnects.** Chat runs on a submit-and-attach model, so closing the tab or losing
  the network doesn't kill the work — reconnect and the turn is still there.
- **Per-user memory.** Conversations and remembered facts are scoped per user and per trip; histories
  never mix, and credential mechanics are redacted out of everything the user sees.

### Photos, places and expenses

- **Photo batches → the right day.** Upload a batch, get a proposed placement (EXIF time and GPS
  included) and confirm it — photos attach to the day or activity they belong to.
- **Live place data, deliberately transient.** Google Places ratings, reviews and photos are proxied
  server-side and shown live; nothing Google-derived is ever persisted beyond the storable
  identifiers. Stored imagery is rights-clean.
- **TriCount integration.** Crew see the running expense summary inside the trip.

### The PDF booklet (an export)

Print-ready A4 booklets, one click from the trip, rendered from the exact same data and design system
as the web app — including the route maps. Booklet access follows trip visibility: public trips
download anonymously, private trips stay crew-only.

## How it works

```
Browser (React SPA)
   │  /api/*            Auth0 access token (RS256, JWKS-verified statelessly)
   ▼
FastAPI backend ──────► Konnektr Graph (trips, days, blocks, crew, users — the source of truth)
   │       │
   │       ├──────────► Garage S3      (trip media — private bucket, streamed via /media/<trip>/<file>)
   │       ├──────────► HERE / Places  (routes, drive times, place details — server-side keys)
   │       └──────────► Hermes agent   (chat relay, Runs API, per-user scoped sessions)
   └─ serves the built SPA + Playwright-rendered booklet PDFs from one container
```

Content is data, never code: **updating a trip never requires a rebuild or a redeploy.**

More detail: [`docs/architecture.md`](docs/architecture.md).

## Quick start

Requirements: Python 3.13 with [uv](https://docs.astral.sh/uv/) and Node.js with [pnpm](https://pnpm.io/).
No database and no external service is required to run it locally.

```bash
# Backend
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000   # API on :8000

# Frontend (separate terminal)
cd frontend
pnpm install
pnpm dev        # Vite dev server on :5173, proxies /api to :8000
```

Production-like single process:

```bash
pnpm --dir frontend build
rm -rf backend/app/static && cp -r frontend/dist backend/app/static
cd backend && uv run uvicorn app.main:app --port 8000
```

Trips are reached at `/t/<trip-id>/…`; the landing page, a trip's pages, `/join/<token>`, `/feed`,
`/u/<sub>` and `/me` are all SPA routes.

> **Working without a graph.** The Konnektr Graph is the only store in production — there is no file
> fallback, and `trip.json` is authoring scratch rather than runtime data. For local development and
> CI, when `KISEKI_GRAPH_URL` is unset the backend serves three **anonymised** sample trips from
> `backend/data/mocks/*.graph.anon.json`, so a fresh clone runs with real-looking content and no
> external services at all (`uv run pytest` likewise needs nothing).

## Configuration

Everything is environment-driven; secrets stay server-side (browser-visible values are exactly the
Auth0 domain/client id and the PostHog ingest key, both public by design).

| Variable | Purpose |
|---|---|
| `KISEKI_GRAPH_URL`, `KISEKI_GRAPH_TOKEN` | Konnektr Graph endpoint + token (unset → anonymised sample trips) |
| `KISEKI_S3_ENDPOINT`, `KISEKI_S3_BUCKET`, `KISEKI_S3_ACCESS_KEY`, `KISEKI_S3_SECRET_KEY` | Garage/S3 media backend (`KISEKI_S3_REGION` optional; absent → local media dir) |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE` | SPA token validation; `AUTH0_DOMAIN` is the custom domain (`auth.konnektr.io`) and must match the frontend's baked default — the backend derives the expected `iss` from it |
| `HERE_ACCESS_KEY_ID`, `HERE_ACCESS_KEY_SECRET` | HERE Routing v8 (absent → routes simply don't render) |
| `GOOGLE_MAPS_API_KEY` | Google Places overlay (never sent to the browser) |
| `KISEKI_HERMES_URL`, `KISEKI_HERMES_KEY` | Agent endpoint for chat (absent → `/api/chat` 503s) |
| `KISEKI_AGENT_CLIENT_ID`, `KISEKI_AGENT_ACT_AS` | Sanctioned agent M2M client (and interim act-as pin) |
| `KISEKI_LISTEN_PORT`, `KISEKI_STATIC_DIR` | Port, and where the built SPA lives |
| `KISEKI_TRICOUNT_CREDS_FILE`, `KISEKI_TRICOUNT_TTL` | TriCount credentials + snapshot cache TTL |
| `VITE_AUTH0_*`, `VITE_POSTHOG_*` | Frontend build-time overrides (see `frontend/.env.example`) |

## Testing

```bash
cd backend  && uv run pytest          # API, ACL, graph conversion, chat relay
cd frontend && pnpm test              # component + unit tests (vitest)
cd frontend && pnpm build             # tsc + vite build — the CI gate
```

CI (`.github/workflows/build-image.yml`) runs the frontend build and the backend suite on every pull
request, and publishes `ghcr.io/konnektr-io/kiseki` on `main` and on `v*` tags.

## Deployment

The image is a single container serving the API, the SPA and PDF rendering. Content lives in the
graph, so day-to-day trip updates are **data changes, not deployments**.

- Image: `ghcr.io/konnektr-io/kiseki` (built by GitHub Actions; `deployments/docker/Dockerfile`)
- Reference deployment: the author's home Kubernetes cluster behind Envoy Gateway, with graph,
  S3, HERE, Places, Auth0 and agent credentials injected as cluster secrets
- A live instance runs at [kiseki.konnektr.io](https://kiseki.konnektr.io)

See [`docs/deployment.md`](docs/deployment.md).

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Components, request flows, store, media, agent relay |
| [`docs/api.md`](docs/api.md) | HTTP API reference: trips, blocks, crew, users, chat, media |
| [`docs/data-model.md`](docs/data-model.md) | The trip document, DTDL v4 models, graph edges, ACL |
| [`docs/development.md`](docs/development.md) | Local setup, tests, conventions, repo layout |
| [`docs/deployment.md`](docs/deployment.md) | Container, configuration, cluster notes |
| [`docs/spec.md`](docs/spec.md) | Original product spec — the design rationale, kept as written |
| [`DESIGN.md`](DESIGN.md) | The design system and interaction law of the app |
| [`AGENTS.md`](AGENTS.md) | Context and conventions for coding agents working in this repo |

## Roadmap

**Shipped** — trip documents in the graph (DTDL v4, no file fallback) · printable booklet · MapLibre
map stack with real routes and live drive times · Auth0 login, claim-based crew identity, roles and
followers · inline editing and a chat agent that edits trips · per-user agent memory · media in
object storage · Google Places overlay · TriCount expenses · analytics · profiles, follows and the
feed · photo batches placed by EXIF.

**Next** (open issues) —

- **Capture while travelling** — photos and tracks into a running trip, without live OAuth ([#48](https://github.com/konnektr-io/kiseki/issues/48))
- **Tracks** — a shared activity → GPX → the day's map ([#193](https://github.com/konnektr-io/kiseki/issues/193))
- **Routes while planning** — propose trails for a place ([#194](https://github.com/konnektr-io/kiseki/issues/194))
- **Archive from a photo batch** — EXIF/GPS → a trip skeleton to fill in ([#192](https://github.com/konnektr-io/kiseki/issues/192))
- **Installable PWA** — the manifest and icons are already in place; the offline service worker is the
  gap ([#11](https://github.com/konnektr-io/kiseki/issues/11))
- **Notifications** — live updates over SSE, Web Push and Telegram ([#12](https://github.com/konnektr-io/kiseki/issues/12))
- **The last of the social epic** — profiles, follows and the feed have shipped; this is what is left
  ([#14](https://github.com/konnektr-io/kiseki/issues/14))

## Contributing

Pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, tests and the
conventions this repo enforces. Please report security issues privately, never in a public issue:
[`SECURITY.md`](SECURITY.md).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). © 2026 Niko Raes.
