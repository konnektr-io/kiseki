# HTTP API

Everything the SPA does, it does through this API — and so does the chat agent, with the same access
control. Base path `/api`, JSON in and out, `Authorization: Bearer <Auth0 access token>` on
everything that needs identity.

Trip ids are the trip's `$dtId` (a dashed UUID). Public trips are readable anonymously; private trips
are not.

## Access levels

| Level | Meaning |
|---|---|
| `anon` | No token needed. Public data only. |
| `user` | Any valid Auth0 access token. |
| `follower+` `viewer+` `editor+` `owner` | A crew role on that trip (see [data-model.md](data-model.md#access-control)). Public trips are readable at `follower+` even anonymously; writes always need a real token. |

A `403` means "authenticated but not allowed"; `401` means "no valid token". On a public trip an
invalid token is ignored rather than rejected (public means public).

## Trips

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/trips` | user | The caller's trips (crew membership), as summaries |
| `POST` | `/api/trips` | user | Create a trip (caller becomes owner) |
| `GET` | `/api/trips/{trip_id}` | `follower+` / public | The whole trip document + the caller's `myRole` |
| `PUT` | `/api/trips/{trip_id}` | `editor+` | Update trip-level fields (title, stage, dates, theme, cover…) |
| `DELETE` | `/api/trips/{trip_id}` | `owner` | Delete a trip (409 while edge-holding twins still exist) |
| `GET` | `/api/trips/by-claim/{claim_token}` | anon | The **only** unauthenticated trip read: what a join link resolves to |
| `GET` | `/api/trips/by-follow/{follow_token}` | anon | What a follow link resolves to |
| `POST` | `/api/claims` | user | Claim a crew placeholder with a claim token (creates the user twin) |
| `POST` | `/api/claims/follow` | user | Follow a public trip via its follow token (`role: follower`) |
| `POST` | `/api/trips/{trip_id}/follow` | user | Follow a public trip directly |
| `GET` | `/api/trips/{trip_id}/join-link` | `owner` | The crew invite link — the **only** way to obtain `claimToken` (`404` once the invite is revoked) |
| `DELETE` | `/api/trips/{trip_id}/join-link` | `owner` | Disable the crew invite (clears the claim token; existing crew keep their roles, followers keep following) |
| `GET` | `/api/trips/{trip_id}/follow-link` | `owner` | The follow link — a second, separately revocable secret that grants reading and following but can never claim a crew identity |
| `POST` | `/api/trips/{trip_id}/follow-link` | `owner` | Mint the follow link; minting twice **rotates** it — the previous token stops resolving immediately |

## Content

All content writes are `editor+`. Read everything through `GET /api/trips/{trip_id}` — or
`GET /api/trips/{trip_id}/practical` when only the practicalities matter.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/trips/{trip_id}/days` | Add a day |
| `PUT` | `/api/trips/{trip_id}/days/{day_id}` | Update a day |
| `DELETE` | `/api/trips/{trip_id}/days/{day_id}` | Delete a day |
| `POST` | `/api/trips/{trip_id}/sections` | Add a section |
| `PUT` | `/api/trips/{trip_id}/sections/{section_id}` | Update a section |
| `POST` | `/api/trips/{trip_id}/blocks` | Add a block (typed: stay, drive, activity, meal, note, photo…) |
| `PUT` | `/api/trips/{trip_id}/blocks/{block_id}` | Update a block |
| `DELETE` | `/api/trips/{trip_id}/blocks/{block_id}` | Delete a block |
| `POST` | `/api/trips/{trip_id}/blocks/{block_id}/move` | Move a block to another day/section/position |
| `PUT` | `/api/trips/{trip_id}/containers/{container_id}/block-order` | Reorder a whole container |
| `PUT` / `PATCH` | `/api/trips/{trip_id}/locations` | Replace / patch the location registry |
| `PUT` / `PATCH` | `/api/trips/{trip_id}/features` | Overview cards |
| `PUT` | `/api/trips/{trip_id}/practical` | Practicals (checklist, links, contacts, notes, titled blocks) |
| `GET` | `/api/trips/{trip_id}/practical` | The practicals on their own, without the rest of the trip document (`todos` and `tricount` stay crew-only) |
| `POST` | `/api/trips/{trip_id}/practical/todos` | Add a checklist item |
| `POST` | `/api/trips/{trip_id}/practical/todos/{index}/toggle` | Toggle a checklist item |
| `POST` | `/api/trips/{trip_id}/practical/blocks` | Add ONE titled practicality block — `{"title", "body"}`, optional `index` inserts at that position (default: append) |
| `PUT` | `/api/trips/{trip_id}/practical/blocks/{index}` | Edit ONE practical block — patch semantics: only `title` and/or `body` sent are written |
| `DELETE` | `/api/trips/{trip_id}/practical/blocks/{index}` | Delete ONE practical block |

## Crew and people

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/trips/{trip_id}/crew` | `editor+` | Add a crew placeholder — or, with `sub`, attach an account that already exists (no placeholder, no invite link); that mode is `owner` and only accepts someone the caller follows |
| `PATCH` | `/api/trips/{trip_id}/crew/{person_id}` | `editor+` | Update role, note, display name, order |
| `DELETE` | `/api/trips/{trip_id}/crew/{person_id}` | `owner` | Remove a crew member |
| `GET` | `/api/users/{sub}` | user | A user profile (public name, trips, counts) |
| `GET` | `/api/users/{sub}/followers`, `/following` | user | Follow lists |
| `POST` / `DELETE` | `/api/users/{sub}/follow` | user | Follow / unfollow a person |

## Current user

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/auth/me` | user | Who the token is; the caller's role per trip |
| `POST` | `/api/me/ensure` | user | Ensure the caller's user twin exists (before first claim) |
| `PUT` | `/api/me` | user | Update own profile (display name, public name) |
| `POST` | `/api/me/avatar` | user | Upload own profile photo (image only, no SVG; HEIC → JPEG; content-addressed under `avatars/`) |
| `DELETE` | `/api/me/avatar` | user | Remove own profile photo (falls back to the IdP photo when there is one, else monogram) |
| `GET` | `/api/avatars/{file}` | user | Serve an uploaded profile photo (content-addressed name = capability) |
| `GET` | `/api/me/export` | user | Data portability export (GDPR art. 20) |
| `DELETE` | `/api/me` | user | Erase the account: crew edges revert to placeholders, follows drop, twin deleted (409 while the user still owns trips) |
| `GET` | `/api/feed` | user | The activity feed from followed trips and people |

## Chat and agent files

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/chat` | user | Send a turn to the agent; server-sent events in the Vercel-AI UI-message-stream shape |
| `GET` | `/api/chat/turn` | user | Attach to a run in progress at a cursor (survives reloads) |
| `POST` | `/api/chat/stop` | user | Stop the running turn — the only thing that does |
| `POST` | `/api/files` | user | Upload files for the agent (inbox) — photos, videos and documents, each family streamed to disk under its own cap (64 MB / 1 GB / 32 MB) with a per-file `413` when over; `posterOf=<clip>` adds a video's poster frame. HEIC/HEIF → JPEG at ingest (`converted: true`); undecodable files → per-file 422 (#251) |
| `POST` | `/api/files/promote` | user | Promote an inbox file into trip media / the right attachment point |

The agent's own trip writes use the same endpoints above, carrying the acting user's identity and
therefore the acting user's role.

**Chat attachments (#251).** An upload is never silently dropped or silently unusable:

- The composer counts the batch (`N photos attached · M converted · K failed: <reason>`) and that
  same line is sent as the first line of the message, so a turn that carried 8 files and one that
  carried 10 are no longer indistinguishable in the transcript.
- Two files with the same name are two attachments — uploads are reconciled by identity, never by
  filename.
- HEIC/HEIF (iPhone photos) is transcoded to JPEG on ingest, EXIF (capture time + GPS) intact;
  a file the server cannot decode comes back as a per-file `422` whose message the composer shows on
  the file's chip.
- A video is uploaded as itself — the stack has no transcoder, so the clip the user picked is the
  clip that is stored, and `/media/...` answers byte ranges so the player can seek it. What the
  composer adds is the poster: it captures the first frame in the browser and sends it as a second
  upload with `posterOf=<clip>`, which the server stores as `<stem>_poster.jpg`. Surfaces derive the
  poster from the video's own name, so nothing else had to learn a new field.

## Photos and expenses

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/trips/{trip_id}/photos/propose` | `editor+` | Propose placements for a photo batch (EXIF time/GPS aware) |
| `POST` | `/api/trips/{trip_id}/photos/confirm` | `editor+` | Attach the accepted photos |
| `GET` | `/api/trips/{trip_id}/practical/tricount` | `viewer+` | Cached TriCount expense snapshot |
| `POST` | `/api/trips/{trip_id}/practical/tricount/connect` | `editor+` | Connect a TriCount trip |
| `DELETE` | `/api/trips/{trip_id}/practical/tricount` | `editor+` | Disconnect |

## Maps, places and rendering

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/maps/key` | 404 | Removed ([#27](https://github.com/konnektr-io/kiseki/issues/27)) — the routing token is server-side only. Kept as an explicit 404 so the SPA catch-all can't answer this path with the app shell |
| `GET` | `/api/maps/route/{trip_id}` | anon | Route geometry + live drive times for the place names the caller passes (per-leg transport modes; the response carries no trip data) |
| `GET` | `/api/maps/directions` | anon | One-off route geometry |
| `GET` | `/api/places/search` | anon | Place search (proxied, key server-side) |
| `GET` | `/api/places/details/{place_id}` | anon | Place details (rating, reviews, hours) |
| `GET` | `/api/places/photo` | anon | Place photo bytes (proxied) |
| `GET` | `/api/trips/{trip_id}/booklet.pdf` | `follower+` / public | Print-ready A4 booklet |
| `GET` | `/api/health` | anon | Liveness |

Routes outside the schema (not public API, still part of the app): `GET /media/{trip_id}/{file}`
(streams a stored media object; the path is validated structurally and the object is addressed by the
trip's durable `$dtId` + filename. One byte range is honoured — `206` + `Content-Range`, `416` when
unsatisfiable, `Content-Length` and `Accept-Ranges` always set — so a `<video>` in the UI seeks
through this same route instead of pulling the whole clip again; a crew-level media ACL is the
planned plug-in point, [#64]),
`GET /inbox/{file}` (agent inbox; the key is a content hash, so the name is the capability),
`GET /api/maps/static/{path}` (legacy static-map proxy), `GET /robots.txt`, and the SPA catch-all
which serves the app shell only for `/`, `/t/*`, `/join/*`, `/u/*`, `/me`, `/feed`.

## Conventions

- **Writes are the only mutation path.** The UI and the agent both call these endpoints; nothing
  mutates the graph from anywhere else.
- **`claimToken` / `followToken` never appear in a trip response.** They leave the server only through
  the owner-only link endpoints.
- **Errors** are plain `{"detail": …}` with a meaningful status: `401` unauthenticated, `403` not
  allowed, `404` unknown trip/block, `409` conflicting state (e.g. deleting a trip that still owns
  twins), `422` payload validation.
- **Media fields carry bare filenames** in the data model; the API expands them to
  `/media/<trip_id>/<file>` so consumers never think about storage.
