# Kiseki — Design System & UX Direction

> Companion to [`docs/spec.md`](docs/spec.md) (product) and [`AGENTS.md`](AGENTS.md) (engineering).
> This file is the **visual and interaction law** of the app. Read it before changing anything
> that a user can see.
>
> Status: v1 direction, written 2026-09-01 against `v0.12.3`. Sections marked **NOW** describe
> what the code does today; **TARGET** describes where we're going. Where they disagree, TARGET wins
> for new work — but don't refactor the whole app in one PR.

---

## 1. What Kiseki should feel like

Kiseki is **one document for the whole life of a trip — planned with the people who are coming,
kept honest while it happens, and printed at the end.** That's the whole idea, and it's the
tiebreaker for every design argument.

The document is what makes it ours; the people are what make it something you do with others. The
product is no longer only for its owner — a trip has a crew and join links, and, when its owner
opts in, a discoverable presence on the front door — so every surface has to read for someone who is
not the owner, may not be signed in, and cannot see the owner's other trips.

| Feel | Not |
|---|---|
| Editorial — considered typography, generous whitespace, photography that breathes | Dashboard — dense widgets, chart chrome, "data app" |
| Crafted per trip — each journey has its own identity | Templated — every trip looks like the same SaaS product |
| Calm — the plan is legible at a glance, on a phone, in a car park, in the rain | Busy — badges, gradients and animation competing for attention |
| Cartographic — place is the organizing fact of a trip | Map-as-decoration — a small grey rectangle bolted onto a card |

**Three words**: *editorial · cartographic · calm.*

### On Polarsteps

Polarsteps is a fair reference for **one thing**: it proves that a full-bleed map is a better home
for a journey than a scrolling feed. Take that lesson. Do not take its visual language, its
timeline-dot idiom, its illustration style, or its layouts.

Where Kiseki deliberately diverges:

- Polarsteps is a **retrospective log** (you travelled, it recorded). Kiseki is a **forward-looking
  document** (you're planning, it's authoritative). Our map has to show *intent* — options,
  shortlists, unbooked legs — not just a traced line.
- Polarsteps is one visual identity for everyone. Kiseki's per-trip identity (§6) is the product.
- Polarsteps has no print artifact. Our booklet/album is the endgame (§12), which constrains
  everything upstream.

---

## 2. The three surfaces

The single most important structural decision. Kiseki has **three classes of surface**, they obey
different rules, and mixing them is how this design falls apart.

### 2.1 Document surfaces — *booklet-faithful*

Overview, practicals, crew, booklet — plus the *content* of Itinerary and Day, which is
authored in the same cards/blocks but is presented on the map surface (§7.6) and printed via
the booklet.

- Constrained reading column (`max-w-3xl` today; see §7 for the target ladder).
- Editorial typography, real paragraphs, markdown, generous vertical rhythm.
- **Must survive print.** Every document component renders in the PDF booklet or is explicitly
  `no-print`.
- Opaque surfaces (`bg-card` on `bg-background`), hairline borders, minimal elevation.
- Itinerary and Day are not document *pages*: their content is re-hosted on the map surface
  (§7.6). The booklet stays document-shaped and prints that same block content — including the
  block minimaps, which the web hides.

### 2.2 Map surfaces — *the map is the canvas*

Discovery, the whole-trip route at full screen, "things to do around here". A map surface is
**viewport-shaped**: the map is the canvas and content floats over it.

- The map fills the container. Content **floats over it**: sheets, rails, chips, pills.
- No reading column. Layout is driven by the map/content ratio ladder (§7.2).
- Everything floating needs the *floating elevation recipe* (§2.4) or it will be unreadable over
  satellite imagery.
- Print: map content renders through the **same MapLibre map live in the PDF** (§12, #37) —
  never a static raster.

**2026-09 direction — Itinerary and Day ARE the map surface.** The standalone route *page*
shipped by #39 (`/t/<id>/map`) proved redundant with the itinerary and is retired (#93). The
`Sheet`/`SplitView`/`RouteMap` primitives it built are repurposed into ONE persistent map
surface with two levels (§7.6): the **itinerary (scan)** level shows the whole trip with the
itinerary content in the rail/sheet, and the **day (read)** level shows that day's world when
you drill in — **the map stays alive between levels** (#92/#90). The scan level is the
whole-route view; there is no separate expandable. The remaining true viewport-shaped
surfaces (discovery, follow feeds) still use this section verbatim.

#### A map container must carry its own height (measured, 2026-09-16 — #249 review)

`maplibre-gl.css` ships **unlayered**, so `.maplibregl-map { position: relative }` — applied
by MapLibre to whatever element it is handed — **beats every Tailwind `@layer utilities`
rule**. A map box written as `absolute inset-0` is therefore really `position: relative`;
with no in-flow children (the canvas is absolutely positioned) it collapses to **height 0**,
MapLibre measures 0, keeps its default 300px canvas, and a `fitBounds` into a 0-height box is
a silent no-op (camera parked at zoom 0 / null island, every pin off-screen).

Rule: **a map container states its own box** (`h-full w-full`, or an explicit height class as
`MapView` does) and never relies on `absolute`. Then watch for changes no `resize` event
covers — a rail drag, a sheet detent, a phone's chrome collapsing, and MapLibre's own class
landing — with a `ResizeObserver` that calls `map.resize()` and re-frames while the camera is
still the app's to move.

Two further gotchas behind the same review, both measured on a 390×844 phone:

- **Zoom has a floor the transform enforces**: the world may never be shorter than the
  container is tall, so a full-height phone map cannot zoom below `log2(h/512)` (≈0.61 at
  783px). A pin set spanning three continents cannot be shown above a `half` sheet at *any*
  permitted zoom — that is physics, not a bug. Frame it, then let the *sheet detent* decide
  what is visible (the home opens at `peek` for this reason).
- **Measure a pin set by its SHORTEST arc.** A naive `[min(lng), max(lng)]` box is the long
  way round: Canada/Chile/Japan reads as 255° centred on Africa (unshowable) instead of 148°
  across the Pacific (showable). `unfoldLngs` in `lib/home-geo.ts` does that, and the camera
  is computed with `cameraForBounds` + an explicit `jumpTo`/`easeTo` — MapLibre 6 routes
  `fitBounds` through `flyTo`, whose arc was measured applying only the new centre (zoom and
  latitude left behind) whenever the fit zooms out.


**2026-09-16 — the signed-in home is built on this section (#249, slices 3/5).**
`/` signed in is a map surface on the `SplitView`/`Sheet` ladder: one pin per
listable trip (`GET /api/trips/geo`), stage-coloured, beside the five bands in
the rail/sheet furniture — plus the discoverable layer and the pin cards on the
same canvas. No new route, no second sheet, no second card language.

**The home's two doors (2026-09-16 review).** The sheet opens at `half` — the
bands are the context a visitor came for, and the map is one swipe down — while
the sheet's own header line is a *door*, not a label: the trip's title opens the
trip, and a `live` trip also carries a **Today** link, because the day it is on
right now is the surface you want (§7.5's live swap). And an account with no
trips yet is never a dead end: it renders on the SAME canvas, with the
discoverable pins as its map — the "No trips yet" card and its Plan-a-trip
button sit in the sheet above them, the header keeps the round chat toggle
(the in-trip control in the same slot), and Your trips keeps a permanent
Plan-a-trip action — so creation stays visible on populated homes too,
including follow-only ones where the empty card never renders (#347): a
Plan-a-trip open rotates the landing thread first (the popup's own New-chat
button does the same on an open thread), so a second trip idea never lands
in the previous planning conversation, while the header toggle reopens the
existing thread (#351). The
shelf below is the same `DiscoverBand` as the populated home, with
**Follow** on every card, which is the first and only UI for
`followPublicTrip` (#197's endpoint had no caller until now).
`visibility: public` is the invitation, so a stranger can put a trip in their
feed without an invite link.

**Followed trips are not your trips.** A trip with `role=follower` bands under
"Trips you follow", never under "Your trips" (crew: owner/editor/viewer) — the
card's role badge says so too. The band only renders while it has rows, or
while a filter is hiding them, so follower-free homes keep the four-band
order. The people-feed band is "Updates" (writes), named so it cannot be
confused with the trips band above it.

### 2.3 Chrome — *shared*

Header, nav, sheets, map controls, toasts, the auth button.

- Must be legible over **both** a white page and a photograph. Assume the worst background.
- Always `no-print`.
- Touch targets ≥ 44×44 CSS px, always.
- **Chrome stacks above content.** The header is `z-30` and the sheet is `z-20`, and that gap is load-bearing: both used to be `z-20`, so they shared a stacking context and the sheet — later in the DOM — won on document order, which covered an open account menu with the sheet's top edge on a phone (2026-09-16 review). Every header affordance (the account menu, a trip's actions menu) opens *downward*, straight into the sheet's territory, so the header must own the higher value. A surface that needs to float over the map's own chips (also `z-10`, inside the map) still works, because the sheet sits above the map subtree entirely.

### 2.4 The floating elevation recipe

A plain `shadow-lg` disappears over a satellite photo and looks dirty over paper. Anything that
floats over a map or an image uses all four layers:

```
translucent surface   bg-background/85
+ backdrop blur       backdrop-blur-md
+ hairline border     border border-border/60   (or ring-1 ring-black/5)
+ soft shadow         shadow-[0_2px_12px_rgb(0_0_0/0.12)]
```

`StageBadge` in [`ui.tsx`](frontend/src/components/ui.tsx) discovered the first two layers by hand;
the recipe is now the `<Floating>` primitive and the `.floating` utility. Use those.

---

## 3. Token layer

All colour, type and spacing goes through tokens in
[`frontend/src/index.css`](frontend/src/index.css) (`@theme inline`). **Never hardcode a hex in a
component.** `@theme inline` is deliberate: it inlines `var(--trip-*, fallback)` into the generated
utilities, which is what makes runtime per-trip theming work at all. Don't "fix" it to plain
`@theme`.

### 3.1 NOW

10 colour tokens (`background foreground primary primary-foreground accent accent-foreground muted
muted-foreground border card`), 3 font tokens. No spacing, radius, shadow, elevation or z-index
scale. No dark mode.

### 3.2 TARGET token set

Add, in roughly this order of value:

| Token group | Tokens | Why |
|---|---|---|
| **Semantic status** | `--color-destructive` + `-foreground`, `--color-success`, `--color-warning` | `text-destructive` is used in 3 places today and **generates nothing** — error text is currently invisible. Fix this first. |
| **Surfaces** | `--color-surface` (raised card over card), `--color-scrim` | Text-over-photo and sheets need a second surface level. |
| **Map** | `--color-route`, `--color-route-casing`, `--color-marker`, `--color-marker-fg`, `--color-map-water/land` | `MapView` hardcodes `#1e3a8a` — which is *Canada 2027's* primary leaked into shared code. Every other trip draws Canada-blue routes. |
| **Radius** | `--radius-sm/md/lg/xl` | Currently `rounded-md`/`rounded-xl` chosen ad hoc; a trip preset should be able to shift from sharp (editorial) to soft (album). |
| **Elevation** | `--shadow-floating`, `--shadow-card` | §2.4. |
| **Dark mode** | a full second palette | Trips are used at night, in cars, in tents. |

### 3.3 Dark mode (**TARGET**)

Tailwind v4 needs an explicit variant declaration — put it directly after `@import "tailwindcss";`:

```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

Rules:

- Respect `prefers-color-scheme` by default, allow an explicit override via `data-theme` on `<html>`.
- **The booklet is always light.** `dark:` must never appear inside `.booklet-*` or on any component
  that prints. Print is paper; paper is white.
- Per-trip colours must be validated against *both* palettes (§6.4), or dark mode will produce
  unreadable trip accents.

---

## 4. Typography

Three roles, three families — this is already right and worth keeping:

| Role | Token | Now | Used for |
|---|---|---|---|
| Display | `--font-display` | Bebas Neue | Cover titles, wordmark, big numerals. Uppercase, tight. |
| Heading | `--font-heading` | Oswald | h1–h4, section titles, kickers, nav. Condensed = the booklet voice. |
| Body | `--font-sans` | Inter | Paragraphs, markdown, UI labels, data. |

Rules:

- **Never more than three families on screen at once.** A per-trip preset may swap all three, but
  the *roles* are fixed.
- Body copy: 16px minimum on mobile, `leading-relaxed` for markdown, measure capped at ~68ch. The
  `max-w-3xl` column already does this — don't widen document text past it even when the viewport is
  huge (§7).
- The `.kicker` class (11px, uppercase, `0.14em` tracking) is the booklet's signature. Reuse it;
  don't invent alternates.
- **Numerals**: use `tabular-nums` for anything that lines up in a column — distances, durations,
  costs, times, day counters. Currently absent and it shows in the drive cards.
- Display type is uppercase-by-design. Set `letter-spacing` on it, never on body text.

### 4.1 Font loading (**TARGET**, matters for §6)

Today three families × 8 weights are `@import`ed eagerly for every trip. Once themes carry their own
fonts, that model doesn't scale.

- Prefer **variable** fontsource packages (`@fontsource-variable/*`) — one file per family.
- Load a trip's non-default fonts **lazily**, keyed by preset, with `font-display: swap` and the
  default stack as the fallback.
- **Booklet gotcha**: the Playwright PDF renderer must `await document.fonts.ready` before printing,
  or the booklet silently falls back to system type. If you add lazy fonts, add this at the same time
  or the PDF regresses.

---

## 5. Colour

### 5.1 Roles, not shades

- `primary` — the trip's signature. Nav active state, links, route lines, primary buttons.
  **Never body text.**
- `accent` — the secondary voice. Booked/confirmed states, map highlights, chart-ish accents.
- `muted` / `muted-foreground` — secondary surfaces and secondary text. Metadata lives here.
- `border` — hairlines only. Structure comes from spacing and typography, not from boxes.
- Status colours (`destructive`/`success`/`warning`) are **semantic**, never per-trip. A booking
  failure must look like a failure in every trip's palette.

### 5.2 Contrast floor

- Body text on its surface: **≥ 4.5:1**. Large/display text and UI borders: **≥ 3:1**.
- Text over photography always gets a scrim (§9), never just `drop-shadow`.
- Per-trip `primary`/`accent` are **untrusted input** — see §6.4.

### 5.3 Stage as colour

The stage machine (`idea → options → shortlist → planned → booked → live → archive`) is real state
and should read at a glance without reading the word:

| Stage | Treatment |
|---|---|
| `idea`, `options`, `shortlist` | Outline / dashed. Nothing is committed — the UI should look provisional. Dashed map routes, outline badges, no fills. |
| `planned` | Solid but muted. |
| `booked` | Filled `accent`. Confidence. |
| `live` | `primary` + the only place a pulse animation is allowed. |
| `archive` | Desaturated, reduced contrast, no accents. |

This vocabulary must be identical on cards, badges, map markers and route lines. It's the cheapest
way to make the map *mean* something.

---

## 6. Per-trip identity

The differentiator, and the thing that makes a sellable album. Take it seriously as a system, not as
"the user picks two hex codes".

### 6.1 NOW

`theme: { preset }` → CSS variables in
[`theme.tsx`](frontend/src/components/theme.tsx), resolved from the preset only.
The three real trips set only `preset` (canada-2027 `alpine`, chile-peru-2027
`ember`, japan-campervan-2028 `tundra`).

### 6.2 The core rule: **curated presets, not free-form**

Free-form colour and font pickers reliably produce ugly trips, and an ugly trip is an unsellable
album. Ship **8–12 named presets**, each a tested bundle:

```jsonc
"theme": {
  "preset": "alpine"   // the identity — palette + type pairing + map style + radius
}
```

The preset id is the ONLY theming surface: no per-trip colour, font, radius or
map overrides exist. Retired override fields were removed from the model and are
rejected by the API with a 422; a document that still carries them is read as its
preset only.

A preset defines: `primary`, `accent`, `surface` (paper tint — this is what actually makes two
albums feel different), the three font roles, `radius`, and `mapStyle` (§8.4).

Sketch of the range: `alpine` (cold blue, condensed sans, terrain map) · `desert` (ochre/clay, warm
serif headings) · `monsoon` (deep green/teal) · `nordic` (near-monochrome, high whitespace) ·
`archive` (sepia, book-like serif, minimal map). Names are per-*mood*, not per-destination — a trip
picks the mood that fits it.

Keep presets as **data** so the agent can pick one when it creates a trip ("Japan in winter → nordic").
`Theme` in `models.py` + `types.ts` is `{ preset }` only — extend the preset list, never the shape —
and regenerate DTDL.

### 6.3 Identity must reach the map

A trip whose UI is ochre and whose map is Google-default-blue has no identity. The preset's
`mapStyle` sets the basemap, route colour, and marker fill. This is a large part of why we're moving
to MapLibre (§8) — Google's basemap isn't ours to theme.

### 6.4 Guaranteeing preset contrast

There are no per-trip values to sanitise — the preset IS the theme. The guarantee
moved from runtime override validation to the preset set itself:

1. All 12 presets pin contrast in CI (`theme-presets.test.ts`): `primary` vs
   `background` ≥ 4.5, `foreground` vs `background` ≥ 4.5, `foreground-on-primary`
   ≥ 4.5 and `accent` vs `background` ≥ 3, in **both** light and dark palettes —
   a bad preset fails the build instead of shipping a bad trip.
2. `tripStyle()` still applies `ensureContrast()` to the preset's own colours as a
   defensive no-op, in one place, not per component.

---

## 7. Layout & responsive

### 7.1 Document surfaces

`max-w-3xl` reading column, `px-4` gutters, `pb-24` on mobile for the bottom nav. Correct. Keep.

At ≥1280px, **do not widen the text** — instead let a document surface place a persistent map or
metadata rail beside the column (§7.2, desktop row). Wide measure is the single fastest way to lose
the editorial feel.

### 7.2 Map surfaces — the ratio ladder

Think in *map/content ratio*, not breakpoints:

| Viewport | Map | Content | Notes |
|---|---|---|---|
| Phone portrait (<640) | full-bleed behind | **bottom sheet**, 3 detents | The core interaction. See §7.3. |
| Phone landscape / small tablet | 100% | side sheet, left, ~340px | Keyed on `max-height: 500px`, not `orientation` — what rules out a bottom sheet is missing vertical room, and a 700×600 viewport is "landscape" with plenty. |
| Tablet (768–1279) | ~60% right | ~40% left, scrolls | Split view. |
| Desktop (≥1280) | fills remaining | fixed left rail, 380–420px | Rail scrolls, map does not. |

Non-negotiables:

- **Exactly one scroll container** at a time. The map never scrolls the page.
- The map's viewport is the part *not covered by content*. Always pass `padding` to
  `fitBounds`/`easeTo` matching the sheet/rail occlusion, or half the route hides under the sheet.
  This is the #1 bug in map+sheet layouts.
- Respect `env(safe-area-inset-*)` on every fixed element. Bottom nav and sheets both sit in the
  home-indicator zone.
- Use `100dvh`, not `100vh` — mobile browser chrome will otherwise clip the sheet.

Built as `SplitView` (`frontend/src/components/SplitView.tsx`), which owns the ladder and hands the
map its camera padding. A map surface takes `100dvh` minus the app chrome, which is why `TripLayout`
exposes both `--kiseki-header-h` and `--kiseki-nav-h` and drops the reading column for that one
route.

### 7.3 The bottom sheet

Built as `Sheet` (`frontend/src/components/Sheet.tsx`), with the geometry in `lib/sheet.ts`. Use it;
don't hand-roll a second one.

- **Three detents**: peek (~15% — the "what am I looking at" line), half (~50% — list), full (~90%).
- Drag handle (a visible grab bar) — the affordance is not optional.
- Body scroll locks when the sheet is at `full`; drag-down from `scrollTop === 0` returns to `half`.
- Snapping is animated; dragging is not (1:1 with the finger).
- The map's `padding.bottom` updates with the detent.
- Escape / backdrop tap returns to `peek`, never fully dismisses — the sheet is the content, not a
  modal.
- Reduced motion (§10) → no snap animation, instant detent change.

Two things the build learned. **MapLibre has two padding mechanisms and they add up**: `fitBounds`
bakes `options.padding` into the centre/zoom and then discards it, while `easeTo({padding})` sets
the transform's persistent padding — use both and the route ends up shifted twice, clipped against
the top edge. Pick one (`RouteMap` passes `padding` to `fitBounds` and the equivalent `offset` to
`easeTo`). And **MapLibre's own corner chrome is under the content**: the attribution row sits
where the sheet is and the zoom chips sit where the side panel is, so both corner rows are
translated clear of it. Attribution is a legal requirement and the zoom buttons are the a11y
floor's answer to "not everyone can pinch"; neither may be covered.

### 7.4 Density

One spacing rhythm: `4 / 8 / 12 / 16 / 24 / 32 / 48`. Cards use 16 (mobile) / 20–24 (desktop)
padding. Don't introduce a compact mode; the app's value is legibility.

### 7.5 Navigation & information architecture

#### The governing rule: the primary unit changes with stage

A trip is not always read at the same granularity, and the navigation should follow the stage
machine rather than pretend the day is universal.

| Stage | Primary unit | Why |
|---|---|---|
| `idea`, `options`, `shortlist` | **Section / place** | Days often don't exist yet. "Four nights in Cusco, here are options." |
| `planned`, `booked` | **Mixed** | Flights and heli days are precise; "we're in the Sacred Valley" is not. |
| `live` | **Today** | Nothing else matters. |
| `archive` | **Section** | A chapter in the album. |

Stage already drives colour (§5.3). This is the other place it must drive the UI.

#### Evidence: the day is the wrong default

Audited against the three live trips (2026-09-01):

| Trip | Days | Days with ≤1 block |
|---|---|---|
| canada-2027 (booked) | 16 | **7** |
| chile-peru-2027 (planned) | 17 | **7** |
| japan-campervan-2028 (idea) | 10 | 2 |

Nearly half the day pages in a *booked* trip are near-empty — not a rendering fault, a granularity
mismatch. Those days have no per-day content because the trip is simply *in Revelstoke for three
days*. Meanwhile `TripSection` already models exactly that case (`locationRefs`, section-level
`blocks`) and the UI uses neither: sections render as decorative headers only.

#### The hierarchy

**Trip → Section → Day → Block**, with blocks attachable at *section* level, not only day level.

Section-level blocks are the unscheduled pool: restaurant candidates, "maybe a rest day",
things-to-do options for a multi-night stay. As commitment increases, **blocks move down the
hierarchy** — trip → section → day. That mirrors the stage machine and makes the future write-path
operation obvious ("schedule this" = promote a block from its section to a day).

Navigation mirrors the data model. That is what makes an IA feel inevitable rather than arbitrary.

#### Surfaces

```
/t/<id>               Overview    stage-aware home; jumps to the current day page while live
/t/<id>/today         →           redirect to the current day page (same surface as any
                                  other day — no separate Today page, so the layout
                                  never diverges from the regular day view)
/t/<id>/itinerary     Itinerary   the map surface, scan level — whole trip on the map, the
                                  itinerary in the rail/sheet (§7.6, #92)
/t/<id>/itinerary#s-<n>           a section — an ANCHOR into the scan list (see below)
/t/<id>/s/<n>         →           redirect to /itinerary#s-<n> (legacy links)
/t/<id>/day/<i>       Day         the map surface, read level — that day on the map, its
                                  blocks in the rail/sheet; the map stays alive from scan
                                  (§7.6, #90)
/t/<id>/map           →           retired (#93) — redirects to /itinerary; the scan level IS
                                  the whole-route view
/t/<id>/practical     Practical
/t/<id>/crew          Crew
/t/<id>/settings      Settings    trip-level settings — stage, theme, sharing, the invite
                                  links, integrations and delete (editor+; reached from the
                                                                     header's overflow menu, not the nav — #248)
```

`/` signed in is a map surface too (§2.2, #249): the discovery home's bands ride
the rail/sheet beside the trip pins. It needs no nav slot — it is the root.

Mobile bottom nav caps at **four**: *Overview · Today · Itinerary · Practical* (with *Today*
as a shortcut to the current day page while `live` — Overview always stays).
Crew folds into Overview — it's a low-frequency page. There is **no Map nav item** (2026-09, #93): the maps live inside the itinerary and day
pages (§7.6), so Itinerary keeps its calendar glyph and no icon is surrendered. A future nav
item must earn the slot under the same test: if it is a filtered view of its parent, it is a
filter or an anchor, not a page. **Settings stays off-nav for the same reason** (#248): it is
where the trip's own chrome sends you — the overflow menu keeps the per-visit action (the
booklet) and links here for everything that configures the trip.

#### List vs. detail — keep both, and let each do one job

The itinerary is the **scan** view; the day page is the **read** view. The current accordion is
neither: it costs a tap to reveal a truncated list you then leave anyway. Reading one day from the
trip root today takes four interactions (Overview → Itinerary → expand → Open day), against the
≤2-taps success criterion in `docs/spec.md` §13.1.

- **Itinerary = one continuous scrollable page** at *summary* density. Sections are sticky chapter
  headers; days render inline, always visible, never collapsed. This is where the
  continuous-narrative feel belongs.
- **Day pages stay.** Deep links are genuinely useful ("look at day 4" in a chat); 17 days of
  photos and maps on one page is punishing on mobile data — the "car park, in the rain" user is the
  design target; and prev/next swipe is the right travel interaction and cannot exist on one page.
- Summary density means: lazy images below the fold, no maps inline in the list, block glyphs
  rather than block cards.

#### Today

There is currently **no separate Today page, by design**. A follower opening a share
link on day 7 must know the date and hunt for it — so `/today` resolves to the
current **day page** (`/day/<idx>`, the same surface as any other day), and
degrades honestly when it can't: the trip root and `/today` fall back to the
overview when today has no day to open (*"starts in 5 days"*, *"ended 3 weeks
ago"*, or the nearest day are states of the trip, not a page of their own).
- While `stage === 'live'` and today falls inside the range, the trip root jumps
  to the current day page and a **Today** shortcut appears in the nav *alongside*
  Overview (never instead of it). Outside that window it isn't shown at all.
- The itinerary marks today and scrolls to it.
- **Resolve against the trip's timezone, not the viewer's.** Today in Hokkaido is not today in
  Belgium. Needs an optional IANA `timezone` on the trip, falling back to viewer-local. Don't
  build more than that.

#### Sections are a grouping, not a level

**Corrected 2026-09-01, after shipping it wrong.** The first draft of this section asked for both
*sticky section headers inside a continuous itinerary* **and** *a section page at `/s/<n>`*. Those
two overlap almost entirely, and building both produced exactly the mess you would expect: the
section page rendered the same `DaySummaryRow` list as the itinerary, section title + range
appeared in three places, and the extra level had no siblings — so there was nothing sensible to
hang prev/next on and no obvious parent for the day page to point at.

**There are two navigational levels, and only two:**

| Level | Surface | Job |
|---|---|---|
| 1 | **Itinerary** | Scan. Continuous scroll, sections as sticky anchored chapters. |
| 2 | **Day** | Read. Full detail, swipe prev/next. |

A **section is a chapter within level 1**, not a level of its own:

- Sticky section header carries the title, the derived day range, and the location chips (with
  marker numbers — that's the section → place → map-marker tie).
- Section-level `blocks` (the unscheduled pool) render inline under their header. For an
  `idea`-stage trip with no days at all, those blocks *are* the chapter.
- `/s/<n>` redirects to `/itinerary#s-<n>`. Keep the route as a redirect: links have been shared,
  and the map work (§2.2) wants a stable per-section target.
- **The day page's "up" button goes to `/itinerary#s-<n>` and is labelled with the section name**
  — one button that returns you to the scan view *in context*. Do not add a second button for
  "section" alongside "itinerary"; that is the complicated version.

The Overview may keep a compact chapter strip as a table of contents, linking to the same anchors.
A table of contents and the thing itself are not duplication — a third full rendering is.

**Still true, and worth keeping:**

- Set `locationRefs`. A section ties to a place, which makes it the natural unit for a map extent
  (§2.2). **A section is a place is a map view** — but that view is a *map surface*, not a document
  page. Don't reintroduce `/s/<n>` as a page to serve it.
- **Section titles name the place or theme, not the range** (`"Revelstoke"`, not
  `"Days 3–5 — Revelstoke"`). The range is derived and rendered.
- This improves print parity (§12): the booklet is already chapter-organised.

**The general lesson, applicable beyond sections:** a level of navigation has to earn itself with
content that exists nowhere else. If a candidate page is a filtered view of its parent, it is a
*filter* or an *anchor*, not a page.

### 7.6 The itinerary & day map surface (2026-09)

**Itinerary and Day are one map surface, not document pages** (decision 2026-09-05, #92/#90).
Both levels use the #39 layout: the map is the canvas and the *content* — the itinerary scan
list and the day's blocks, rendered exactly as they render today — lives in the rail/sheet and
interacts with the map. Navigating scan ↔ day (and day ↔ day) **keeps the map alive**: the
same MapLibre instance stays mounted; only the content and the map data/camera change. The
scan level shows the whole trip — there is no separate route page (#93) and no expandable
beyond it. The remaining document pages are Overview, Practical and Crew; the booklet
is a document route (`BookletPage`).

Contract:

- **The content is the source of truth for the rail/sheet.** Cards render exactly as they do
  today; only the media minimaps differ — **hidden in the web app** (the surface map is the
  context) and **kept in print** (the booklet is unchanged; per-day booklet maps are declined,
  #94). One shared component + a print-only rule.
- **Exactly one scroll container** (the rail/sheet); the map never scrolls; camera padding
  tracks the occlusion (§7.2/§7.3).
- **Level changes are state transitions with URL sync** (history pushState): `/itinerary` and
  `/day/<i>` deep-link to the right level; browser back/forward walks levels **without
  remounting the map**. Typed/external navigation may mount fresh.
- **Two marker roles** (§8.3): numbered place pins for stops/gateways/stays; letter chips for
  that day's activities on the day level. Excursions render as secondary markers (#91), never
  chain stops.
- **Print parity** is unchanged in spirit: the booklet prints the block content (minimaps and
  images included) through `DayBlocks`; map-surface chrome is `no-print`.

Surfaces on this contract: the **scan level** (#92 — the itinerary in the rail/sheet beside
the whole-trip map, interactive pills, scroll-spy) and the **day level** (#90 — the day's
blocks in the rail/sheet with that day's markers/legs, tap↔card, extensible to future overlays
like Strava). Honest derivations come from the content authoring rules and the route-surface
semantics (#91); real images for web cards come from #95.

---

## 8. Maps as a design surface

**MapLibre GL JS v6** (`MapView`, #18) renders the same map on screen and on
paper (#37). The Google Maps JS API is gone (#18) and the server-side Static
Maps proxy is gone (#37) — the booklet PDF renders the live MapLibre map via
Playwright+SwiftShader, so basemap / markers / route colours are identical.

### 8.1 What MapLibre buys us

- Full style control → §6.3 becomes possible.
- One renderer for screen and (via a headless render / raster fallback) print.
- No per-load billing pressure, so the map can be *prominent* instead of rationed.
- Vector = smooth zoom, rotation, pitch, terrain — the "journey" feel.

### 8.2 Migration constraints (v6, July 2026)

- **ESM only** — `import * as maplibregl from "maplibre-gl"`, no UMD bundle.
- **WebGL2 mandatory** — no WebGL1 fallback. Detect and degrade to a static image.
- Use the official MapLibre agent skills for the mechanics (§14) rather than re-deriving them.
- Wrapper: *settled in #18* — **no wrapper**. A thin hand-rolled effect in `MapView`, given there is
  exactly one map component. `react-maplibre` (visgl) is the option if a second map surface (#39)
  makes the imperative code hurt; until then a wrapper is a dependency for one consumer.
- MapLibre is loaded via a **dynamic import** — ~1 MB of renderer that most pages have no use for.
- **Tiles are a separate decision from the renderer.** *Settled in #18:* **OpenFreeMap `positron`** —
  keyless (nothing to proxy, nothing to leak) and already desaturated, which is §8.5's floor for
  free. It is community-funded with no SLA, so the swap is kept to one constant: `MAP_STYLE_URL`
  in `lib/maps.ts`, overridable via `VITE_MAP_STYLE_URL`. Self-hosted PMTiles on Garage remains the
  escape hatch — it was not chosen now because a travel app is global by definition, so it means
  either the whole-planet archive or per-region extracts maintained forever, plus self-hosted
  glyphs and sprites.
- **The traffic layer did not come along.** `TrafficLayer` is exclusive to the Google *JavaScript*
  API; keeping it would have kept the key in the browser and left #27 open. The live drive-time
  chip — the number anyone actually reads — survives, via the server-proxied Directions call.
  Coloured roads were decoration.

### 8.3 The marker system is the trip's index

`trip.locations` already numbers places ① ② ③, and those numbers appear on the map, in drive cards,
in the directions pills and in the booklet. **That numbering is the app's strongest existing design
idea.** Formalize it:

- One marker component, one visual spec, used on every map surface and in print.
- Ordinal inside the pin; `primary` fill; white foreground; hairline outline so it survives on both
  snow and forest.
- **Stage-aware** (§5.3): outline for `idea`/`options`, filled for `booked`.
- Visible size **28px at day zoom, ~22px at journey zoom** (2026-09, #357): the pin keeps its
  day-zoom size in the markup and shrinks through `--pin-scale` (`pinScaleAtZoom` in
  `lib/maps.ts` — 22/28 at zoom ≤ 5, 1 at zoom ≥ 9), composed with the selection/spy raises so
  they read identically at any size. Excursion diamonds ride the same variable (20px → ~16px).
  **Hit target stays 44px** (transparent padding) at every zoom.
- Selected: scale 1.15 + accent ring. Non-focused day: 45% opacity, never hidden.
- Cluster below the zoom where pins collide; the cluster shows a count, not a number range.
- **On-map labels** (2026-09, #357): numbered pills (`3 · Healesville`) below their pins, in the
  trip's own vocabulary — `bg-surface/90` + `text-foreground` + the §2.4 floating recipe,
  `font-heading` — so the label and the pin can never read as two places. Deterministic display
  rule (`selectMapLabels`, pinned by test): at most 8 labels, the selected pin always wins, and
  below zoom 2 the whole layer drops while the pins stay. Labels are `pointer-events-none`;
  the drive-time chip is DOM chrome above the canvas, so a label can never cover it.

**Two marker roles (2026-09, #90/#92).** The numbered pin stays the *place* marker — stays,
gateways and journey stops — on every surface, print included. The **day level** of the map
surface adds a second
role for *things that happen*: activities get a **letter chip** (A, B, C… in day order) with the
matching letter on its card — a visibly different glyph shape from the round numbered pins, so
the two roles can never be confused and no second numbering system appears on the map. Same hit
target (44px), selection and dimming rules apply to both roles. Excursions (#91) share the
activity role, styled as secondary markers.

### 8.4 Routes

- **Draw every line twice**: a casing (contrast colour) under a narrower body (`--color-route`).
  Without casing, a route disappears over roads of similar colour. This is the
  single highest-value cartographic trick available. Both widths interpolate with zoom from
  **one exported constant** (`ROUTE_WIDTH` in `lib/maps.ts`, 2026-09 #357 — read by `MapView`
  on screen and in the booklet, `RouteMap`, `LandingMap`, and the recorded-track layers, so no
  second opinion can drift): body 2 → 2.5 → 3 → 4 px across zoom 0 → 4 → 8 → 12, casing ~1.6×
  the body fading 0.9 → 0.55 opacity. Non-road legs (flights/ferries) draw 2 px at 0.35
  opacity, dash `[2, 3]`.
- Per-mode: drive/train = solid; ferry/flight = dashed, drawn as a **great-circle arc**
  (`resolveLegCoordinates` in `lib/route-surface.ts`, used by both surfaces — a `road: false`
  leg is never a straight screen-space line), never a car route for a plane. The old
  "train = solid + dot pattern" distinction is **not implemented** and the sentence is
  re-scoped to say so: mode reads from the glyph, not the dash (next point). Width no longer
  varies by stage — stage speaks through dash + opacity only (§5.3).
- **Transport glyphs** (2026-09, #357): each declared leg carries two small mode glyphs
  (plane/train/ferry/car — BlockGlyph's shapes and classifier) at ¼ and ¾ along the drawn
  line; short legs (< 15 km) draw none. Sprites are data-URI SVGs registered with
  `map.addImage` (the OpenFreeMap styles ship no sprite sheet). Mode comes only from data
  (`Block.mode` + `classifyTransportMode`, echoed back per leg by `GET /api/maps/route` under
  E1); `road: true` stays authoritative — a road route is never dressed as a flight glyph.
  The glyph layer renders through the same `MapView`, so the booklet prints it.
- Unbooked legs are dashed and lower-opacity regardless of mode (§5.3 again).
- Route colour comes from `--color-route`, which comes from the trip preset, read off the DOM by
  `lib/tokens.ts` (a canvas renderer takes strings, not classes). The `#1e3a8a` is dead — no hex
  literal belongs in map code, ever; that leak is how every trip drew Canada-blue routes.
- Markers are **DOM markers**, so their colours are plain Tailwind utilities off `--color-marker` /
  `--color-marker-fg` and no colour is written in JS at all.

### 8.5 Map legibility floor

- Labels on the basemap must not compete with our markers — prefer a low-contrast, desaturated
  basemap and let the trip's colour be the only saturated thing on screen. "Quiet basemap, loud
  trip."
- Attribution is a legal requirement and a design element — style it, don't hide it.
- Every map surface has a **list equivalent** reachable by keyboard (§11). A WebGL canvas is not
  accessible; the list is the accessible path, not a fallback.
- Loading: show a themed skeleton or a styled placeholder, never an empty grey box.

### 8.6 Elevation (#38)

Terrain is why a heliski week in the Selkirks looks like *that* trip. It is also **atmosphere, not
the subject** — it sits below the roads, the route and the markers, and it is the first thing to
give way when something has to.

- **DEM: Mapterhorn**, terrarium-encoded, free and keyless — the same "no vendor credential"
  property as the basemap, so elevation adds nothing new to protect. `lib/terrain.ts`.
- **`maxzoom: 12` is a floor we chose, not the server's limit.** Global coverage is Copernicus
  GLO-30 and it genuinely stops at z12 — verified: the Sahara, the Australian outback and the
  Peruvian Andes all 404 at z13, while British Columbia serves to z15 and Hokkaido to z13. Capping
  globally makes MapLibre upscale past z12 (soft relief) instead of punching holes in the
  hillshade over exactly the remote places a trip goes.
- **`hillshade-method: igor`, not `multidirectional`.** Multidirectional renders dramatic relief and
  buries the pale roads and place labels a quiet basemap draws on top of it. Igor is the method
  built to minimise its effect on what sits beneath. Compare them at z8 over a mountain range
  before touching this.
- **Contours are derived at runtime** from the same DEM (`maplibre-contour`) — no tileset to build
  or host. `minzoom: 10`: at trip scale contours are noise competing with the route for the ink
  §8.5 reserves for the trip. Intervals stay coarser than 30 m data would allow, because GLO-30
  quantises hard over snowfields and fine contours draw the terracing rather than the terrain.
- **3D terrain attaches the first time the camera tilts**, not on load. Shipping it fully off was
  worse than either extreme: rotate and pitch are enabled, so the map invited a tilt and stayed
  flat, with nothing to say the elevation was only shading. At `pitch: 0` a mesh is invisible by
  definition, so waiting for `pitchstart` costs the flat view — the one nearly everyone sees —
  nothing at all, and it satisfies "no 3D by default on mobile" precisely rather than by dropping
  the feature. Exaggeration 1.3: at trip scale a true 1.0 vertical barely reads, and past ~1.5 the
  Rockies become a cardboard cutout. The per-trip switch belongs to the theme preset (#40).
- **A tilted or rotated map needs a way back.** The compass appears only once the map is off north
  or pitched, and `visualizePitch` makes one press reset both. Standing chrome on a 192px-tall map
  has to earn its place; a way out of a state the user can reach does.
- Elevation never breaks the map: `addTerrain` swallows its own failures, so a DEM that will not
  load costs the trip its hillshade, not its route.

---

## 9. Photography

Photos carry most of the emotional weight; they're also the biggest layout risk.

- Always inside a fixed `aspect-[…]` box + `object-cover`. No intrinsic-size images — CLS on a
  photo-heavy page is brutal on mobile data.
- `loading="lazy"` on everything below the fold; the cover is eager.
- **Scrim, always**, for text over an image: `bg-gradient-to-t from-black/85 via-black/25 to-transparent`
  (already used on `TripCard` — make it a token/utility, it's needed on the cover, day heroes, and
  the stage badge).
- Cover images are ~16/10 on cards, full-bleed on hero and booklet page 1 (297×210mm).
- Credit lines (`coverCredit`) are small, muted, bottom-right — present, not shouted.
- Galleries: a 2-up strip on mobile, 3-up on desktop, consistent gap, no masonry (masonry breaks
  print).

### 9.1 Placing photos in a day — decision A+B (#190/#191, Niko 2026-09-11)

Two mechanisms, split by what the photo belongs to. **C is rejected.**

| | Mechanism | Applies to |
|---|---|---|
| **A** | **Photo strip on the block card** — `Block.images` holds N (was 1–2) | a photo that belongs to a specific block |
| **B** | **Photo card in the day** — a `gallery` block at the day's chronological position | a photo that belongs to no block |
| ~~C~~ | ~~one day-level gallery for everything~~ | **rejected** — it weakens the link between a photo and what it is *of*, which is the whole point of attaching photos to a trip |

**The rule that chooses between them:** a photo whose timestamp falls inside a
block's window (±90 min of a timed block, `PHOTO_BLOCK_WINDOW_MIN` in
`backend/app/photos.py`) renders on that block (A); everything else in the day
becomes a gallery block at its chronologically correct place in the day (B).
Photos that could not be dated at all come from the undated bucket in #190 and
belong to whichever day a human puts them on (B). Ordering everywhere is by
capture time (EXIF), never upload order.

So a day reads as: the activities, each with its own photos inline, and a photo
card for the rest — not one detached album at the end. Built on the existing
block model — no new block kinds (spec §5, no component zoo); the strip and the
gallery share one image component (`components/photos.tsx`: `TripPhoto`).

**Overflow + print (stated caps, §12):** a card with 12 photos is not 12 images
tall — the strip shows the first `STRIP_SCREEN_COUNT = 4` with a `+N` affordance
into a screen-only lightbox dialog (`no-print` chrome). Print takes
`STRIP_PRINT_COUNT = 4` (strip) / `GALLERY_PRINT_COUNT = 6` (gallery) followed
by a `+N more in the online album` line — never the whole roll, never the
browser's choice. Cards keep `break-inside: avoid` (`booklet-keep`).

---

## 10. Motion

The app currently has a 200ms day-swipe and a `live` pulse. That's roughly the right amount.

- **Durations**: 120ms (state/hover), 200ms (page/detent), 400–600ms (map camera). Nothing else.
- **Easing**: `ease-out` for entering, `ease-in` for leaving. Map camera uses MapLibre's own easing.
- Animate `transform` and `opacity` only. Never `height`, `top`, or layout properties.
- Map camera moves must be **interruptible** and must not fire on every render — only on explicit
  user intent or a route/day change.
- **`prefers-reduced-motion` is currently unhandled** and both keyframe animations run regardless.
  Add a global guard:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

  …and use `jumpTo` instead of `flyTo` when it's set.

---

## 11. Accessibility floor

Non-negotiable minimums. The current app misses most of these — treat it as a checklist for the
next few PRs.

- [ ] **Focus visible everywhere.** There is currently **not one `focus-visible:` rule in the
      codebase**. Every interactive element needs a visible ring that works on light, dark, and photo
      backgrounds (`focus-visible:ring-2 ring-primary ring-offset-2 ring-offset-background`).
- [ ] Semantic elements: `<button>` for actions, `<a>` for navigation. (Mostly right today.)
- [ ] Touch targets ≥44×44 — check map controls and marker hit areas especially.
- [ ] Contrast per §5.2, verified for every preset in both palettes.
- [ ] Text over images always scrimmed.
- [ ] Every map has a keyboard-reachable list equivalent.
- [ ] `aria-label` on icon-only buttons — there are exactly **two** in the app today; the PDF, join
      link, and nav icon buttons need them.
- [ ] `prefers-reduced-motion` honoured (§10).
- [ ] `aria-current="page"` on the active nav item.
- [ ] Live/async regions (trip loading, PDF preparing) announce via `aria-live="polite"`.

---

## 12. Print & booklet parity

The PDF is a product, not an export. It constrains the design system upstream.

**The parity contract** — every new component declares one of three behaviours:

| Class | Print behaviour |
|---|---|
| Document | Renders in the booklet. Must be A4-safe: no `100vh`, no `position: fixed`, no horizontal scroll, `break-inside: avoid` on cards. |
| Map | Renders live via the same MapLibre map as on screen (#37) — same basemap, marker numbering and route colours. The booklet is a faithful rendering of the app. |
| Chrome | `no-print`. |

**2026-09:** the itinerary/day web surface (§7.6) prints nothing by itself — the booklet is
its own route (`BookletPage`) and prints the same block content through `DayBlocks`,
**including the block minimaps** (print-only: the web hides them because the surface map is the
context). Per-day booklet maps were considered (#94) and declined — minimaps print well.
Map-surface chrome is `no-print`; wherever the booklet includes map content it prints live via
MapLibre.

Additional rules:

- Print is always the **light** palette (§3.3).
- A trip's identity must survive the page: preset fonts and colours are the same in the booklet as on
  screen. This is what makes the album worth paying for.
- `await document.fonts.ready` before Playwright prints (§4.1).
- Test the PDF on a trip with a non-default preset before shipping any theming change — it's the
  first thing that silently regresses.

### 12.1 Toward the sellable album (**TARGET**, later)

The booklet stylesheet is the seed. The album adds: full-bleed photo spreads, a map-of-the-whole-trip
frontispiece, per-section dividers using the preset's display face, and a colophon. Keep the print
CSS in a shape where a second `@page` size (square album, e.g. 210×210mm) is a variant, not a rewrite
— i.e. drive page geometry from CSS variables now, even though only A4 exists today.

---

## 13. Component inventory & known debt

### 13.1 What exists

`Button` · `Card` · `Badge` · `StageBadge` · `StatusChip` · `Separator`
([`ui.tsx`](frontend/src/components/ui.tsx)), the ten block renderers
([`blocks.tsx`](frontend/src/components/blocks.tsx)), `MapView` / `TripMap` (screen + PDF,
#37), and the map-surface primitives `RouteMap` / `Sheet` / `SplitView` (#39 — repurposed into
the itinerary/day map surface of §7.6).

### 13.2 Debt found in the v0.12.3 audit

Ordered by cost-to-fix vs. value:

1. **`Button` is defined and used zero times.** Every button in the app is a hand-rolled
   `className="rounded-md border border-border bg-card px-3 py-1.5 …"` string — 4 copies of the same
   outline button across `TripLayout` and `LandingPage`. Adopt `Button`, or delete it; the current
   state is the worst of both.
2. **`text-destructive` / `border-destructive` generate no CSS** (no `--color-destructive` token) —
   error messages in `LandingPage` and `JoinPage` currently render as plain body text. §3.2.
3. **`#1e3a8a` hardcoded as the route colour** in `MapView` — Canada's brand in shared code. §3.2/§8.4.
4. **No focus styles at all.** §11.
5. **No `prefers-reduced-motion` guard.** §10.
6. **No dark mode.** §3.3.
7. **No spacing/radius/elevation tokens** — magic numbers per component. §3.2.
8. Two `aria-label`s in the whole app. §11.
9. **`expandSectionDays([n,n])` renders the day twice.** The guard is `days[1] > days[0]`, so a
   single-day section falls through and returns `[n,n]` verbatim — duplicate React keys and the day
   rendered twice. Japan 2028's *"Day 10 — flex & fly home"* has exactly `days: [9,9]`, and
   `BookletPage` shares the helper, so it's in the PDF too. §7.5.
10. **`/t/<token>/crew` is orphaned** — the route and `CrewPage` exist; nothing links to them.
    `NAV` has only Overview/Itinerary/Practical. §7.5.
11. **No concept of "today"** anywhere in the frontend. §7.5.

### 13.3 Components to build (in dependency order)

1. `Button` adoption + `focus-visible` on all interactive elements *(unblocks everything)*
2. `Floating` / `.floating` recipe (§2.4) *(unblocks map surfaces)*
3. ~~`Sheet` with detents (§7.3)~~ *(shipped, #39)*
4. `Marker` + `RouteLayer` (§8.3, §8.4) *(the map's identity — routes shipped in `RouteMap`; the
   numbered pin is still built inline in two places and wants extracting)*
5. ~~`SplitView` (map/content ratio ladder, §7.2)~~ *(shipped, #39)*
6. `PhotoFrame` (aspect + scrim + lazy, §9)
7. `EmptyState` (the "no trips yet" pattern in `LandingPage` wants to be reusable)

---

## 14. Skills

Repo-local agent skills live in `.claude/skills/`:

- **`kiseki-design-system`** — tokens, components, responsive rules, a11y. Load before styling anything.
- **`kiseki-map-ux`** — map surfaces, MapLibre, markers, routes, sheets, print parity.
- **`kiseki-trip-identity`** — per-trip presets, palettes, type pairings, album coherence.

For MapLibre mechanics (tile sources, PMTiles, cartography, v5→v6 migration, fonts/glyphs) use the
**official MapLibre agent skills** rather than duplicating them here:

```bash
npx skills add maplibre/maplibre-agent-skills
```

(MIT-licensed, maintained by the MapLibre project; `maplibre-tile-sources`, `maplibre-cartography`,
`maplibre-pmtiles-patterns`, `maplibre-v6-migration`, `maplibre-terrain-rendering` are the relevant
ones for us.)

---

## 15. Sequencing

Don't do this as one redesign. Suggested order, each independently shippable:

1. **Token repair** — `destructive`, radius/elevation/spacing scale, focus rings, reduced-motion
   guard. Invisible to users, unblocks everything. *(§3, §10, §11)*
2. **`Button` adoption + `Floating` primitive.** Pure cleanup, immediately makes the app look
   intentional. *(§13.3)*
3. **The Today surface** — `/today`, live-aware home, timezone. Small, independent of everything
   else here, and the biggest single win for followers and for travelling. *(§7.5)*
4. **Itinerary: accordion → continuous scroll.** No data change. *(§7.5)*
5. **Sections first-class** — `locationRefs`, section-level blocks, anchored chapters, retitled
   sections. Do this *before* the map surfaces: a section is a place is a map extent. *(§7.5)*
6. **MapLibre migration at parity** — same surfaces, same numbered markers, new renderer, route/marker
   colours from tokens. No layout change yet. *(§8)*
7. ~~**The `Sheet` primitive + first map surface**~~ — done (#39): `Sheet`, `SplitView`, and the
   trip route surface. **Repurposed 2026-09** (#93): the standalone route *page* is retired —
   the primitives now build the single itinerary/day map surface of §7.6 — scan level #92, day
   level #90 — fed by the route-surface semantics (#91) and the Places-photo pipeline (#95).
   The booklet is unchanged: block minimaps stay in print (#94 declined). *(§7.3, §7.6)*
8. **Preset system** — `theme.preset`, 8–12 presets, validation, lazy fonts, map style per preset.
   *(§6)*
9. **Dark mode.** *(§3.3)*
10. **Discovery surfaces** (public trips, follows, "things to do") — only once 3–5 exist, because they
    are all map surfaces. *(§2.2)* **2026-09 update (#249, slice 2):** the signed-in home ships
    *bands-first* — Up next, Your trips, Following, Discover as editorial bands on `/`, with the
    fixed band order, one shared trip comparator and client-side search/stage filters. The bands
    are built to move as-is into the rail/sheet furniture when slice 3 puts this home on the
    §2.2 map canvas; until then §2.2 still describes the map surfaces, not this page.
    **2026-09-16 — CLOSED (#249, this branch):** slice 3 (the home on the canvas —
    `GET /api/trips/geo` pins, band↔pin linkage, bands as rail/sheet furniture), slice 4's
    remaining facets (month/season, place/region, mine⇄following, visibility) and slice 5
    (the discoverable layer + pin cards on the same canvas) are built. §2.2 now describes
    this page too.
11. **Album output** as a second print variant. *(§12.1)*
