---
type: goal
title: "Kiseki — Product Design Spec"
created: 2026-08-28
updated: 2026-09-08
tags:
  - goal
  - travel
  - product
  - kiseki
  - spec
status: draft
related:
  - "[[Travel App - AI-Native Trip Platform]]"
  - "[[Konnektr Graph]]"
  - "[[Travel]]"
---

# Kiseki — Product Design Spec

## 0. Meta

- **Working name: Kiseki** (軌跡 — "the trail you leave behind"; homophone of 奇跡, *miracle*). Chosen by Niko 2026-08-28. ⚠️ Domain/store availability still to check.
- **Status**: v0.2 draft, second review round incorporated (2026-08-28). Decisions marked ✅ settled, ⚠️ needs your call.
- **Origin**: [[Travel App - AI-Native Trip Platform]] — the booklet/brochure workflow (Canada, Chile-Peru, Japan, …) productized.
- **Revision history**: v0.1 → v0.2 (Niko review 1): React frontend decision; trip.json clarified as P0 storage; agent architecture scoped (current profile → future separate profile); 3 proof trips across stages; #85 fetched and documented; secret-link auth confirmed. → v0.2+ (Aug 31 2026): auth/roles shipped ahead of plan (see P0 auth note below).

## 1. Vision

> Kiseki is the trip as a **living, agent-maintained document**. You plan by talking to your agent, your group plans together, your family follows along as it unfolds — and every change is rendered instantly, on the web and as a beautiful PDF booklet.

**Core loop**: *talk to the agent → agent updates the trip (graph) → app re-renders + notifies → followers see it live.*

**Differentiators** (market research 2026-08-28 — see origin note): conversation-first UX; trip lifecycle as explicit state; role-based sharing; live auto-capture during the trip; per-trip identity/theming; PDF export. No product on the market combines these.

## 2. Scope

**In — Phases 0, 1, 2 only** (agreed with Niko 2026-08-28):

- **P0**: React SPA trip site (multi-page navigation), trip data as JSON behind a secret link, PDF booklet export, hosted on home-k8s, content updates without image rebuilds. Proof = **three trips in different stages**: Canada 2027 (booked), Chile-Peru 2027 (planned), Japan Campervan 2028 (idea) → immediately exercises the stage machine.
- **P1**: Konnektr Graph as source of truth; events → live updates + notifications (web push, Telegram); per-trip theming.
- **P2**: Auth0 + roles (owner/editor/viewer/follower), invites; live integrations (Google Photos, Strava, Maps timeline, steps); per-trip feed. **Stop here.**

**Out — explicitly parked:**
- Public discovery / social network, booking & affiliate engine, app stores (Capacitor) → all Phase 3+.
- Multi-tenancy (ktrlplane) — single tenant, single DB by design.
- Granular graph-level permissions — konnektr-io/pg-age-digitaltwins **#85** (below), deferred.

**Must always keep (requirements):**
1. **PDF booklet export** from the same data (one click / agent command). *Niko: "important that we could still export/generate the pdf booklet".*
2. **Good navigation from Phase 0** — multi-page (overview / itinerary / day detail / practicals / crew), mobile drawer/tabs, prev/next between days. *Niko: "not just a single scrollable page".*
3. Mobile-friendly, fast on phones, readable without an account (secret link).
4. Per-trip look & feel.

## 3. Users & roles

| Persona | Example | Role (P2) | Access |
|---|---|---|---|
| **Planner** | Niko — talks to the agent, owns everything | Owner | Agent + UI |
| **Co-planner** | Nick Geelen, Stefan De Pauw (Canada 2027) | Editor | UI: edit days/blocks/todos |
| **Crew** | trip participants who want the plan | Viewer | read-only |
| **Follower** | parents, kids at home | Follower | read-only + notifications; sees the live journal |

**P0 auth**: ✅ **secret/unlisted share link** per trip (confirmed by Niko). *"Security by obscurity", fine for a trusted group; Auth0 in P2.*
**✅ Shipped (Aug 31 2026, v0.8.0 → v0.12.3)**: the whole P2 auth scope landed early — Auth0 SPA login, JWT ACL (crew role via `hasCrew`, identity = auth `sub` only), Tricount-style join-link crew claiming (claim token, placeholder → user), logged-in "My trips" landing, crew-only PDF booklet, and the public/private model where the share `token` itself is the switch (empty token = private). See README → *Auth & access* and AGENTS.md.

## 4. Core flows

- **F1 — Plan a trip**: Niko chats with the agent ("new trip: Japan Jan 2028") → agent creates the Trip (stage = idea) → researches → builds days/blocks → the site is live immediately → Niko shares the link.
- **F2 — Keep it current**: agent processes a booking confirmation email → updates the booking block, budget, stage → event → re-render + notify followers ("flights booked ✅").
- **F3 — Follow along (mobile)**: follower opens the link → today's plan within 2 taps → during the trip: photos/stats appear automatically (P2).
- **F4 — Export booklet**: one click (or agent command) → PDF booklet at current brochure quality, from the same data. WhatsApp-forwardable.
- **F5 — Edit in UI (P2)**: co-planner adds/edits a block via the app; agent sees the change (event) and can react (re-render, suggest, notify).

## 5. Trip model (the document)

### Stage machine (first-class state)

```
idea → options → shortlist → planned → booked → live → archive
```

- Every transition has behavior: `live` → capture mode + notify followers; `archive` → freeze + final booklet + "the trail" recap.
- Any stage is skippable — last-minute planners jump straight to `live`. **The three P0 proof trips sit in three different stages** (booked / planned / idea) so the UI and the agent both learn to treat stage as real state.

### Document shape

- **Trip**: name, destination, dates, stage, cover, summary (markdown), crew (edges), theme, customCss, customHtml (escape hatch)
- **Day**: date, title, notes (markdown), ordered blocks
- **Block** (kind-discriminated, ~10 kinds total — deliberately small): `activity | transport | lodging | meal | todo | note | gallery | link | booking | custom`. Fields: title, time, location (geo), description (markdown), links[] (label+url), cost, status (`planned|booked|done`), bookingCode, order
- **Person**: name, role, avatar
- **Integration** (P2): kind (photos|strava|timeline|steps), status, tokenRef → **token lives in app secrets, never in the graph**
- **FeedEntry** (P2): type, payload, visibility (`public|crew|followers|private`)

**Principles**: content = markdown (rendered client-side) + typed fields (dates, geo, cost, links). Custom layouts = `custom` blocks + per-trip CSS — **no component zoo, no per-component configuration rabbit hole** (explicitly what Niko wants to avoid).

## 6. Storage — Konnektr Graph ✅ (with P0 pragmatism)

- **P0 pragmatism (✅ Niko-approved)**: a per-trip `trip.json` as source of truth — same shape as the graph data, zero infra. The API serves it behind the secret-link token. Graph migration is mechanical (same document model).
- **Media (✅ shipped, #47)**: images live in the **Garage bucket** (S3-compatible, private, key prefix `media/`), served by the backend at `/media/<trip_id>/<file>` — namespaced by the trip's `$dtId`, never the repo-folder slug (organizational, can collide). **Data stores bare filenames** (no path); the API canonicalizes them to full URLs at serialization. Keys are content-addressed (`sha256[:32].ext`) so they are unguessable and migration is idempotent; the frontend/PDF only ever see full URLs and never care where the bytes live.
- **P1+**: **Konnektr Graph (pg-age-digitaltwins) = source of truth, single tenant, single DB.** DTDL models: `Trip`, `Day`, `Block` (kind-discriminated), `Person`, `Integration`, `FeedEntry`. **Content lives in string fields (markdown/HTML)** — same pattern as Arcadis digital twins (DTDL-driven UI). Structured bits as typed properties; relationships as graph edges (Trip→Days→Blocks, Trip→crew→Person). The *rendered* UI/booklet is generated, never stored.
- **Events**: Konnektr **events service** (pushes to Kafka / webhooks / MQTT) carries every change → live updates to the app (SSE/WebSocket) + notifier. (✅ exists — this is what makes notifications cheap.)
- **Permissions — #85 (fetched via gh 2026-08-28)**: *"Granular twin permissions"* — OPEN, enhancement/backlog. Extend the existing permissions system to twin-level access control via **security tags stored in twin metadata + custom permission strings** (e.g. `digitaltwins/building-a/read`); per-twin checks require fetching the twin first (overhead → caching), and queries may need to carry full twin metadata for filtering. → **Deferred**: P0–P1 trust = secret link + agent discipline; P2 = app-level ACLs via Auth0 claims. Graph-level enforcement only if the product ever goes public.

## 7. Rendering & frontend — ✅ React SPA (per Niko 2026-08-28)

### Resolution of the v0.1 template ambiguity

The v0.1 "render-on-request Jinja" idea blurred two layers: *layout/component code* vs *content*. Niko's call (correct): **if the templates are code, they're components — so use a real framework; if only content + custom CSS is data, then hardcoded components + a data-driven app is the honest architecture.** Trying to avoid a framework would eventually make it more complicated.

### Decision

**React SPA** — Vite + TypeScript + Tailwind + shadcn/ui + Radix primitives.

- **Components are hardcoded in code** — a deliberately small, fixed set (~10), one per block kind (`DayCard`, `TransportBlock`, `LodgingBlock`, `TodoBlock`, `GalleryBlock`, `CustomHtmlBlock`, …). No component-config sprawl: fixed set, content-driven.
- **Content is data, not code** — trip data, markdown, links, costs, theme + custom CSS/HTML blocks all flow from the API (JSON in P0 → graph in P1). **The image contains only app code; a content change never rebuilds or redeploys.** Content update → data changes → clients see it on reload (and live via events/SSE in P1).
- **Navigation** — React Router: overview · itinerary (day list) · day detail (blocks, prev/next) · practicals · crew · (live). Mobile drawer/bottom nav. First-class from P0.
- **Theming** — `trip.theme` (CSS variables: palette, fonts, density, cover) mapped into Tailwind theme at runtime + sanitized `customCss` / `customHtml` escape hatch. Per-trip identity without per-trip code.
- **Markdown** rendered client-side (react-markdown); `custom` blocks render sanitized HTML.
- **Why this kills the "rebuild each time" concern**: static generated HTML was the culprit; a data-driven SPA renders content at runtime, so deploy frequency = code-change frequency only.
- **PDF booklet (requirement)** — print-optimized route (`/trips/:id/booklet`) with an A4 print stylesheet; Playwright (existing pipeline) renders it server-side from the same data. One source of truth, two renderings. The current hand-built booklet HTML/CSS seeds the print stylesheet.
- **Serving (P0)** — small Node (TS) backend: serves the built SPA + `GET /trips/:id` (JSON behind token) + `POST /render/booklet`. One language across the stack; Playwright is native to Node. (FastAPI acceptable if preferred — Niko's call.)
- **P1** — the same backend reads the graph (Konnektr Graph REST or the C# SDK — decide at P1); events service → SSE to the SPA + notifier.
- **Later** — PWA/offline (service worker) from the same codebase; Capacitor when app stores become relevant. Both parked.

## 8. Agent architecture — Hermes ✅ (per Niko 2026-08-28)

### Two-agent fleet ✅ (2026-09-08 — issues #9, #10, #140)

Kiseki agent work is split across **two Hermes agents** that hand off to each other:

| | **kiseki content agent** (dedicated profile `kiseki`) | **code agent** (Niko's home profile) |
|---|---|---|
| Role | The **trip engine**: authoring, research, booking-email processing, content updates through the write API, answering questions | Builds/improves the app (backend, frontend, models/DTDL, releases, deploys) and **stewards** the content agent (profile, skills, backup, session review) |
| Boundary | **Never touches code** — content is data, edited via the write API only | Never edits trip content directly (writes go through the write API under review) |
| Handoff | Files structured code-request issues (`agent` label) when it needs an endpoint/field/UI change (#140) | Triages them on the normal backlog flow, ships them, updates content-agent skills in the same cycle, and reviews content-agent sessions for product gaps |

The content profile is backed up like the work/home profiles (git mirror repo `nikoraes/kiseki-hermes`, daily `push-profile.sh` cron) and can move to a **dedicated Hermes instance** later — the handoff protocol (GitHub issues + Hermes peer DMs) is machine-independent.

- **Identity**: the agent has no identity in the graph (AGENTS.md → identity model). Interim single-user **TEMPORARY pin**: the content profile mints the M2M token and the backend `KISEKI_AGENT_ACT_AS` (static env) resolves writes as Niko. This pin exists only until per-request identity lands and must never become multi-user plumbing — target: the **UI passes the end user's token per request** (mode 1) or the M2M token + a request-scoped act-as sub; the static pin is then removed. Never provision agent twins/edges, never store a personal user token in a profile.
- **User learning** (pivot 2026-09-09, per Niko): per-user memory uses **Honcho, scoped by `X-Hermes-Session-Key`** — the chat relay sends `<sub>` as the session key, and Honcho's session-key fallback gives each user an independent peer (`user-default-<sub>`) with per-user sessions/representation/memory (verified in the honcho plugin: `_resolve_user_peer_id` falls back to the session key when the platform sets no runtime user id, which the api server never does). Honcho is already deployed (ns `hermes`) and already the home profile's memory provider, so this is cheaper than graph memory nodes. **Graph memory (#10) is demoted to optional/later** — revisit only if Honcho's per-user recall proves insufficient (e.g. per-trip scoping on top). Design note: desktop/CLI sessions carry no session key, so they never pollute user memory (desired).
- **Agent memory hygiene**: the content profile's built-in memory holds **no user facts** — only impersonal operational knowledge (endpoints, content conventions). Per-user facts live in **Honcho under the acting user's peer** (session-key scoped); until the kiseki profile enables `memory.provider: honcho`, the agent is **stateless across users** (context comes from the request envelope). Cross-user isolation is a hard requirement, verified by test — never prompt discipline alone.
- **Integrations boundary** (unchanged): per-user OAuth + tokens (Google Photos, Strava, Timeline) live in the **app backend's secret store**, not in Hermes. The agent receives processed context via tools/MCP — no multi-user secret handling in the agent. Per-profile `.env` carries service-level credentials only.
- **Guardrail** (unchanged): the agent only operates on trips it's explicitly pointed at; the app layer is the trust boundary, never the agent.
- **GDPR** (parked until public — trusted group now): EU data residency (home cluster), DPAs with processors, erasure incl. memory, portability = the booklet export, consent for data sources, AI Act transparency. ⚠️ Provider choice (DeepSeek/OpenRouter) is a question *only* when the product goes public — models can be swapped later.

## 9. Events & notifications (P1)

`events service → webhook → notifier → Web Push (VAPID) + Telegram DM (for Niko)`; same events feed SSE/WebSocket live updates to the SPA. Notification vocabulary: stage changes, bookings confirmed, day updates, live-capture milestones (P2). Followers opt in per trip.

## 10. API surface (sketch, P0–P2)

Minimal REST (Node backend):
- P0: `GET /trips/:id` (JSON, token-guarded) · `GET /trips/:id/booklet.pdf` · `POST /render` (regenerate PDF).
- P1: `PUT /trips/:id`, `PUT /days/:id`, `PUT /blocks/:id` (agent/UI writes through the API to the graph) · `GET /events` (SSE).
- P2: `/auth` (Auth0) · `/invites` · `/feed` · `/integrations/:kind/connect` (OAuth — app layer).

Nothing elaborate.

## 11. Phases & milestones

### P0 — Proof: three trips live ✅ (v0.6.1, deployed 2026-08-29)

**Done.** Live at kiseki.konnektr.io: Canada 2027 (booked — the reference), Chile-Peru 2027 (planned, enriched), Japan Campervan 2028 (idea, Hokkaido-only skeleton). What shipped:

- Booklet-faithful design: Bebas Neue/Oswald/Inter typography, sections grouping days (inclusive ranges), expandable day rows, per-kind block styling (dark flight cards with plane icon + `mode` field, dark drive cards with Distance/Drive time/Route + directions, STAY kickers, 1–2 image media strips, mini map thumbnails).
- PDF booklet (Playwright, in-container): full-bleed cover with stats strip, features one per page, day cards with real-route static maps, Bookings & status (with Day/When + booking links) before Key info. No empty pages.
- **Dynamic maps from `trip.locations`**: Google Maps JS in the web app (markers numbered by the trip's own location order, per-leg DirectionsRenderer routes, live traffic, live drive-time chip), server-side static-map proxy for the PDF (real routes via Directions API encoded polylines, geocoded `mapsQuery` pins for hotels/restaurants — see the `kiseki-trip-content` skill for the styled-marker/raw-polyline quirks). Loop maps close back to the start.
- Content-as-data: trip.json → `kubectl cp` to the PVC, no rebuild. Japan 2028 validated this end-to-end; card enrichment (images, booking links, precise map pins) proven on Canada + Chile-Peru.
- Secret-link auth (128-bit tokens, wrong token → 404), stage machine (idea → booked), bookings table mirroring the booklet.
- **Branding & privacy**: generated logo → favicon set (transparent favicon, full PWA icon sizes 48→512 + maskable + manifest), per-trip page titles, content-first header (back button). Trip pages are crawl-proof (`robots` meta + `X-Robots-Tag: noindex, nofollow, noai, noimageai` + `robots.txt` blocking AI crawlers); README public-ready.

**Review gate (2026-08-29)**: Niko confirmed the round; Phase 0 closed. Backlog for P1+ created as GitHub issues (this repo, `backlog` label — first issue flows through the webhook triage).

### P1 — Infrastructure, graph, auth & seed (next)

Order = priority; each independently pick-up-able (issues in this repo's backlog).

- [ ] **CNPG on home-k8s** — CloudNativePG operator + a proper PostgreSQL cluster (the AGE database home).
- [ ] **Garage object storage** on home-k8s (MinIO is no longer supported) — media storage for P1+.
- [ ] **Konnektr Graph helm chart** (konnektr-io/charts) on home-k8s — **API only, not Events (yet)**; image with **pgvector + postgis** (konnektr-io/cnpg-age-containers — may need to build images for **AGE v1.8.0** there first); enable **x-user-id** so `updatedBy` is tracked.
- [ ] **Backend connects via `konnektr-io/graph-client-sdk-python`** (replaces direct trip.json reads as source of truth moves to the graph).
- [ ] **Auth: invites + app-level ACLs** — implemented with the DB integration, **not deferred to P2**. Secret links stay for share; logged-in users get identity + permissions.
- [ ] **Placeholder users → real users**: crew from trips (e.g. "Nick Geelen", "Henri") exist as placeholder nodes; on login, match/replace placeholders with the actual user ids.
- [ ] **Landing page + trip overview when logged in** — "/" becomes the user's trip list (the back button's destination).
- [ ] **Seed the DB from the existing trip.json files** — keep them, but **anonymize a copy as mocks** for testing. Create **DTDL models** (Trip/Day/Block/Person…), ideally **auto-generated from the existing Python models** (or the reverse); keep dev simple — regenerate + replace in the DB.

**Exit**: a logged-in user sees their trips from the graph; a trip edit round-trips through the API + graph + SDK; seeds + anonymized mocks in place; `updatedBy` recorded.

### P2–3 — Agent, memory, PWA, permissions

- [ ] **Agent backend + chat UI (#9)** — dedicated **kiseki content-agent profile** (two-agent fleet, §8); `/chat` endpoint (A2A or Vercel-ai-compatible SSE) passes through with **per-user auth**; frontend chat via **Vercel ai-elements**; cross-user isolation verified by test.
- [ ] **Agent memory per user (#10 — re-scoped to Honcho, 2026-09-09)** — kiseki profile enables `memory.provider: honcho`; per-user peers derive from `X-Hermes-Session-Key` (chat relay already sends `<sub>`). Graph memory nodes + pgvector **demoted to optional** — revisit only if Honcho per-user recall proves insufficient (e.g. per-trip scoping on top).
- [ ] **Agent fleet ops (#140)** — content→code code-request loop, code→content skill updates on API changes, session-review pass.
- [ ] **Installable PWA** (service worker; icon set + manifest already in place).
- [ ] **Events & notifications** (deferred from P1): SSE live updates, web push + Telegram.
- [ ] **Granular per-trip permissions**: public trip → magic link keeps working; private trip → login + explicit permissions.

**Exit**: an agent can answer "what are we doing on day 4?" from per-trip memory; trips are installable; permission model matches public/private semantics.

### P4 — Social

- [ ] Social integrations, feed, followers/following.

**Exit**: remote family follows a live trip. **Stop.**

## 12. Risks & open questions

- **#85** (granular twin permissions) — still backlogged; revisit only if public. P2–3 per-trip permissions are app-level ACLs, not twin-level.
- **DTDL model evolution**: new block kinds = new models; keep the model coarse. Auto-generation from Python models must stay bidirectional-safe (Python stays the source until proven otherwise).
- **HTML sanitization** for `custom` blocks (XSS) — acceptable under link-trust in P0; solve before any public sharing (DOMPurify client-side + server-side).
- **LLM provider / GDPR**: parked until public (trusted group now; models swappable).
- **"Kiseki" availability** (domain, app stores, collisions): still open.
- **P1 backend swap**: trip.json → graph via SDK must keep the P0 API contract stable (the swap is invisible to the frontend).
- **Age v1.8.0 images**: cnpg-age-containers may lag; building images there is a prerequisite for the Graph chart.
- **Anonymized seeds**: real trip.json files stay private (tokens!); only anonymized mocks may ever reach a public repo.

## 13. Success criteria ("done enough" when)

1. A friend with zero setup opens a trip link on their phone and finds today's plan in **≤2 taps**.
2. **PDF booklet export is one click** and matches current brochure quality.
3. Any content change (agent or UI) is **live within ~1 minute, no deploy**.
4. Niko's mom can follow a trip without an account (P0) / with a one-tap account (P2).
5. No component rabbit hole: **~10 block kinds total**, hardcoded components, zero per-component config sprawl.

## 14. Decisions log

### Round 1 (2026-08-28)

| # | Decision | Outcome |
|---|---|---|
| 1 | Frontend | ✅ **React SPA** (Vite + TS + Tailwind + shadcn/ui + Radix); hardcoded components, content as data |
| 2 | P0 source of truth | ✅ **`trip.json`** first (mechanical migration to graph in P1) — Niko raised no objection |
| 3 | P0 auth | ✅ **Secret share link** (confirmed) |
| 4 | #85 permissions | ✅ Fetched (granular twin permissions, backlog) — **defer** for P0–P2 |
| 5 | Proof trips | ✅ **Three**: Canada 2027 (booked) · Chile-Peru 2027 (planned) · Japan Campervan 2028 (idea) |
| 6 | Name | ⚠️ **Kiseki** used as working name; domain/store check still open |
| 7 | Storage (P1) | ✅ **Garage** over MinIO (no longer supported) |
| 8 | Backend ↔ graph (P1) | ✅ **`graph-client-sdk-python`** (Python backend stays Python) |
| 9 | Auth (P1) | ✅ **Invites + app-level ACLs**, implemented with the DB integration (not P2) |
| 10 | Graph deploy (P1) | ✅ **API only, Events deferred**; pgvector + postgis image; x-user-id for `updatedBy` |
| 11 | Agent (P2–3) | ✅ **Hermes as a library** (`AIAgent`) in the backend; chat UI via **Vercel ai-elements** (protocol adapter if needed) |
| 12 | Agent memory (P2–3) | ✅ Pivot (2026-09-09): **Honcho per-user peers via X-Hermes-Session-Key** (#10 re-scoped); graph+pgvector demoted to optional |
| 13 | Seeds | ✅ Keep real trip.json (private); **anonymized mocks** for testing; **DTDL auto-generated** from Python models |
| 14 | Phase split | ✅ P0 done → **P1 infra/graph/auth/seed** → **P2–3 agent/PWA/permissions** → **P4 social**; review gates between phases |

**Review gate for P1**: after CNPG + Garage + Graph chart are live (before SDK/seed work), Niko reviews.

### Round 2 (2026-09-08) — agent fleet (issues #9/#10/#140)

| # | Decision | Outcome |
|---|---|---|
| 15 | Two-agent split | ✅ **Content agent** — dedicated profile `kiseki`, content/write-API only, never code — + **code agent** (home profile: builds, releases, deploys, stewards the profile). Handoff = GitHub issues (`agent` label) + Hermes peer; see §8 |
| 16 | Content-profile memory | ✅ Built-in agent memory holds **no user facts**; per-user memory = **Honcho peer per `X-Hermes-Session-Key`** (#10 re-scoped 2026-09-09). Content agent stateless across users until `provider: honcho` is enabled on the profile |
| 17 | Content-profile backup | ✅ Git mirror repo `nikoraes/kiseki-hermes` + daily `push-profile.sh` cron (same pattern as the work/home profiles); move-ready for a dedicated Hermes instance |
| 18 | Credentials | ✅ Per-profile `.env` = service-level only; end-user OAuth stays in the app backend secret store (§8 unchanged) |

