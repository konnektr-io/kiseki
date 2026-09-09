# M3 — Kiseki chat: agent relay, per-user identity, file upload

Issue #9 (agent backend + chat UI). Branch `feat/9-chat-endpoint`.
Status: **proposed** — this doc is the review artifact for the backend slice.

## Topology (verified against the live cluster, 2026-09-09)

```
React SPA (kiseki pod, ns kiseki)
   │  POST /api/chat            (Auth0 bearer, Vercel-ai SSE out)
   ▼
kiseki FastAPI backend (same pod)          ← the NEW relay + files endpoints
   │  POST http://hermes.hermes.svc.cluster.local:8646/v1/chat/completions
   │        (API_SERVER_KEY bearer, model "kiseki", stream)
   ▼
Hermes api server (ns hermes, port 8646)   ← the kiseki profile's OWN gateway
   │  (gateway-kiseki s6 service already runs `hermes -p kiseki gateway run`)
   ▼
kiseki content agent: tools = write API (M2M + act-as), web, media
```

Ground truth gathered this session:

- `hermes` Service (ns `hermes`) already exposes `api:8642`, `dashboard:9119`,
  `webhook:8644` → **add `chat:8646`** (targetPort 8646) for the kiseki app pod.
- `gateway-kiseki` s6 service **already runs** (`hermes -p kiseki gateway run
  --replace`, started 2026-09-08 for bot-mode DMs) — it is the natural host for
  the profile's API server. No new process, no subprocess from the app pod.
- The kiseki profile `.env` has **no** `API_SERVER_*` yet → add
  `API_SERVER_ENABLED=true`, `API_SERVER_PORT=8646`, `API_SERVER_KEY=<secret>`
  (or serve via the default gateway's `/p/kiseki/` multiplex — rejected: the
  profile gateway already exists and keeps agent credentials scoped).
- kiseki deployment env already carries `KISEKI_AGENT_CLIENT_ID` +
  `KISEKI_AGENT_ACT_AS` (single-user pin, temporary per #9) → the relay reuses
  these; `KISEKI_AGENT_ACT_AS` remains the no-envelope fallback.
- API server / chat-completions streaming emits per-event SSE frames
  (`assistant.delta` / `tool.progress`, and OpenAI-compat `data:` frames on the
  `/v1/chat/completions` surface). The relay translates to Vercel-ai wire
  format (`data: 0:"<json delta>"` … `data: d:"…finish…"`).

## 1. Identity — bearer always checked, sub = token or act-as (Niko's rule)

Every `/api/chat` + `/api/files` request **must** carry a bearer token. The
actor sub is resolved in this order (extracted into one helper used by both
routes — the #142 lesson):

1. Validate the bearer token (`get_current_user`, existing).
2. **User token** (gty != client-credentials) → actor sub = `token.sub`
   (mode 1: the chat UI passes the end user's own Auth0 token).
3. **Sanctioned M2M token** (`acl._is_agent_token`) → actor sub = the
   **request-scoped act-as** value, taken from the `X-Act-As-Sub` **header**
   (header over query param — Niko's call; header is not logged in URLs, and
   Vercel-ai sends no query on the stream), or falls back to the static
   `KISEKI_AGENT_ACT_AS` env pin with a deprecation warning. A bare M2M token
   with **no** act-as anywhere → 401 (a service principal has no user
   identity to scope a chat to).
4. The resolved sub is validated the way `_agent_actor` does today: when the
   request names a trip, the sub must hold a real crew role on it (follower+
   to read/chat about it; editor+ when the agent may edit). The agent never
   writes outside the acting user's real role.

Cross-user isolation is enforced by the kiseki API ACL on every agent write
(the agent calls back into the same API with the M2M token + the envelope's
act-as sub) — never by prompt discipline alone (spec §8 rule).

## 2. `/api/chat` — authenticated relay + SSE translation

Request (Vercel-ai `useChat` default shape):

```json
{ "messages": [{"id": "…", "role": "user", "content": "…"}],
  "tripId": "bf29a027-…" }
```

Behavior:

- Resolve actor sub (above). Attach an **identity envelope** as a system
  message injected ahead of the user messages: acting sub + their role on
  `tripId` (if any) + "you may edit content the acting user can edit; your
  write-API calls carry act-as sub `<sub>`". This is how the per-request
  identity reaches the agent — the api server has no per-request act-as field.
- Forward to the Hermes api server:
  `POST http://hermes.hermes.svc.cluster.local:8646/v1/chat/completions`,
  `Authorization: Bearer $KISEKI_HERMES_KEY`, body `{model: "kiseki",
  messages: [envelope, ...messages], stream: true}`. `tripId` and any file
  URLs arrive inside the user content parts (`image_url` parts pass through —
  the api server supports inline image URLs).
- Translate the upstream stream to **Vercel-ai wire format** for the SPA:
  - `assistant.delta` events / OpenAI `delta.content` → `data: 0:"…"\n\n`
  - `tool.progress` / reasoning events → `data: 2:"{…tool…}"\n\n` (optional
    v1: skip; text deltas + done are enough for the first cut)
  - terminal → `data: d:"{…finish…}"\n\n`
  - `X-Accel-Buffering: no`, `Cache-Control: no-cache`.
- Any auth failure → 401/403 JSON (never a 200 HTML shell — SPA catch-all
  scoping from #120 applies to `/api/*`).

Streaming state: each request is stateless (the full `messages` history is
sent each turn), matching the api server's chat-completions contract and
keeping the relay free of session bookkeeping.

## 3. `/api/files` — upload to the trip's Garage bucket, return URL

Hermes' api server accepts **remote image URLs inline** but **no uploaded
files and no non-image `data:` URLs** — so files must reach a URL first
(Niko's Garage instinct, confirmed as the only option):

- `POST /api/files` — multipart: `file` + `tripId` (+ optional `kind`).
- Auth + actor resolution identical to `/api/chat`; requires **editor+** role
  on `tripId` (files attach to trip content).
- Stream the bytes to Garage via the **existing** S3 media store — add a
  `put()` to `MediaStore` (`S3MediaStore.put` via minio `put_object`;
  `LocalMediaStore.put` for tests) using the existing content-addressed key
  helper (`content_addressed_key(raw, ext)` → `sha256[:32].ext`).
- Return `{"url": "/media/<trip_dtid>/<sha256[:32]>.ext"}` — the same shape
  `resolve_media_urls` already emits, so the SPA can drop it straight into
  the next chat message as an `image_url` part (images) or a text link
  (docs/PDFs the agent fetches over HTTPS via its own web tool).

This keeps every file under the trip's own media namespace + ACL (the
`/media` proxy already gates by trip visibility/role) — no cross-trip blob
store, no raw bytes through the chat endpoint.

## 4. Config & secrets

- kiseki deployment env (k8s): `KISEKI_HERMES_URL=http://hermes.hermes.svc.cluster.local:8646`
  (config.py: `os.environ.get("KISEKI_HERMES_URL", "")`), plus
  `KISEKI_HERMES_KEY` from the `kiseki-hermes` secret (mirrors `kiseki-s3`).
- kiseki profile `.env` (this repo's deployment step, applied separately):
  `API_SERVER_ENABLED=true`, `API_SERVER_PORT=8646`, `API_SERVER_KEY=…`
  → restart `gateway-kiseki` → add `chat:8646` to the hermes Service.
- No new credentials minted per request: the agent's own M2M credentials do
  the write-API calls; the envelope's act-as sub is what the agent passes
  through its existing `kiseki_api.sh` wrapper (extended to accept an
  `ACT_AS` override per call instead of only the env pin).

## 5. Files in this slice (backend only)

- `backend/app/chat.py` — relay service: actor resolution (shared helper),
  upstream client (httpx), SSE translation.
- `backend/app/acl.py` — `actor_sub_from_request(user, x_act_as_sub_header)`
  helper next to `resolve_actor_sub`; shared by chat + files + auth/me.
- `backend/app/media.py` — `put()` on both stores + content-addressed upload.
- `backend/app/config.py` — `KISEKI_HERMES_URL`, `KISEKI_HERMES_KEY`.
- `backend/app/main.py` — routes `POST /api/chat`, `POST /api/files`
  (registered before the SPA catch-all; `/api/*` already excluded from it).
- `backend/tests/test_chat.py` — (a) user token → own sub; (b) M2M + act-as
  header → header sub, validated against crew role; (c) M2M no act-as + env
  pin → pin w/ warning; (d) M2M no act-as no pin → 401; (e) SSE translation
  of an upstream `assistant.delta` sequence to `0:` frames; (f) `/api/files`
  returns the content-addressed `/media/<trip>/<hash>.ext` URL (fake graph +
  LocalMediaStore); (g) files requires editor+; (h) claims route still 403s
  M2M (regression).

## 6. Out of scope for this slice (later PRs)

- Frontend chat panel (separate PR: `@ai-sdk/react` `useChat` + shadcn,
  Generative-UI cards for content proposals later).
- Per-user agent memory (#10) — the envelope carries identity; memory nodes
  in the graph come with #10.
- Removing the `KISEKI_AGENT_ACT_AS` static pin — it stays as the fallback
  until the UI ships mode-1 tokens for all users.
- Multi-instance / `hermes peer` — deferred capability (M5).

## Review asks

1. Identity ordering (header act-as over env pin) — confirm.
2. `POST /api/chat` + `POST /api/files` route shapes — confirm.
3. Envelope-as-system-message for carrying the act-as sub into the agent —
   acceptable interim until the api server gains a first-class act-as field?
