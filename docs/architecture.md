# Architecture

Kiseki is a small system with a deliberate shape: **one document, one map surface, one container**,
and the trip's data is never duplicated into code or build artefacts.

```
                              ┌──────────────────────────────┐
   Browser (React SPA)        │ Konnektr Graph (AGE/Postgres) │
   ┌───────────────────┐      │ DTDL v4 twins + edges         │
   │ one MapLibre map  │      │ = the trip document           │
   │ inline edit (E+)  │      └───────────▲───────────────────┘
   │ chat panel        │                  │ read / write (SDK)
   └─────────┬─────────┘                  │
             │ /api/*, Bearer (Auth0)     │
             ▼                            │
   ┌──────────────────────────────────────────────────────────┐
   │ FastAPI backend — one container                          │
   │  • ACL: visibility + role ladder on every trip route     │
   │  • server-side keys: /api/maps, /api/places, /media (S3) │
   │  • /api/chat → Hermes agent    • booklet → Playwright    │
   │  • serves the built SPA from app/static                  │
   └───┬──────────────┬──────────────┬─────────────┬──────────┘
       │              │              │              │
       Garage (S3)   HERE Routing   Google Places  Hermes agent
       trip media    drive times    place overlay  per-user memory
```

## Components

### Backend (FastAPI, Python 3.13)

Single process, single container. It owns:

- **Reading and writing the trip document.** `app/store.py` is the store; when the graph is
  configured it goes through `app/graph/client.py` (with a short TTL cache) and rebuilds the
  document with `app/graph/convert.py`. When it is not configured — local dev and CI — the store
  serves the committed **anonymised** fixtures in `backend/data/mocks/*.graph.anon.json`. There is no
  runtime file fallback for real data: `trip.json` is authoring scratch.
- **Access control.** `app/acl.py` is the single place a request's role is decided (see
  [data-model.md](data-model.md#access-control)).
- **The HTTP API.** `app/main.py` holds the routes — reads, the write API (`app/write.py`), claims
  (`app/claims.py`), the feed (`app/feed.py`), the chat relay (`app/chat.py`), the agent file inbox,
  media (`app/media.py`), Places (`app/places.py`), TriCount (`app/tricount.py`) and account erasure
  (`app/erasure.py`).
- **Server-side integration keys.** Everything that needs a secret is proxied: `/media/<trip>/<file>`
  for S3 objects, `/api/maps/*` for HERE geometry and drive times, `/api/places/*` for Google Places
  details, photos and search, and `/api/chat` for the agent. **No service key ever reaches the
  browser.**
- **Serving the app and printing it.** The built SPA is served from `app/static`; the booklet PDF is
  rendered by Playwright from the app's own `/t/<id>/booklet` route, so paper and screen share one
  design system. Trip routes (and `/feed`) are served with `X-Robots-Tag: noindex`.

### Frontend (React 19 + Vite + TypeScript + Tailwind v4)

- **One persistent map surface.** `/t/<id>/itinerary` (scan level) and `/t/<id>/day/<n>` (day level)
  render the same `TripMapSurface`; the level is derived from the URL and the map instance stays
  alive between them. `/t/<id>/map` redirects to the scan level — there is no separate map page.
- **Role-gated inline editing.** Viewers read; `editor+` get optimistic write affordances that call
  the same API an agent would.
- **No content in code.** Colours, type and layout come from design tokens,
  including per-trip themes; nothing about a specific trip is hard-coded.
- **Routes:** `/` (landing / my trips), `/join/<claimToken>`, `/feed`, `/u/<sub>`, `/me`,
  `/t/<tripId>/…` (`today`, `itinerary`, `day/<idx>`, `practical`, `crew`, `booklet`).

### Konnektr Graph

The live source of truth. Trips are DTDL v4 twins (`Trip`, `Day`, `Block`, `TripSection`,
`Location`, `Feature`, `Person`, `User`, `FeedEntry`, `Integration`) wired together with
relationships (`hasDay`, `hasSection`, `hasBlock`, `atLocation`, `hasCrew`, `hasFeature`, `follows`).
Reads and writes go through the graph SDK from the backend; content changes are PATCHes to twins, not
file reseeds. See [data-model.md](data-model.md).

### External services

| Service | Used for | Failure mode |
|---|---|---|
| Garage (S3-compatible) | Trip media, private bucket, streamed through an ACL-checked proxy | Local dir fallback when `KISEKI_S3_*` is unset |
| HERE Routing v8 | Driving geometry + live drive times, server-side | Legs render without route lines |
| Google Places (New) | Ratings, reviews, photos — live overlay, never persisted beyond storable ids | Cards render without place detail |
| Auth0 | SPA login (PKCE) + access tokens verified statelessly against the tenant JWKS | Sign-in unavailable; public trips still readable |
| Hermes agent | The chat assistant and its write access | `/api/chat` returns 503 |
| PostHog | Anonymous product analytics, consent-gated | No-op when no key is configured |

## Request flows

**Reading a trip.** `GET /api/trips/{id}` → `authorize_trip_path` decides whether the caller may read
(public trip: anyone; private trip: `follower+`, i.e. a valid token bound to a crew edge). The store
returns the document with the caller's own role as `myRole` and **never** a `claimToken`. Media URLs
are expanded to `/media/<trip-id>/<file>` at serialisation time.

**Editing a trip.** `PUT /api/trips/{id}/blocks/{block_id}` (and the rest of the write API) →
`require_trip_role("editor")` → `app/write.py` patches the twin through the graph SDK. The write API
is the *only* mutation path: the UI and the agent both use it, so they cannot drift apart.

**Claiming crew identity.** The owner shares `/join/<claimToken>`. The invitee signs in, and
`POST /api/claims` transfers the `hasCrew` edge (role + order) from the placeholder Person twin to a
fresh User twin keyed by the Auth0 `sub`, then deletes the placeholder. Following a public trip
(`POST /api/claims/follow`) creates the same edge with `role: follower`. Names and e-mails grant
nothing — only the `sub` does.

**Chatting with the agent.** The SPA posts the user message to `POST /api/chat`; the relay resolves
the acting user, submits a **run** to the agent's Runs API with an idempotency key, and pumps the
run's event stream into a relay-owned buffer. The browser *attaches* to that buffer at a cursor — so
a dropped connection costs nothing, and reconnecting re-attaches instead of re-sending the turn
(`GET /api/chat/turn` resumes, `POST /api/chat/stop` is the only stop). Conversation history lives on
the agent side, scoped per user and trip; the relay sends the new message plus a stable session name.
The agent's writes go through the same API with the user's own role, and credential mechanics are
redacted from everything streamed to the browser.

**Photos.** `POST /api/trips/{id}/photos/propose` (editor+) proposes placements from a batch (EXIF
time and GPS included); `POST …/photos/confirm` attaches the accepted ones to a day or block. The
agent can hand files to the app through the inbox proxy (`/api/files`, `/api/files/promote`).

**Booklet.** `GET /api/trips/{id}/booklet.pdf` re-checks visibility and role, then loads the app's
own `/t/<id>/booklet` route in a headless browser and prints it to A4.

## Design rules worth knowing

- **Content is data.** A trip change is a graph write — never a code change, never a rebuild.
- **One read path, one write path.** ACL and mutation logic live in `acl.py` and `write.py`; routes
  don't open-code either.
- **Public means public, private means crew.** A public trip ignores an invalid token rather than
  failing; a private trip requires a valid one *and* the role.
- **Secrets stay server-side.** Browser-visible values are exactly the Auth0 domain/client id and the
  PostHog ingest key — both public by design.
- **No stale copies.** The booklet, the map and the pages are all views of one document, rendered at
  the moment you ask for them.
