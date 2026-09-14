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
| POST | `/api/trips` | create an empty trip (M4) — body `{"title", "subtitle?"}`; the resolved actor becomes `owner` (act-as OK; act-as never provisions a User twin, #142). Then fill it in one go — `api_write.py fill <trip_id> --file plan.json` (plan shape in `api_write.py --help`) |
| PUT | `/api/trips/{trip_id}` | scalars + stage + theme + dates + `coverStats`/`stats` (#178); `visibility` + `discoverable` owner-only (#196) |
| POST | `/api/me/ensure` | ensure the caller's `User` twin exists without claiming anything (#196) — idempotent; user-token-only (M2M refused 403, act-as included); `ensured: false` when no email, `503` when the graph write fails |
| PUT | `/api/me` | flip the caller's own `User.publicName` opt-in (#196) — body `{"publicName": bool}`, one knob only (anything else 422); user-token-only; 404 with no twin (call `ensure` first); returns the `ensure` shape + `publicName` |
| DELETE | `/api/me` | erase the caller's account (#196 phase C, GDPR art. 17) — crew entries revert to placeholders (same trip-relative name/role/note), `follows` both ways dropped, `User` twin deleted last; user-token-only (M2M refused 403); 404 with no twin; **409 while the caller still owns a trip** (response names the blocking trips — delete or hand them over first); second call 404 |
| GET | `/api/me/export` | portability export (#196 phase C, GDPR art. 20) — one JSON document (`generatedAt`, `profile`, `ownedTrips` full docs, own `crewEntries`, `following`, `followers` with peers' public-ish fields only); user-token-only; 404 with no twin; served as `kiseki-export.json` attachment, no query knobs |
| GET | `/api/users/{sub}` | profile document (#196) — any valid token; 404 with no twin; `email` + `publicName` self-only; `trips` follows the discoverable-only rule (discoverable, or the viewer already has a role) |
| GET | `/api/users/{sub}/followers` · `/following` | drill-in people lists (#196) — capped at 200 entries with the true-total `count`; no email, ever |
| POST / DELETE | `/api/users/{sub}/follow` | follow / unfollow a person (#196) — one-directional, grants NO trip access; user-token-only (M2M refused 403); 400 self, 404 unknown |
| DELETE | `/api/trips/{trip_id}` | owner-only; deletes the trip twin + everything scoped to it (days/sections/blocks/features/crew edges + placeholder Persons; claimed User twins survive). Edges-first cascade (#89 rule); `204` on success, `404` when gone (re-DELETE to confirm) — the terminal affordance for a botched half-create (#163) |
| POST | `/api/files` | multipart upload (chat) — with `tripId`: editor+ trip media; WITHOUT: user inbox → `/inbox/<sha256[:32]><ext>` (content-addressed capability, M4) |
| POST | `/api/files/promote` | move an inbox file into a trip's media namespace — `{"trip_id", "file_name"}`, editor+; a move, not a copy (inbox copy deleted) |
| PUT | `/api/trips/{trip_id}/practical` | whole practical object |
| POST | `/api/trips/{trip_id}/practical/todos` | append todo |
| POST | `/api/trips/{trip_id}/practical/todos/{i}/toggle` | per-item `{"done": bool}` |
| POST | `/api/trips/{trip_id}/days` | insert a day at `index` (default append) — explicit ISO `date` or neighbor-based default |
| PUT | `/api/trips/{trip_id}/days/{day_id}` | title/notes/meta/map (date immutable) |
| DELETE | `/api/trips/{trip_id}/days/{day_id}` | remove a day (its blocks go with it; the last remaining day cannot be deleted) |
| PUT | `/api/trips/{trip_id}/sections/{section_id}` | title, `locationRefs`, or `days` (inclusive `[first, last]` 0-based; rewires the section's `hasDay` edges + twin property; in-bounds + no overlap with another section — a day renders under exactly one section) |
| POST | `/api/trips/{trip_id}/sections` | create a section chapter — `title` (+ optional `days` range, `locationRefs`); no `days` = pure ideation section |
| POST | `/api/trips/{trip_id}/blocks` | create — `container: {"type": "day"\|"section", "id"}` |
| PUT | `/api/trips/{trip_id}/blocks/{block_id}` | edit fields (kind immutable; transport fields only on `transport`; `placeId` pins THE venue for the Google Maps deep link) |
| DELETE | `/api/trips/{trip_id}/blocks/{block_id}` | |
| POST | `/api/trips/{trip_id}/blocks/{block_id}/move` | promote/demote day ↔ section (§7.5) |
| PUT | `/api/trips/{trip_id}/containers/{id}/block-order` | exact-set reorder `{block_ids: [...]}` |
| PATCH | `/api/trips/{trip_id}/crew/{person_id}` | `note` editor+ · `role` owner |
| POST | `/api/trips/{trip_id}/crew` | add placeholder person (they claim later) |
| DELETE | `/api/trips/{trip_id}/crew/{person_id}` | owner-only |
| PUT | `/api/trips/{trip_id}/locations` | replace registry (`locations: [...]`, incl. durable place metadata `placeId`/`address`/`website`/`phone`/`openingHours`/`types`/`wheelchairAccessible` + short-lived `rating`); explicit null clears the field, `[]` clears a list field, absent fields untouched |
| PATCH | `/api/trips/{trip_id}/locations` | named upserts only (match by `id` else `name`; new names append, nothing deleted); explicit null clears the field, absent fields untouched |
| PUT | `/api/trips/{trip_id}/features` | replace editorial overview cards (`features: [...]`, #178) — diff by `title`: kept patched, gone deleted, new created; card order = list position; explicit null clears the field, `[]` empties a list field, absent fields untouched; duplicate titles 422, unknown explicit `id` 404 |
| PATCH | `/api/trips/{trip_id}/features` | feature upserts only (match by `id` else `title`; new titles append, nothing deleted, edge order of existing cards never moves); duplicate titles/ids 409, unknown `id` 404, retitle onto another title 409 |

`order` is always server-managed (never send it); `claimToken` is never
accepted or returned. Agent one-liner: `backend/scripts/api_write.py <method>
<path> [--json '…'|--file -]` — plus the verb set `fill`, `upload`, `promote`,
`photo`, `resolve-places`, `create-trip`.

**Media fields store a BARE filename** (`cover`, `map`, block `images` / gallery
`items`, feature `image`/`images`/`cards[].image`) — the API canonicalizes it to
`/media/<trip_id>/<file>` on read. A stored `http(s)://` value is a hotlink: it
404s when the source moves (a traveler reported exactly that) and cannot be
embedded in the booklet, so the write path now **rejects it with a 422** (#187).
`Location.photo` keeps its documented external-URL option (#95).

**Venue resolution is a tooling step, not a prose rule (#187).**
`GET /api/places/search?q=<venue name>` resolves a name to `placeId` +
coordinates (server-side key, short-TTL cache, `{"available": false}` on a miss —
same contract as the other `/api/places/*` proxies; only `placeId` is durable per
the #15 storage table). `scripts/api_write.py resolve-places <trip_id>` walks a
trip: registry locations without a `placeId` are resolved and patched, and every
activity/lodging/meal/booking block gets its `placeId` from the registry entry
its `location` points at — there is deliberately no free-text venue field (#220:
free text let a venue look pinned while its `place_id` stayed empty, killing its
photos/reviews/location deep links). `fill` runs that pass
automatically and reports `blocks_without_venue` — the blocks whose Maps pill
would otherwise fall back to `maps/search?api=1&query=<city>`.

**Getting a picture in**: `scripts/api_write.py photo "<what the picture shows>"
--trip-id <id>` searches Wikimedia Commons, keeps only reusable licences (CC0 /
public domain / CC BY / CC BY-SA — NC and ND are skipped), downloads, uploads into
the trip and prints the bare filename plus the credit/licence to record. That is
the media pipeline the booklet needs, and the reason the 422 gate above is a gate
rather than a warning.

**Bulk fill — the default for building a trip** (one validated plan, one run;
~11 calls instead of ~100, and the whole 422 class is checked before the first
write): `scripts/api_write.py fill <trip_id> --file plan.json [--dry-run]`.
The plan carries `scalars`, `locations`, `features`, `days` (with `blocks`),
`sections`, `practical`, `crew`; validation rejects unknown `scalars` keys
(TripPatch is `extra=forbid`), non-numeric `cost`, block kinds outside the ten,
out-of-bounds/overlapping section ranges, duplicate day dates and
`order`/`container` in a block body — and warns on a transport without `mode`,
a `from`/`to` matching no location name, or a day with no blocks. It ends with
a re-GET summary (`days_without_blocks` must be empty) and re-runs are
idempotent: days match by date, sections by title, blocks by
(container, kind, title), crew by name. Full recipe the agent reads:
`api_write.py --help`.

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
1. **User's own token** (UI chat / end-user profile): present the acting
   user's access token — ACL + `x-user-id` follow its `sub`.
2. **Act-as (TEMPORARY, single-user interim only)**: the agent authenticates
   with the sanctioned M2M client token and the backend resolves the actor
   as Niko (`KISEKI_AGENT_ACT_AS`) — ACL = Niko's real crew role,
   attribution = his sub. No user token needed. **Since the chat UI shipped
   (v0.24.x, #9 closed 2026-09-10) the pin no longer
   serves the chat path** — the SPA presents the user's own token (mode 1), so
   the actor is the real user. The pin is **deliberately retained** for callers
   with no request envelope: the content agent's `scripts/api_write.py` sends only
   `Authorization`, and the write routes resolve identity through
   `_resolve_actor`/`_agent_actor` (pin only — just `/api/chat` + `/api/files`
   accept `X-Act-As-Sub`, via `acl.resolve_request_actor_sub`). It must never
   become multi-user identity plumbing: deleting it before the write routes
   accept a request-scoped act-as would silently flip unattended writes to mode 3
   (owner-level service principal). Target: per-request identity everywhere — the
   caller presents the end user's token, or the M2M token + a request-scoped
   act-as sub.
3. **Unattended fallback**: M2M token with no act-as → owner-level service
   principal (`KISEKI_AGENT_CLIENT_ID`), last resort only.
Nothing is ever provisioned for the agent (no User twin, no hasCrew edge).
Audience for all tokens: `https://kiseki.konnektr.io`.

**Chat identity (M3, `/api/chat` + `/api/files`) is bearer-first per request**
(`acl.resolve_request_actor_sub`, #9): every request MUST carry a bearer
token; its sub IS the actor UNLESS it is a sanctioned agent M2M token, in
which case the actor sub comes from the **`X-Act-As-Sub` request header**
(mode 2, per-request) or the static env pin (deprecated fallback). A bare
M2M token with no act-as anywhere → 401 (a service principal has no user
identity to scope a chat to). The resolved sub is then gated on the named
trip like any read (follower+ to chat about it, editor+ to attach files)
and forwarded to the content agent as an identity envelope — the agent's
own write-API calls act-as that sub, enforced downstream by the API ACL.

**User-scoped routes resolve the actor** (`acl.resolve_actor_sub`, #142): `GET
/api/trips` (my trips) and `GET /api/auth/me`
follow the RESOLVED identity —
with act-as configured, the agent lists and identifies as the mapped user,
never as `<client>@clients` (which holds no crew edges). `POST /api/claims`,
`/api/claims/follow`, `POST /api/me/ensure`, `PUT /api/me`, `DELETE /api/me`,
`GET /api/me/export` and `POST/DELETE /api/users/{sub}/follow`
PROVISION graph identity (User twin / hasCrew edge / follows edge)
and are **user-token-only** (`acl.require_user_token`): a client-credentials
(M2M) token is refused 403 —
the agent never claims, follows or ensures, and act-as must never provision
identity for the mapped user behind their back (mode 1 only).

**Agent fleet (2026-09-08, #9/#140 — see `docs/spec.md` §8):** two Hermes
agents. The **content agent** (dedicated profile `kiseki`) edits trip content
through this write API only and never touches code; the **code agent** (Niko's
home profile) builds/deploys the app and stewards the content agent's profile,
skills and backup. Content-agent code requests arrive as issues with the
`agent` label (template in #140). Until the chat UI ships, content-agent
writes run M2M + act-as (mode 2, TEMPORARY — Niko); afterwards the UI passes
end-user tokens (mode 1) and the static act-as pin is removed. The content
agent's built-in memory holds no user facts — user/trip memory is graph
nodes (#10).

**Not the content path anymore**: `backend/data/trips/*/trip.json` (local
scratch), reseed scripts (`trip_to_graph.py`, `seed_graph.py`,
`reseed_crew_safe.py`) and PVC copies are MIGRATION-ONLY tooling. Media
(images) still goes through the Garage S3 pipeline (`migrate_assets_to_s3.py`)
— the API accepts and returns bare filenames.

## Trip JSON schema

`backend/app/models.py` is authoritative. Summary:

- **Top level**: `slug`, `title`, `subtitle`, `stage` (`idea|options|shortlist|planned|booked|live|archive`), `startDate`, `endDate`, `token` (the secret share key — appears in URLs; rotate by editing the field), `cover` (image URL), `coverCredit`, `map` (overview route map), `summary` (markdown), `theme` `{preset}` (the preset id is the whole theming contract — one of the 12 curated presets in `frontend/src/lib/theme-presets.ts`: alpine, nordic, desert, monsoon, archive, coastal, highland, ember, tundra, sakura, savanna, nocturne; retired per-trip colour/font/radius/map fields were removed and are rejected by the API with a 422 — UI uses CSS variables, never hardcoded hex), `coverStats` (string[] — cover strip lines), `locations` `[{name, marker?, alias[], lat?, lng?, placeId?, address?, website?, phone?, openingHours?, types?, wheelchairAccessible?, rating?, summary?}]` (places; marker number = position in the array unless `marker` set — drives the ① ②… loop markers AND map generation; `placeId` is the Google place_id, the only third-party key kept indefinitely per the #15 storage rule; `rating` is a short-lived snapshot — the read path strips it once the trip's `updated` is older than 30 days; `summary` is the agent's own editorial text, never Google content), `stats` `[{label, value}]` (at-a-glance row), `features` `[{kicker, title, description (md), image, images[], chips[], cards: [{title, value, description, image, links}], map?, links}]` (editorial overview cards: centerpiece / road trip), `sections` `[{title, days: [first, last], locationRefs?: string[], blocks?: Block[]}]` — `days` is an **INCLUSIVE RANGE**, expanded via `expandSectionDays()` (itinerary + booklet). A section also groups by place (`locationRefs`) and can hold unscheduled ideation `blocks` (before any day exists). In the graph, `TripSection` is a twin with `hasDay`/`atLocation`/`hasBlock` edges. `crew` `[{name, role: owner|editor|viewer|follower, note, contact?}]` — `role` is a `hasCrew` edge property in the graph (trip-relative), kept here only as the data carrier. `practical` `{todos: [{label, done, when?}], links: [{label, url}], notes (markdown), contacts: [{label, value, link}]}`, `days` `[{date (ISO), title, notes (markdown), map (image), meta: [{label, value}], blocks [...]}]`.
- **Block kinds — exactly these ten**: `activity`, `transport`, `lodging`, `meal`, `todo`, `note`, `gallery`, `link`, `booking`, `custom`.
  - Shared fields: `title`, `time`, `description` (markdown), `links` `[{label, url}]`, `cost` (number), `currency` (code), `status` (`planned|booked|done`), `bookingCode`, `order`, `location` (place name/alias → auto Google Maps pill + mini MapLibre thumbnail; point it at a venue-level `locations` entry to pin the venue), `placeId` (THE venue's place_id — the deep-link key for the Google Maps pill AND the photos/reviews overlay, keyless URL form; deliberately the same name as `locations[].placeId`), `images` (asset URLs → 1–2 image media strip).
  - `todo`: `items` `[{label, done}]` · `gallery`: `items` (image URLs) · `custom`: `html` (server-sanitized on write, DOMPurify client-side as a backstop).
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
  `atLocation`, `hasCrew`, `hasFeature`, `hasSection`), not nested documents. `hasCrew`
  carries `role` + `note` + `displayName` (#196, all trip-relative edge props);
  person→person `follows` edges (`User`→`User`, #196) are social only.
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
- **Web (dynamic map)**: `MapView` — **MapLibre GL JS v6** (#18) over a keyless basemap, rendering numbered markers + the real driving route for a set of places. Used inside drive cards (`from`/`to` → the exact leg), the route feature (`"map": true`), and block card thumbnails (single pin, `compact`). Route geometry comes from `GET /api/maps/route/<id>?places=A,B` (backend calls HERE Routing v8 — #15 provider decision, 2026-09; `duration` is HERE's live time-aware `summary.duration` behind the drive-time chip). A per-leg `modes` list (parallel to `places`, derived by `legModes()` in `lib/route-surface.ts` from the leg's matched transport block) makes a declared `flight`/`ferry` leg skip the road query entirely — straight `road: false` geometry, drawn dashed; never a car route for a plane. HERE v8 has no `train` transportMode, so rail keeps the road default.
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
- **Basemap tiles**: OpenFreeMap `positron` — no key, no proxy, desaturated ("quiet basemap, loud trip", DESIGN.md §8.5). One constant, `MAP_STYLE_URL` in `lib/maps.ts`, overridable via `VITE_MAP_STYLE_URL` — that is the seam for self-hosted PMTiles on Garage (per-trip map identity is the preset's own `mapStyle`, #40).
- **No provider in the browser (#27)**: `GET /api/maps/key` is **gone** (explicit 404 — the SPA catch-all would otherwise answer 200 with the index shell). Routing stays server-side (MapLibre renders, it does not route); the client only ever talks to `/api/maps/route`. **Never reintroduce a client-side credential.** Traffic-awareness comes from HERE Routing v8 (`summary.duration`, live time-aware — `app/here.py`); there is no client-side traffic layer to load.
- **Addressing**: `/api/maps/route` takes the trip **`$dtId`** (id-based since #64 — no share
  tokens remain). Public trips are reachable anonymously; the unguessable id and the rate
  limiter (60/min, `app/ratelimit.py`, per pod) are the bounds.
- **PDF/booklet (#37)**: the SAME `MapView` renders live in the booklet via Playwright+SwiftShader — basemap, marker numbering and route colours are identical on screen and on paper. Headless Chromium launches with `--use-gl=angle --use-angle=swiftshader` (WebGL2 via software) and the renderer waits for `document.fonts.ready` + every `[data-maplibre]` to reach `data-map-ready` (MapLibre `idle`) before `page.pdf()`. `TripMap` is now a thin wrapper around `MapView` — the old `print:hidden` / `hidden print:block` split and the `GET /api/maps/static` proxy are deleted.
- **Terrain (#38)**: `lib/terrain.ts` adds a shared `raster-dem` source (Mapterhorn, terrarium, keyless), an `igor` hillshade and runtime contours (`maplibre-contour`, minzoom 10) BELOW the basemap's roads and labels — found by layer *type*, not id, so a style swap (#40) does not break the ordering. `DEM_MAXZOOM = 12` is deliberate: global GLO-30 coverage stops there (Sahara/Outback/Andes 404 at z13; BC reaches z15), so capping upscales instead of leaving holes. 3D terrain attaches lazily on `pitchstart` (invisible at pitch 0, so the flat view pays nothing) behind `TERRAIN_3D`; the compass reveals itself only when the map is off north or tilted, and resets both. #40 wires the per-trip switch. Failures are swallowed: no hillshade beats no route.
- **WebGL2 is mandatory** in MapLibre v6 (no WebGL1 fallback) — `MapView` shows a styled placeholder when WebGL2 is absent or the style/tiles fail (`data-map-failed="true"` so the PDF waiter can resolve). Never an empty grey box.
- Routing credentials live in the `kiseki-here` k8s secret (`HERE_ACCESS_KEY_ID` / `HERE_ACCESS_KEY_SECRET` / `HERE_TOKEN_ENDPOINT_URL`; see `app/here.py`) for Routing v8. Absent → routes simply don't render (straight dashed lines; no crash). OAuth2 bearer tokens are minted server-side (`app/here.py` — RFC 5849 client_credentials) and cached for their ~24 h validity.

## Analytics (PostHog — issue #21)

Self-hosted-on-home-k8s was the original preference, but Niko chose **PostHog Cloud
(EU)** for now: an org already exists, the free tier covers a project this small, and
EU cloud satisfies the spec §8 data-residency posture. Umami remains the lighter
self-hosted option if the ≥90 KB gzipped SDK ever becomes a problem (see the bundle
numbers below).

**Trip URLs carry secrets, so analytics is non-standard here.** `/t/<id>` is what a
public trip is readable by, and `/join/<claimToken>` grants a crew identity. Every
analytics SDK records page URLs by default — a naive install would export each trip's
access capability to a third party, into dashboards and exports. The rules, all
enforced in `frontend/src/lib/`:

- **Paths are rewritten before an event leaves the browser** — `/t/<id>` → `/t/:token`,
  `/join/<x>` → `/join/:token`, query string and fragment dropped. This happens in the
  SDK's `before_send` hook (`lib/analytics-privacy.ts`, wired in `lib/posthog.ts`),
  client-side and pre-request — deliberately NOT a PostHog-UI display filter, which
  filters after ingestion, when the secret is already stored.
- **The scrubber walks EVERY string in `properties`, `$set` and `$set_once`** — it does
  not trust a key list. A rendered-browser probe caught the raw trip id and claim token
  surviving in `$pathname` and in the `$initial_current_url` / `$initial_pathname` /
  `$initial_referrer` values posthog-js keeps in `$set_once`, while `$current_url` looked
  perfectly clean. A guard on `$current_url` alone would have shipped the leak; unknown
  future SDK properties are now covered by construction. `normalizeSecretPath` also
  preserves the input's SHAPE (a bare path stays a bare path) because `$pathname` is a
  path to PostHog and an absolute URL there would corrupt its breakdown.
- **`$referrer` gets the same treatment**: a referral from a trip page otherwise carries
  the secret to the next origin's analytics.
- **Per-trip metrics key on the trip `$dtId`** (a property, `trip_id`), never on the URL.
- **Session replay and heatmaps are globally OFF.** Replay records the URL bar and the
  DOM — private travel plans, crew names, booking codes. A global switch cannot be
  defeated by a routing mistake in the way a per-route gate can.
- **Autocapture is OFF** (it ships element text/attributes, i.e. trip *content*). Only
  navigation events and a small set of explicit product events are sent.
- **Consent-gated cookies, `cookieless_mode: "on_reject"` (Niko, post-v0.25.0).** Analytics is
  **consent-gated**: `components/CookieConsent.tsx` (ported from graph-explorer's
  `cookie-consent.tsx`) asks before the SDK ever initializes — a declined or undecided
  visitor produces ZERO requests (the probe asserts it), and a stored "granted" choice is
  restored on load without re-showing. Once accepted, PostHog runs in its **normal
  cookie-backed mode**: `on_reject` is the documented pairing for a banner (no
  local/session storage and no events until the visitor decides, full mode after opt-in),
  and `initAnalytics` calls `opt_in_capturing()` because `on_reject` starts the client in
  the pending/cookieless state. Declining never initializes the SDK at all, so no
  cookieless fallback events are sent either. The banner's copy says what actually ships —
  accepting sets one first-party cookie — and the strictly-necessary choice cookie
  (`kiseki_consent`, 1y, SameSite=Lax; deliberately NOT graph-explorer's shared
  `cookieConsent` name) is written either way. PDF-render and e2e-probe contexts never see
  the banner and never consent (booklet stays pixel-stable; the probe's zero-event
  assertion stays true).
- **`cookieless_mode: "always"` is a trap here — do not go back to it.** "Always" is the
  mode for sites that deliberately have NO banner: identity becomes a server-side
  daily-salted hash, which is only storable when the project enables *Cookieless server
  hash mode*. Ours does not, so PostHog answers every event with `{"status":"Ok"}` and
  then **discards it**. v0.25.0 shipped exactly that way and collected nothing for a whole
  release while every visible signal was green (HTTP 200, requests delivered, unit tests
  passing). `frontend/src/lib/posthog.test.ts` now pins the mode and the
  `opt_in_capturing()` handshake so neither can be undone silently.
- The automated guard is `frontend/src/lib/analytics-privacy.test.ts`, which asserts a
  raw token cannot survive into an outbound payload.

Pageviews are sent by `components/AnalyticsPageviews.tsx` (the SDK's built-in
`capture_pageview` is disabled so every URL goes through the scrubber). The project
token is a public ingest key baked into `lib/posthog.ts` as a default (same posture as
the Auth0 domain/client id), overridable with `VITE_POSTHOG_*`. Analytics is a no-op
when the token is empty, so local dev and forks ship nothing.

**Verifying a change here needs the rendered-browser probe, not just unit tests** —
`frontend/scripts/probe-analytics-privacy.py` (run `pnpm build` first) drives real trip
and join pages, decodes the gzip bodies the SDK actually POSTs, and fails if a secret
survives in any location field or if no events are delivered at all. Two traps it
encodes, both of which cost real time to find: (a) posthog-js **drops events from
detected bots**, and its matcher treats Playwright's Chromium as one (it substring-matches
"headlesschrome" against `navigator.userAgentData.brands` and flags
`navigator.webdriver`), so a plain headless probe reports "nothing sent" for every config
— the script spoofs a normal Chrome identity first; (b) the SDK flushes `$pageview` on
pagehide via `sendBeacon`, for which Playwright's `post_data` is empty — the bodies must
be read over CDP, and they are raw gzip.

**PostHog project settings (checked over the MCP, 2026-09-10):** `cookieless_server_hash_mode`
stays `0` — it is only required when the SDK sends *cookieless* events. With `on_reject`
plus the consent gate that never happens: undecided and declined visitors never initialize
the SDK at all, and accepted visitors are in cookie mode. Enabling it is not a fix for the
mode being wrong — it would make an `"always"` configuration merely *look* healthy while
reducing every visitor to a daily-resetting hash identity. The PostHog MCP server is wired
into Hermes (`mcp_posthog_*` tools) for exactly this kind of check — and for the check that
would have caught the v0.25.0 defect: query `events` to confirm they are **stored**, not
merely accepted. A 200 from `/e/` proves nothing.

**Bundle impact** (measured, `pnpm build`, gzipped, main app chunk): 306.4 kB before →
**403.0 kB with PostHog** (+96.6 kB). The `posthog-js` slim entry point would land at
357.7 kB (+51.3 kB) and is deliberately not used: it is experimental, needs a deep
`posthog-js/dist/module.slim` import, and silently drops error tracking (the
ErrorBoundary in `main.tsx` calls `captureException`) unless undocumented extension
bundles are attached. #21's ≤5 kB budget cannot be met by any PostHog variant; if the
trip-page weight matters more than the feature set, lazy-loading the SDK (dynamic
import after first paint) or moving to self-hosted Umami are the levers.

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
- **Public vs private trips (#64)** — `visibility` on the Trip twin: `public` serves anonymously at `GET /api/trips/{id}`, `private` requires a crew `hasCrew` edge. `discoverable` (#196) is an ADDITIVE opt-in listing flag (default `False`, owner-only): a discoverable `private` trip may be listed on crew profiles / the follower feed but still requires follower+ to read. Join links carry `claimToken` (copy of the trip's `claimToken`) to let a new user `follow` as `follower` or claim a `Person` placeholder. The graph is the only store; there is no `token` flag and no file fallback.
- Placeholder→real-user migration (#6, `app/claims.py`): a **claim token** (separate secret, sibling of `token`) authorizes claiming a crew identity. `GET /join/<claimToken>` shows the trip + crew; `POST /api/claims {claimToken, personId}` creates the User twin (`$dtId` = auth sub) + transfers the `hasCrew` edge (same role/index) + **deletes the placeholder**. No name/email matching — the user picks the person explicitly.
  - The crew's OWN trip name rides the `hasCrew` edge as `displayName` (#196) — written on add-crew / the create-trip owner edge, carried through a claim, read back as `Person.name` (twin-name fallback for pre-#196 edges). A claim never renames the crew member.
  - `POST /api/me/ensure` provisions nothing new on re-call: it PUTs the caller's `User` twin (user token only — M2M refused 403, act-as included: identity is never provisioned on someone else's behalf) so an account exists before any claim; a graph failure is a `503`, never `ensured: false`. Person→person `follows` edges (`POST/DELETE /api/users/{sub}/follow`) are social only — they grant no trip access. Both are user-token-only (M2M refused 403).
  - **`User.publicName` + the initials rule (#196, phase B)**: listed (discoverable) trips render crew as initials unless a person opts in — one rule, both surfaces. `publicName` (default `False`) flips via `PUT /api/me` (self-only, user-token-only, one knob). On a `discoverable` trip a viewer with no crew role sees every other member as initials (`name` = the initials, plus `initials` + `redactedName: true`; the trip-relative `note`/`contact` are dropped) unless that member opted in; the viewer's own entry and crew/follower+ views are unchanged. A trip that is not `discoverable` renders exactly as before.
  - **Account erasure + portability export (#196, phase C)**: `DELETE /api/me` is the exact inverse of the claim flow (`app/erasure.py` — the claim creates the `User` twin, transfers the `hasCrew` edges and deletes the placeholder; erasure reverts each edge onto a FRESH placeholder, drops `follows` both ways, deletes the twin last; edges-before-twins throughout, #89 rule). The trip renders identically for everyone else (same trip-relative name/role/note); a caller who still owns a trip gets 409, never a silent shared-trip rewrite. `GET /api/me/export` returns one JSON document with the caller's own data only (peers' emails and other users' trip notes never included). Both are user-token-only (M2M refused 403).
  - **Server-side `custom`-block sanitization (#196, phase B)**: `Block.html` is cleaned once, at write (`app/sanitize.py`, nh3 allow-list — text tags, headings, lists, tables, `img`/`a`/`figure`/`video`; `class`/`style`/`href`/`src`/`alt`/`title`/sizing/span attrs; `http`/`https`/`mailto` + image `data:` URLs only; no `script`/`iframe`/`on*`/`javascript:`), so stored HTML is clean for every reader. Client-side DOMPurify stays as a backstop; nothing re-sanitizes on read.
  - **`claimToken` is NEVER included in trip documents** (any route) — it is only obtainable via the owner-only `GET /api/trips/{id}/join-link` (role `owner` required). The read link can never claim.
  - The protected id route reports the caller's `myRole`; the frontend shows an owner-only "Join link" button (copies the join URL).
  - **Profile UI (#196, phase D)**: `/u/:sub` renders anyone's profile, `/me` the caller's own (ensure-once, then the same view with the `publicName` switch and no Follow button); the signed-in `AuthButton` avatar links to `/me`. The trip list is the server's discoverable-only rule rendered verbatim — `myRole` gets the role pill, anything else the `Discoverable` badge.
  - **Adding a route means editing two files**: a new SPA route must be registered in `frontend/src/App.tsx` **and** in the backend's history-mode whitelist (`is_spa_route` in `app/main.py`). Miss the second and in-app navigation works while a deep link or a reload 404s as JSON — that is live in v0.29.0 for `/me` and `/u/:sub`. The SPA tests only run when `KISEKI_STATIC_DIR` points at a built SPA (CI sets `../frontend/dist`), otherwise they silently skip.
  - **Account UI (#196, phase E)**: `/me` renders the self-only `AccountPanel` below the trips — a bearer-blob data export (`kiseki-export.json`, art. 20) and account deletion (art. 17) behind a typed-display-name confirmation. A 409 (the caller still owns a trip) renders the blocking trips as `/t/<dtId>` links and never claims anything was deleted; 404-after-success is its own calm state. The panel keeps its own fetch state so a failure there can never blank the profile, and a successful delete renders a terminal state instead of re-reading a profile that no longer exists. The Auth0 login is **not** deleted — only Kiseki's data; the copy says so.

## Deployment flow (home-k8s)

1. `git tag v0.x.y && git push origin v0.x.y` + `gh release create v0.x.y --repo konnektr-io/kiseki` (CI builds the image).
2. Verify the tag exists: `gh api "/orgs/konnektr-io/packages/container/kiseki/versions?per_page=5" --jq '.[].metadata.container.tags'`.
3. In `home-k8s`: edit `konnektr/kiseki/deployment.yaml` image tag (**no `v` prefix** — metadata-action strips it).
4. `kubectl apply` + `rollout status` (KUBECONFIG = `home-k8s/kubeconfig`).
5. **Post-deploy DTDL check — MANDATORY when the PR diff touched `app/models.py` or `scripts/gen_dtdl.py`** (any property add/rename): run `cd backend && ./scripts/release.sh` (verify → auto-reload on drift → re-verify; read-only when in sync) BEFORE any live write or smoke that touches the new property. Symptom if skipped: the first live write 500s with `Property '<name>' is not defined in the model` (GraphWriteError) while pytest stays green — code and graph models deploy independently. See `docs/post-deploy-dtdl-check.md`.
6. Verify: `curl -s https://kiseki.konnektr.io/api/health`.

## Notes for coding agents

- Read `docs/spec.md` before large changes. Ask before changing the data model or adding dependencies.
- Backend is small and boring on purpose. Frontend is read-only for `viewer`/`follower`/anonymous; `editor+` see inline write affordances (todo toggles, block edit/reorder/delete, section→day promote, stage, owner-only visibility) — **the server is always the enforcement point** (hiding a button is not access control; the ACL matrix is tested in `backend/tests/test_write_api.py`). Booklet/PDF output stays untouched (`no-print` chrome, no editable surfaces in the print route).
- Do not add SSR, a state library, or a component framework to the frontend without checking in first.
- Playwright browsers: the Docker image installs chromium (`--with-deps`); locally, `python -m playwright install chromium` if you need the PDF endpoint (optional — API tests skip it when browsers are missing).
