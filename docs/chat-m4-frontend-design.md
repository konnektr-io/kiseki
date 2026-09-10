# M4 — Kiseki chat: frontend integration (issues #9, #144 companion scope)

Status: **SHIPPED** · designed 2026-09-09, landed in v0.24.0–v0.24.3 (PRs #147,
#148, #149, #150, #153; issue #9 closed 2026-09-10) · Code agent (Hermes) →
delegate to opencode (muse-spark-1.3-contributor-free). Kept as the **design of
record** — the deltas below are what actually shipped.

Backend relay (`/api/chat`, `/api/files`) shipped in M3 (v0.23.24/v0.23.25).
This slice puts chat in the SPA and closes the loop: the agent can answer
questions, edit the trip you're viewing, and — new in this slice — **create a
new trip from scratch**.

## Shipped deltas (2026-09-10)

- **Transport**: shipped as `@ai-sdk/react` `useChat` + a custom `DefaultChatTransport`
  subclass (`frontend/src/lib/chat.ts`), **not** Vercel `ai-elements`; the relay emits
  `x-vercel-ai-ui-message-stream: v1` SSE (PR #150).
- **Decision 2 superseded**: user-inbox uploads DID ship — `POST /api/files` without a
  `tripId` stages a content-addressed file in `inbox/<hash>` and the agent promotes it via
  `POST /api/files/promote` (PRs #148/#160). Trip-scoped uploads still require editor+.
- **Decision 3 partly overtaken**: the dropped tool events became the *data-part* activity
  feed (PRs #151/#154/#157/#169/#176) rather than waiting for the generative-UI slice.

## Decisions (Niko, 2026-09-09)

1. **Trip creation IS in this slice** — minimal `POST /api/trips` backend
   endpoint: the agent spawns an empty trip, then fills it via the existing
   write API. (No trip-creation existed; trips were graph-seeded only.)
2. **Uploads stay anchored-only** — `/api/files` keeps requiring `tripId` +
   editor+ (already shipped). Files arrive only in a trip-scoped chat, where
   they land in the trip's Garage media namespace. No user-inbox upload in
   this slice. **Superseded 2026-09-10 — inbox uploads landed in v0.24.0 (see
   Shipped deltas).** (Photo-reconstruction flow: create the trip first → chat
   anchored to it → upload photos/docs there.)
3. **Generative UI (PlaceFacts / DaySummaryRow / BlockSummaryRow as agent
   output) is a SECOND pass.** v1 = streamed text + markdown + inline image
   URLs. The relay already consumes-but-drops tool events; v1 must NOT
   preclude forwarding them later (wire format is Vercel-ai SSE — tool
   events map to `d:` frames in a later slice, no breaking change).

## Open question from Niko (needs a call before/at build time)

**Day/block as chat context** — Niko floated using specific days/blocks as
context ("not sure if we should find a way"). Recommendation for v1: **trip
context only** (`tripId` in the envelope); day/block anchoring is a natural
v1.1 (the relay envelope already carries `instructions` — adding a day index
later is additive). Chat is always *about* the trip you're on; the map/day
pages give the agent all the content it needs via the write API's read
paths. **Flag in the plan doc; do not build day-anchoring in v1 unless Niko
says otherwise.**

## Scope

### A. Backend (small, kiseki repo)

**A1. `POST /api/trips` — create an empty trip** (new; there is no
trip-creation route today — trips only exist via graph seeding).

- Auth: `require_user_token`-style — an **owner** must exist, and trip
  creation provisions identity, so it must be a real user token (M2M +
  act-as resolves the actor; the actor sub becomes owner). Follow the
  existing pattern: create the `Trip` twin (`uuid4` → `$dtId`) via the
  write service, add the creator's `hasCrew` edge with `role: owner`,
  defaults `stage: idea`, `visibility: private`, empty content.
- Body: `{title, subtitle?, dates?}` minimum viable; return the public trip
  shape (same as `PUT /api/trips/{id}` returns) so the SPA can navigate
  straight to `/t/<id>`.
- Where: `backend/app/main.py` + a `create_trip` in `backend/app/write.py`
  + `backend/app/graph/client.py` twin-create path (or reuse
  `upsert_twin` + a crew-edge helper — check `claim_crew_person` for the
  edge-writing pattern). Tests: `backend/tests/test_write_api.py` +
  `test_acl.py` (M2M without act-as → 403; user token → owner).
- Content-agent wiring: the content profile's API wrapper
  (`/opt/data/profiles/kiseki/scripts/api_write.py` + `kiseki-trip-content`
  skill) gains a `create-trip` verb so the agent can spawn trips; skill text
  says creation requires explicit user intent ("create a trip") — the agent
  never spawns one unasked.

**A2. Nothing else.** `/api/chat`, `/api/files`, identity, Honcho memory all
shipped in M3. No new media route (upload read-back already works: media is
content-addressed and served URL-open pending the #64 crew-media ACL).

### B. Frontend (the bulk — opencode delegation)

**B1. Chat wire client.** Add `ai` + `@ai-sdk/react` (Vercel AI SDK,
`useChat`). The relay already speaks Vercel-ai SSE (`0:`/`d:`/`e:` frames) —
verify against `backend/app/chat.py`'s exact frame shapes before wiring
(chat.ts line ~200s: response.output_text.delta → `0:`, completed → `d:`,
failed → `e:`). New module `frontend/src/lib/chat.ts`:
- `useTripChat({tripId, threadId})` wrapping `useChat` with a **custom
  `fetch`** that injects `Authorization: Bearer <access token>`
  (`getAccessTokenSilently`, same audience/scope as `lib/api.ts`) and posts
  `{messages, threadId, tripId}` to `/api/chat`.
- Thread identity: `threadId` client-generated (crypto.randomUUID),
  persisted per (user, trip) — localStorage key `kiseki.chat.threads.v1` →
  `{ [tripOrGeneralKey]: string }`. A new chat button rotates a fresh
  threadId (starts a NEW Hermes conversation; the old one remains resumable
  if we later add a thread list — v1 keeps one active thread per context,
  the id is the persistence unit).
- On 401/403 from the relay → surface a sign-in/access error state, never a
  silent blank.

**B2. Chat panel UI.** New `frontend/src/components/chat-panel.tsx`
(shadcn-style cva like the rest; dark + `--trip-*` tokens):
- Message list (user right / agent left), streaming agent text via
  `useChat`'s `isLoading`, markdown rendering reusing `src/lib/markdown.tsx`
  (already exists — check its export/API), inline image URLs rendered as
  images (agent may output `![…](/media/…)` or a bare media URL).
- Composer: textarea + send (Enter to send, Shift+Enter newline), disabled
  while streaming; **attach button only when `tripId` is set** (anchored
  uploads per decision 2): file picker → `POST /api/files`
  (multipart `file` + `tripId`, bearer) → on `{url}`, append to the pending
  message as an `image_url` content part for images (the relay passes
  `image_url` parts through) or a text link for docs. Show upload progress
  + failure inline.
- "Agent is thinking" affordance while upstream tool calls run (the relay
  consumes tool events — no tool-call cards in v1, just the running
  indicator).
- Error banner when the turn fails (`e:` frame → parse and show).

**B3. Mount points.**
- **Landing page (signed-in, trip overview)**: a "Kiseki assistant" chat
  section on `LandingPage` (which today shows "My trips" grid when signed
  in) — general chat, `tripId` absent → agent can answer questions about the
  user's trips, or create a new trip (A1). After a trip is created, offer a
  link/button to open `/t/<newid>`.
- **Inside a trip**: chat reachable from `TripLayout` — a "Chat" nav item
  opening a **side panel** (reuse `SplitView`/`Sheet` patterns from the map
  surface, NOT a full-page route) so the user can chat *while looking at
  the trip* and watch edits land. `tripId` bound → agent may edit
  (envelope already enforces the actor's real role).
- Guard both by `isAuthenticated` (chat requires a user token — M3 identity
  rule: no anonymous chat).

**B4. Tests.** Vitest component tests following existing patterns
(`PlaceFacts.test.tsx`, `TripMapSurface.test.tsx`): mock `useChat`
(@ai-sdk/react is mockable) + mock fetch for `/api/chat` SSE frames; assert
render of streamed text, error state, attach-button visibility
(anchored vs not). Frontend gates: `pnpm build`, `pnpm test`, `pnpm tsc
--noEmit`, eslint **zero NEW errors vs main baseline**.

### C. Out of scope (later slices)

- Generative UI cards (PlaceFacts/DaySummaryRow/BlockSummaryRow) — second
  pass (decision 3).
- Day/block anchoring as chat context (open question, recommended v1.1).
- ~~User-inbox uploads for unanchored chats (decision 2)~~ — **shipped** (v0.24.0; see Shipped deltas).
- Thread list/history management UI beyond one-active-thread-per-context.
- The `/api/chat` relay's dropped tool events (wire is ready; forwarding is
  the generative-UI slice).

## Delegation plan

One opencode run (muse-spark-1.3-contributor-free), **separate worktree +
branch** `feat/9-chat-frontend` off `origin/main` (worktree isolation
rule — main checkout stays clean). Backend A1 + frontend B1–B4 in ONE run
(A1 is small and the frontend's trip-create button depends on its contract).
Gates before merge: backend full pytest (277+new), frontend build/test/tsc,
zero new lint; live browser probe signed-in (Auth0 cache seed pattern from
`kiseki` skill references/editor-mode-blind-spot-104.md) — chat panel opens,
streams a reply, upload shows in a trip chat, trip-create returns a working
`/t/<id>`.

Release + deploy after review; then content-profile skill update for the
create-trip verb (mirror repo) in the same cycle.
