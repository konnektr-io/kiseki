# Routes while planning: propose trails (and bike / outdoor routes) for a place — #194

Status: research spike + decision. Answers the three acceptance boxes in
#194 (comparison · spike · decision) and generalises beyond hiking per
Niko's note: biking routes and any other outdoor-activity routes are the
same problem with a different OSM `route=` value.

Umbrella: #48 (capture) · sibling: #193 (recorded tracks — GPX → day map) ·
#15 (Places, the "where") · #38 (terrain/DEM) · DESIGN.md §2.2, §8.4.

## The distinction (why this is separate from #193)

#193 **records something that happened** (a GPX file the user brings —
fact, rendered as the shape of the day). This issue **proposes something
that could happen** (a named route that exists in the world — a suggestion
the crew accepts or ignores). Different data, different trust model,
different UI. They share only the rendering: once accepted, a suggestion
feeds the same track geometry + card shape as #193 (DESIGN.md §8.4 —
every line drawn twice, casing + body, trip-preset colour, never a hex
literal).

HERE Routing v8 (`/api/maps/directions`, `maps.py`) is road/pedestrian
routing, not trails. Asked for a hiking loop it returns a walk along a
road. It must never be used for this — same reason #193 never routes.

## Source comparison

Three real candidates evaluated (criterion: at least two). All inherit
their geometry from OpenStreetMap, so coverage gradients are shared —
what differs is the *shape of the answer* (named proposals vs
point-to-point routing), the credential/ops cost, and the licence burden.

| | A. OSM route relations via Overpass + Waymarked Trails (+ Trailcatalog) | B. OpenRouteService directions | C. Valhalla (FOSSGIS demo → self-host) |
|---|---|---|---|
| Answers | **Named routes near a point** ("these 6 waymarked hikes start within 8 km") — exactly the planning question | **Point-to-point route between places** (+ `round_trip` option for foot/hiking) — a computed line, not a proposal | Same shape as B (route between points, pedestrian/bicycle costing) |
| Activity profiles | `route=hiking`, `route=bicycle`, `route=mtb`, `route=horse`, `route=ski` … — hiking *and* biking/outdoor fall out of one query by swapping the tag. Waymarked Trails runs a dedicated subdomain per profile (hiking / cycling / mtb / skating / riding / slopes) | `foot-walking`, `foot-hiking`, `cycling-regular`, `cycling-road`, `cycling-mountain`, `cycling-electric`, wheelchair | pedestrian, bicycle (+ multimodal/transit — unused here) |
| Auth / quota | **No key.** Overpass public API (fair-use, timeout-guarded queries); Waymarked Trails route pages + downloads are open; Trailcatalog.org (Aug 2024, OSM-community project) organises OSM trails globally with distance + elevation | **API key, server-side.** Free tier ~2 000–7 000 req/day; key must stay backend-side (same proxy pattern as HERE / Places — browser never calls the provider) | **No key for the demo** (`valhalla1.openstreetmap.de`, FOSSGIS fair-use + `X-Client-Id` header; explicitly not for production end-user traffic). Production = self-hosted tiles |
| Licence | **ODbL** (OSM). Attribution `© OpenStreetMap contributors` on every suggestion card *and* in the booklet print; route geometry stored on the trip is rendered Produced Work — keep the attribution string with the data so print can't drop it | OSM data under the hood + HeiGIT ToS on top; attribution required; generated routes are short-lived planning artefacts — do not persist beyond the trip (mirrors the HERE ≤30-day rule) | Self-hosted: OSM ODbL only, no vendor terms. Cleanest licence posture, heaviest ops |
| Coverage: Canada Rockies | Good — Banff/Lake Louise trail relations are well mapped (see spike) | Good wherever OSM paths exist | Same as B |
| Coverage: Hokkaido | Good — Japan OSM is dense | Good | Same as B |
| Coverage: Chilean/Peruvian Andes | **Patchy** — backcountry relations are thinner in South America; proposals may come back empty where a computed B/C route still returns *something* (possibly a road walk — the failure mode the issue warns about) | Returns a line wherever the graph connects — which is precisely why its answers need the "suggestion, not fact" framing even more | Same as B |
| Effort to integrate | **Small.** One backend proxy endpoint (Overpass query → named candidates + distance/ascent + attribution), no secrets, no quota plumbing. Fits the existing `/api/places/*` proxy shape | Medium. Key management, quota/rate-limit handling, round-trip tuning, same proxy shape plus secret | Large. Demo is spike-only; production means building + refreshing planet/regional tiles on home-k8s (disk, RAM, rebuild cron) — an ops commitment, not a feature PR |
| Failure mode honesty | Empty result = honest ("no waymarked routes here yet") | Always returns a line = can look authoritative while being a road walk | Same as B |

Not evaluated as sources (deliberately): AllTrails / Komoot / Outdooractive —
proprietary catalogues with no open API; scraping them repeats the lesson of
#48 (never build on a third-party read path we can't keep). They remain
what they are today: places the *agent* can read in a browser while
researching, never a runtime dependency.

Reference that shaped the comparison:
<https://wiki.openstreetmap.org/wiki/Hiking_maps> (Niko's comment 2026-09-16).

## Spike: one concrete question, one real place

Question (from #194): *"a 12 km loop with ~450 m ascent near Lake Louise,
about 4 hours."*

Answer (from citable public sources, no new integration):

- The closest real match is the **Lake Agnes Tea House + Plain of Six
  Glaciers combination** out of Lake Louise: the full Agnes–Six Glaciers
  loop is commonly listed at **~14 km, 4–6 h** (e.g. AllTrails lists the
  Plain of Six Glaciers trail at 8.8 mi / ~1 925 ft gain, ~4.5–5 h;
  Banff & Lake Louise Tourism lists 5.3 km one-way / 365 m to the
  teahouse). A shorter Agnes-only return is ~7.4 km / 435 m / 2.5–3 h.
  There is no exact 12 km / 450 m / 4 h waymarked loop — and that *is* the
  spike result: the honest answer is "nothing matches exactly, here are
  the two nearest real options", which is exactly what a suggestion card
  must be able to say.
- The same question in OSM terms is answerable today without writing
  code: Overpass `relation["route"="hiking"](around:8000,51.4254,-116.1773)`
  returns the named relations around the lake; each Waymarked Trails
  relation page carries mapped length, elevation profile, GPX download,
  and the OSM tags (`distance`, `roundtrip`, `osmc:symbol`). A live
  Overpass probe from the sandbox validated this shape: relations-only
  query `@8 km` returned 2 (`Pipestone Loop Trails`, `Lake Louis Tram
  Line`), `@15 km` returned 10 (mostly Lake O'Hara — access restricted).

  Two findings the proxy seam must encode (no code change here, just the
  reason a future endpoint is not a one-liner):
  - **`sac_scale` ways**, e.g. `way["sac_scale"="mountain_hiking"]`, are
    *not* `route=` relations — relations-only misses the headline trails.
    A `@8 km` `way["sac_scale"](around)` probe returns 26, including
    `Lake Agnes Trail`, `Plain of Six Glaciers Trail`, `Big Beehive` /
    `Highline Trail`, `Fairview Lookout`. Any proxy that wants the named
    hikes visible to hikers must query **relations AND `sac_scale` ways**
    (or lean on Waymarked rendering, which folds both together).
  - Overpass answers HTTP **406 without a proper `User-Agent`**; the
    public API also rejects `Accept` it does not advertise. A production
    proxy must send an identifying UA (e.g.
    `Kiseki-route-proposal/1.0 (+https://kiseki.konnektr.io)`) and an
    explicit `Accept: application/json`, and keep queries timeout-guarded
    (synchronous Overpass turbo limits — ~25k elements) rather than ever
    hitting it from the browser.

So the data exists, it is reachable keyless, and the "no exact match"
case — the case that decides the UI shape — is real and must be designed
for.

## Decision: manual / agent-research behaviour (not a build, not parked)

**Do not build suggestion cards now. Do not park the knowledge either.
Make it a manual/agent-research behaviour:**

1. When planning, the content agent researches routes the way it already
   researches venues: Waymarked Trails (per-profile subdomains cover
   hiking, cycling, MTB, …), Trailcatalog.org, ORS public map for a
   sanity line — and writes the pick into the trip as an ordinary
   **activity block with links + attribution**, optionally with a GPX
   attached through the #193 path once that ships (so the accepted route
   renders as the shape of the day for free).
2. No new endpoint, no new UI, no new secret, no new ops. The HERE
   routing path stays road-only; the Places path stays the "where".
3. The trigger for revisiting: repeated agent-research friction on real
   trips (measured in content-agent sessions, not in theory) — at which
   point the seam is **one proxy endpoint on candidate A** (Overpass +
   Waymarked, keyless, smallest effort, honest empty states), with
   suggestions rendered visually distinct from trip content and requiring
   explicit acceptance (the #194 criterion stands, just deferred).

Why not B/C now: both answer a different question (computed line, not
named proposal), both add a credential or an ops commitment, and both can
produce confident-looking road walks in exactly the regions (Andes) where
our trips go. Candidate A is the only source whose shape matches the
question — and its shape is consumable by the agent today with zero code.

## What this PR contains

- This document (`docs/routes-planning-194.md`) — the written comparison,
  the spike, the decision. Closes the first three acceptance boxes of
  #194; the fourth ("if built…") is explicitly deferred with its trigger
  named above.
- No code, no model change, no migration — nothing to release or deploy.

## Generalisation note (biking / outdoor)

Nothing in the decision is hiking-specific. OSM `route=bicycle` /
`route=mtb` relations and the cycling/MTB Waymarked subdomains give the
agent the same research path for bike routes; ski/horse/skating profiles
exist on the same seam. Any future proxy endpoint takes the activity
profile as a parameter (route tag + Waymarked subdomain), not as a
second implementation.
