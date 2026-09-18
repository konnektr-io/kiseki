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

## Resumption — picking a turn back up (2026-09-14, issue #217)

The relay half shipped in #224 (v0.31.0): it owns the run, keeps **every frame**
of the turn in order, and replays them from any cursor, for 30 minutes after the
turn settles (`TURN_TTL_SECONDS`). None of that was reachable from the SPA, so a
dropped connection still read as "nothing happened" — the answer, the trip edits
and the activity feed were all sitting in a buffer nobody asked for. The rules
below are the client half.

**Asking, not attaching, decides.** `GET /api/chat/turn` is read-only and may be
polled freely. It takes the `turnKey` the client minted, or `threadId` alone (for
a thread opened without a key — it resolves the conversation's most recent turn
and answers with its key, so the caller can adopt it). The answer distinguishes:

| relay says | client does |
|---|---|
| holding it, running | attaches; the turn streams on from where the agent is |
| holding it, settled | attaches anyway — the replayed frames ARE the answer |
| holding nothing | forgets the turn; Reconnect/re-send becomes the user's call |
| could not ask | keeps everything; never attaches on a guess |

That last row is the load-bearing one: **an attach at a turn key the relay has
forgotten does not fail — it starts the turn.** So "could not ask" (offline,
expired session) must never be folded into "nothing there", and the two are kept
apart in the client (`getTurnStatus` throws; only a real negative is `known:
false`).

**Rebuild, don't append.** `useChat` cannot extend the message it was streaming:
`resumeStream()` opens a NEW assistant message, so resuming at the client's
cursor left a truncated bubble followed by a tail starting mid-sentence. The
client therefore drops the turn's own messages and rewinds the attach to frame 0,
letting the replayed frames own one message. Which messages are the turn's comes
from an anchor stored at submit: the **id of the user message that opened it**
(cap-safe, unlike an index) — so a recovered turn renders once, complete.

**Anchors are part of a turn's identity.** The relay keys a turn by
`(actor, tripId, threadId, turnKey)`, so the trip the turn was SUBMITTED with is
what an attach must send, not the trip on screen: a landing thread that gained a
trip mid-conversation would otherwise address a turn that does not exist. The
relay's thread-scoped lookup also checks the unanchored scope for the same
reason — that is the ordinary "the agent created the trip in this turn" path.

**Turn identity vs. context anchors (#330).** `tripId` and `focus` are CONTEXT:
they tell the AGENT what the conversation is about and are deliberately NOT part
of the turn key — a reconnect (`getTurnStatus` sends `threadId` + `turnKey` +
`tripId`, never a focus) must keep resolving the same turn. What context does:

- `tripId` → gated (the caller holds follower+ on it) and, since #330, **named
  to the agent**: `identity_instructions` states the trip's title, id, stage,
  dates and day count and tells the agent never to ask which trip it means. It
  used to collapse to a boolean scope sentence — the relay knew the trip and
  never said so, so a first message in a trip drawer (empty history, nothing to
  infer from) ended in "which trip do you mean?" after 20 tool calls of
  guessing.
- `focus` → `{entity: day|section|block, id}`, the entity whose "Ask the agent
  about this" (#296) opened the drawer. The relay resolves it against the trip
  document it already fetched for the ACL gate and names it ("day 4 of 17 —
  …"), so the context survives the user rewriting the composer draft. It is an
  ID, never prose: the human label comes from the graph, so no browser can
  write the agent's instructions. A stale id degrades to a neutral line rather
  than failing the turn.

**The Reconnect banner is the last resort, not the mechanism.** It used to be
gated on the relay's `interrupted` marker, which only arrives on a stream someone
is still reading — a hard disconnect delivers nothing, so the one affordance
there was could never appear. Opening a thread now recovers the turn by itself;
the banner is left for the case where the relay holds nothing and re-sending is
genuinely the only way forward (`shouldOfferReconnect`).

**A recovered turn also refreshes the trip.** A resumed turn settles in one
burst, so the `busy` window that triggers the post-turn refetch (issue #179) is
not guaranteed to render. The attach outcome latches the same refetch, so the
edits the agent made while nobody was watching are visible when the thread
reopens rather than hidden behind a stale document.

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

> **RESOLVED (#296 phase 2 → #330).** The day/block case arrived as the "ask
> the agent about this" bridge on the day, itinerary-section and block
> surfaces, and the answer is a request anchor rather than composer text: the
> SPA sends `focus: {entity, id}` with the turn, and the relay names the entity
> in the agent's instructions (see *Turn identity vs. context anchors*). The
> trip anchor was fixed in the same pass — it had never been named to the agent
> at all, which is what made a first message in a trip drawer ask "which trip?".

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
