# Kiseki code-cleanup review — 2026-09-21

Branch: `feat/code-cleanup-review` · worktree: `/opt/data/.worktrees/kiseki/feat-code-cleanup-review`
Baseline: `main @ 267fdc5` · `tsc --noEmit` clean · backend `847 passed, 12 skipped`

This is a **read-only review** — no behaviour changed. It answers three questions:
1. Unused methods/components?
2. Duplicate code?
3. Should we add subfolders for structure?

## TL;DR

- **Almost no true dead code.** One prod-dead function in the frontend
  (`logEditIntent`), nothing prod-dead in the backend that I could prove —
  every "unused-looking" backend helper is either used internally, used by
  tests, or a FastAPI route (wired by decorator, not by call).
- **Real problem is structure, not dead code:** two god-files in the backend
  (`main.py` 3249 lines / ~80 routes, `write.py` 2936 lines), three god-files
  in the frontend (`LandingPage` 1420, `chat-panel` 1285, `chat.ts` 1208,
  `RouteMap` 1075, `blocks` 998), and two flat folders (`components/` 34 files,
  `lib/` 46 files) where every new feature lands side-by-side.
- **Duplication is conceptual, not copy-paste.** Line-level similarity between
  the four map components is low (0.13–0.16), but they all re-solve map init,
  WebGL fallback, pin styling and camera padding. Same for
  `blocks.tsx`/`block-edit.tsx` (0.04) and `maps.ts` vs `directions.ts` (0.03):
  shared vocabulary, separate implementations.
- **Recommendation:** phased restructure, no big-bang move. Phase 1 = delete /
  wire the one dead function + extract shared map hook + split `maps.ts`.
  Phase 2 = backend routers. Phase 3 = frontend subfolders (codemodded moves
  so imports follow).

## 1. Unused code

### Frontend — one confirmed prod-dead function

- `frontend/src/lib/edit-intent.ts` → `logEditIntent()` is imported **only**
  by its own test (`edit-intent.test.ts`). Zero prod importers:
  `grep -rn logEditIntent frontend/src` returns the definition + the test.
  History says `#296 phase 3` — the measurement hook was built, the call-site
  in the chat composer was never wired. **Decide: wire it (one `capture()` in
  the composer) or delete the file + test.** Leaving a tracked-but-never-sent
  analytics event is the worst of both worlds.

### Frontend — low-count but NOT dead (verified used once)

These look unused at a glance but each has exactly one prod caller — they are
single-use, not dead. Candidates for folding into their caller or a feature
folder, not for deletion:

| File | Sole prod caller |
|---|---|
| `pages/TripHome.tsx` | `App.tsx` route index |
| `components/HomeFilters.tsx` | `pages/LandingPage.tsx` |
| `components/ItineraryList.tsx` | `pages/TripMapSurface.tsx` |
| `components/TricountPanel.tsx` | `pages/PracticalsPage.tsx` |
| `components/avatar-editor.tsx` | `pages/ProfilePage.tsx` |
| `components/AuthProvider.tsx`, `CookieConsent.tsx`, `AnalyticsPageviews.tsx` | `App.tsx` / root chrome |

### Backend — no prod-dead code found

A naive "defined but never called" scan flags dozens of names, but every one
checked resolves to (a) internal use, (b) test-only use, or (c) a FastAPI route
(wired by `@app.get/post/...`, never called by name):

- `auth.py: parse_api_keys / resolve_api_key / api_key_user / fetch_userinfo` —
  all called inside `auth.py` + covered by `test_apikey_324.py` / `test_acl.py`.
- `photos.py: parse_taken_at / exif_taken_at / trip_local_datetime / match_block / propose_placements` —
  all called inside `photos.py` itself.
- `tracklegs.py: parse_time / duration_between / gap_seconds` — called inside
  `tracklegs.py` + `test_track_ascent_298.py`.
- `store.py: load_trips / get_trip_by_slug` — used by `test_acl.py`,
  `test_api.py`, `test_maps_api.py` (seed/store helpers, keep).
- `tricount.py: reset_cache`, `media.py: clear_media_store`,
  `here.py: decode_flexpolyline`, `maps_links.py: gmaps_url` — used in
  tests and/or internally.
- `main.py` route functions (`auth_me`, `my_trips`, `post_day`, …) — never
  "called", always routed. Expected.
- `write.py: order_blocks` — called by its sibling at `write.py:2154`.

**Conclusion:** do not run a dead-code deleter over the backend. The win is
splitting files, not deleting functions.

## 2. Duplicate / overlapping code

Line similarity (`difflib`, full-file) is low everywhere — this is **shared
responsibility without a shared home**, not copy-paste:

| Pair | Similarity | Note |
|---|---|---|
| `HomeMap` ↔ `LandingMap` (431 vs 336) | 0.16 | both init MapLibre, WebGL fallback, pin classes |
| `RouteMap` ↔ `MapView` (1075 vs 657) | 0.13 | both do basemap tint, route legs, leg glyphs, tracks, terrain |
| `maps.ts` ↔ `directions.ts` | 0.03 | same geo vocabulary, separate fetch paths |
| `blocks.tsx` ↔ `block-edit.tsx` (998 vs 521) | 0.04 | block render vs block editor, overlapping field lists |
| `chat.ts` (1208) ↔ `chat-panel.tsx` (1285) | n/a | transport+threads+upload+transcript in one lib file |

Concrete overlaps worth extracting (not deleting):

1. **Map init block** — all four map components repeat: `loadMapLibre()` +
   `hasWebGL2()` fallback + `MAP_STYLE_URL` + pin class + camera padding.
   Extract `components/map/useMapInit()` (+ `MapFallback` placeholder that
   `LandingMap` already does best — promote it).
2. **`lib/maps.ts` (609 lines)** — basemap tint, labels (`makeMapLabelElement`,
   `selectMapLabels`, chip variants), pins, `fetchRouteLegs`, style resolve.
   Split into `lib/map/style.ts`, `lib/map/labels.ts`, `lib/map/legs.ts`,
   keep `lib/map/index.ts` re-exporting so existing imports keep working.
3. **`lib/chat.ts` (1208)** — threads, `KisekiChatTransport`, upload, transcript,
   activity, focus, resume. Split into `lib/chat/{threads,transport,upload,activity,focus}.ts`.
4. **Media pairs** — `components/photos.tsx`/`lib/media.ts`,
   `components/instagram.tsx`/`lib/instagram.ts`,
   `components/youtube.tsx`/`lib/youtube.ts` are thin-view + helper by design,
   not duplication. They become obvious once co-located (see §3).
5. **Backend trios** — `photos.py`/`exif.py`/`media.py` (taken-at pipeline),
   `places.py`/`maps.py`/`here.py` (geo fetch), `gpx.py`/`fit.py`/`tracklegs.py`
   (track parsing) overlap in responsibility, not lines. Router split (§3) puts
   each trio behind one router module so the seam is visible.

## 3. Proposed structure (subfolders)

Goal: feature folders, barrel re-exports so the move is a pure rename, no
import churn in one PR.

### Frontend `src/`

```text
components/
  map/         HomeMap, LandingMap, MapView, RouteMap, useMapInit, MapFallback
  chat/        chat-panel, chat-drop, chat-composer (when extracted)
  trip/        blocks, block-edit, track-card, DaySummaryRow, ItineraryList,
               TripPinCard, trip-controls, FeedRow
  media/       photos, instagram, youtube, avatar-editor, content-link
  layout/      AppHeader, Sheet, SplitView, ui, theme, AuthButton,
               AuthProvider, AccountPanel, AnalyticsPageviews, CookieConsent,
               HomeFilters
  PlaceFacts.tsx            # shared, stays top-level (4 importers)
  edit-mode.tsx inline-edit.tsx  # editor pair, stays or → trip/
lib/
  map/         maps, maplibre, gmaps, directions, globe, terrain,
               route-surface, tracks, home-geo, leg-glyphs
  chat/        chat(+split), chat-drop
  trip/        editing, edit-intent, sections, dates, day-surface, transport,
               crew, crew-placeholders, following, directions? (no — map)
  media/       media, instagram, youtube, avatar-crop, my-avatar, place-live,
               weather-live
  core/        api, api-apikey, auth, auth-headers, types, tokens,
               theme-presets, color, fonts, seo, marketing, links, sheet,
               posthog, analytics-consent, analytics-privacy, useTripWrite
pages/         unchanged (13 routes, already one-folder-per-route)
```

Rules: colocate `*.test.*` with the file; `index.ts` barrels per folder so
`../lib/maps` keeps resolving during migration; move with `git mv` + codemod,
one folder per PR.

### Backend `app/`

`main.py` has **~80 `@app.*` routes and zero `APIRouter`** — the single biggest
structural smell. Proposed:

```text
app/
  main.py              # app factory + include_router() only (target <200 lines)
  routers/
    me.py              # /api/auth/me, /api/me*, /api/users*, /api/avatars*
    trips.py           # /api/trips*, /api/showcase, /api/trips/geo, /api/feed
    claims.py          # /api/trips/by-claim, /api/claims*
    write.py           # days/sections/blocks/containers/crew/locations/features
    practical.py       # /practical*, /tricount*
    media.py           # /media/*, /inbox/*, /api/files*, photos/propose
    geo.py             # /api/maps*, /api/landing-route, /api/places*, /api/weather*
    tracks.py          # /api/tracks/*
    chat.py            # /api/chat*
    booklet.py         # /booklet.pdf + render lock
    og.py              # /api/og-image/*
  write/               # split write.py (2936): validate, blocks, days, crew, practical
```

Each router keeps the current path strings verbatim — move only, no API change.
`write.py` splits by entity (its `_validate_*` helpers already cluster that way).

## 4. Suggested phases

- **Phase 1 (safe, no moves):** wire-or-delete `logEditIntent`; extract
  `useMapInit` + `MapFallback`; split `lib/maps.ts` with barrel re-export.
  Verify with `tsc --noEmit` + `vitest run`.
- **Phase 2 (backend):** introduce `app/routers/`, move one route group per PR
  (`me` → `trips` → `write` …), keep `main.py` importing until empty.
  Verify with `uv run pytest` (current: 847 passed).
- **Phase 3 (frontend folders):** `git mv` one folder per PR with codemodded
  imports; tests colocate. Verify with `tsc` + `vitest` each time.
- **Non-goal:** dead-code purges beyond `edit-intent`. The scan says there is
  nothing else worth the risk.

## 5. How this was measured

- Import graph: `grep -rhoE "from ['\"]\.\.?/[^'\"]+['\"]"` over `frontend/src`,
  plus per-file reference counts; low-count files hand-verified with
  `grep -rn <Name>`.
- Backend def/use: `^(async )?def` per file vs whole-tree `count()`, then
  hand-checked every "unused" hit against internal callers, `backend/tests/`,
  and `@app.*` decorator wiring.
- Similarity: `difflib.SequenceMatcher` on file line lists (table in §2).
- Sizes: `wc -l` sorted; largest: `main.py` 3249, `write.py` 2936,
  `chat.py` 1505, `LandingPage.tsx` 1420, `chat-panel.tsx` 1285,
  `chat.ts` 1208, `RouteMap.tsx` 1075, `blocks.tsx` 998, `api.ts` 932.
- Baselines: `tsc --noEmit` exit 0; `uv run pytest -x -q` → 847 passed,
  12 skipped (frontend `vitest` not run — `node_modules` absent in worktree;
  `tsc` baseline taken from identical-HEAD main checkout).

---
*Review-only branch. No source files changed — next step is your call on
Phase 1 (recommend: `edit-intent` decision + `useMapInit` extract).*
