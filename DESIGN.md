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

Kiseki is **a printed travel booklet that happens to be alive**. That's the whole idea, and it's the
tiebreaker for every design argument.

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

Overview, itinerary, day detail, practicals, crew, booklet.

- Constrained reading column (`max-w-3xl` today; see §7 for the target ladder).
- Editorial typography, real paragraphs, markdown, generous vertical rhythm.
- **Must survive print.** Every document component renders in the PDF booklet or is explicitly
  `no-print`.
- Opaque surfaces (`bg-card` on `bg-background`), hairline borders, minimal elevation.

### 2.2 Map surfaces — *the map is the canvas* (**TARGET**, new)

Discovery, the trip route view, day-on-map, "things to do around here".

- Map fills the viewport. Content **floats over it**: sheets, rails, chips, pills.
- No reading column. Layout is driven by the map/content ratio ladder (§7.2).
- Never printed directly — a map surface's print equivalent is a **static image** (§12).
- Everything floating needs the *floating elevation recipe* (§2.4) or it will be unreadable over
  satellite imagery.

### 2.3 Chrome — *shared*

Header, nav, sheets, map controls, toasts, the auth button.

- Must be legible over **both** a white page and a photograph. Assume the worst background.
- Always `no-print`.
- Touch targets ≥ 44×44 CSS px, always.

### 2.4 The floating elevation recipe

A plain `shadow-lg` disappears over a satellite photo and looks dirty over paper. Anything that
floats over a map or an image uses all four layers:

```
translucent surface   bg-background/85
+ backdrop blur       backdrop-blur-md
+ hairline border     border border-border/60   (or ring-1 ring-black/5)
+ soft shadow         shadow-[0_2px_12px_rgb(0_0_0/0.12)]
```

`StageBadge` in [`ui.tsx`](frontend/src/components/ui.tsx) already discovered the first two layers
by hand. **TARGET**: promote this to a `<Floating>` primitive / `.floating` utility so it isn't
rediscovered per component.

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

`theme: { primary, accent, font }` → three CSS variables in
[`theme.tsx`](frontend/src/components/theme.tsx). The three real trips only set `primary`/`accent`.

### 6.2 The core rule: **curated presets, not free-form**

Free-form colour and font pickers reliably produce ugly trips, and an ugly trip is an unsellable
album. Ship **8–12 named presets**, each a tested bundle:

```jsonc
"theme": {
  "preset": "alpine",        // the identity — palette + type pairing + map style + radius
  "primary": "#1e3a8a",      // optional per-trip override, validated (§6.4)
  "accent":  "#0f766e"
}
```

A preset defines: `primary`, `accent`, `surface` (paper tint — this is what actually makes two
albums feel different), the three font roles, `radius`, and `mapStyle` (§8.4).

Sketch of the range: `alpine` (cold blue, condensed sans, terrain map) · `desert` (ochre/clay, warm
serif headings) · `monsoon` (deep green/teal) · `nordic` (near-monochrome, high whitespace) ·
`archive` (sepia, book-like serif, minimal map). Names are per-*mood*, not per-destination — a trip
picks the mood that fits it.

Keep presets as **data** so the agent can pick one when it creates a trip ("Japan in winter → nordic")
and a human can override. Extend `Theme` in `models.py` + `types.ts` together, and regenerate DTDL.

### 6.3 Identity must reach the map

A trip whose UI is ochre and whose map is Google-default-blue has no identity. The preset's
`mapStyle` sets the basemap, route colour, and marker fill. This is a large part of why we're moving
to MapLibre (§8) — Google's basemap isn't ours to theme.

### 6.4 Validating trip colours

Any theme value that reaches the UI is untrusted. Before applying:

1. Parse strictly (`#rgb`/`#rrggbb` only). Reject anything else → fall back to the preset value.
2. Check contrast of `primary` against `background` and of `primary-foreground` against `primary`,
   in **both** light and dark palettes.
3. If a check fails, **auto-derive** a compliant variant (nudge lightness in OKLCH) rather than
   rejecting — the trip still gets its colour, just a usable one.

Do this in one place (`tripStyle()`), not per component.

---

## 7. Layout & responsive

### 7.1 Document surfaces

`max-w-3xl` reading column, `px-4` gutters, `pb-24` on mobile for the bottom nav. Correct. Keep.

At ≥1280px, **do not widen the text** — instead let a document surface place a persistent map or
metadata rail beside the column (§7.2, desktop row). Wide measure is the single fastest way to lose
the editorial feel.

### 7.2 Map surfaces — the ratio ladder (**TARGET**)

Think in *map/content ratio*, not breakpoints:

| Viewport | Map | Content | Notes |
|---|---|---|---|
| Phone portrait (<640) | full-bleed behind | **bottom sheet**, 3 detents | The core interaction. See §7.3. |
| Phone landscape / small tablet | 100% | side sheet, left, ~340px | Landscape phones have no vertical room for a sheet. |
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

### 7.3 The bottom sheet

Build it once, as a real primitive, before building any map surface on top of it.

- **Three detents**: peek (~15% — the "what am I looking at" line), half (~50% — list), full (~90%).
- Drag handle (a visible grab bar) — the affordance is not optional.
- Body scroll locks when the sheet is at `full`; drag-down from `scrollTop === 0` returns to `half`.
- Snapping is animated; dragging is not (1:1 with the finger).
- The map's `padding.bottom` updates with the detent.
- Escape / backdrop tap returns to `peek`, never fully dismisses — the sheet is the content, not a
  modal.
- Reduced motion (§10) → no snap animation, instant detent change.

### 7.4 Density

One spacing rhythm: `4 / 8 / 12 / 16 / 24 / 32 / 48`. Cards use 16 (mobile) / 20–24 (desktop)
padding. Don't introduce a compact mode; the app's value is legibility.

---

## 8. Maps as a design surface

Currently Google Maps JS (`MapView`) + a server-side Static Maps proxy for print. The move to
**MapLibre GL JS v6** is a design decision as much as a technical one: it's the only way the map gets
the trip's identity.

### 8.1 What MapLibre buys us

- Full style control → §6.3 becomes possible.
- One renderer for screen and (via a headless render / raster fallback) print.
- No per-load billing pressure, so the map can be *prominent* instead of rationed.
- Vector = smooth zoom, rotation, pitch, terrain — the "journey" feel.

### 8.2 Migration constraints (v6, July 2026)

- **ESM only** — `import * as maplibregl from "maplibre-gl"`, no UMD bundle.
- **WebGL2 mandatory** — no WebGL1 fallback. Detect and degrade to a static image.
- Use the official MapLibre agent skills for the mechanics (§14) rather than re-deriving them.
- Wrapper: `react-maplibre` (visgl, the MapLibre-specific successor to `react-map-gl`) if we want a
  reactive component model; a thin hand-rolled hook is also defensible given we have exactly one map
  component today. Decide once, in the migration PR.
- **Tiles are a separate decision from the renderer.** Options: a hosted provider (MapTiler, Stadia)
  or self-hosted **PMTiles** on the home cluster / Garage — a single static file, no tile server,
  which fits this stack unusually well. Choose before styling, not after.

### 8.3 The marker system is the trip's index

`trip.locations` already numbers places ① ② ③, and those numbers appear on the map, in drive cards,
in the directions pills and in the booklet. **That numbering is the app's strongest existing design
idea.** Formalize it:

- One marker component, one visual spec, used on every map surface and in print.
- Ordinal inside the pin; `primary` fill; white foreground; hairline outline so it survives on both
  snow and forest.
- **Stage-aware** (§5.3): outline for `idea`/`options`, filled for `booked`.
- Visual size ~28px, **hit target 44px** (transparent padding).
- Selected: scale 1.15 + accent ring. Non-focused day: 45% opacity, never hidden.
- Cluster below the zoom where pins collide; the cluster shows a count, not a number range.

### 8.4 Routes

- **Draw every line twice**: a wide casing (contrast colour, ~7px) under a narrower body (~4px,
  `--color-route`). Without casing, a route disappears over roads of similar colour. This is the
  single highest-value cartographic trick available.
- Per-mode: drive = solid; train = solid + dot pattern; ferry/flight = dashed, drawn as a
  **great-circle arc**, not a straight screen-space line.
- Unbooked legs are dashed and lower-opacity regardless of mode (§5.3 again).
- Route colour comes from `--color-route`, which comes from the trip preset. Kill the `#1e3a8a`.

### 8.5 Map legibility floor

- Labels on the basemap must not compete with our markers — prefer a low-contrast, desaturated
  basemap and let the trip's colour be the only saturated thing on screen. "Quiet basemap, loud
  trip."
- Attribution is a legal requirement and a design element — style it, don't hide it.
- Every map surface has a **list equivalent** reachable by keyboard (§11). A WebGL canvas is not
  accessible; the list is the accessible path, not a fallback.
- Loading: show the static-map image or a themed skeleton, never an empty grey box.

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
| Map | Replaced by a **static raster image** of the same view. Never ship an interactive map into print. |
| Chrome | `no-print`. |

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
([`blocks.tsx`](frontend/src/components/blocks.tsx)), `MapView` / `StaticMapImg` / `TripMap`.

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

### 13.3 Components to build (in dependency order)

1. `Button` adoption + `focus-visible` on all interactive elements *(unblocks everything)*
2. `Floating` / `.floating` recipe (§2.4) *(unblocks map surfaces)*
3. `Sheet` with detents (§7.3) *(unblocks mobile map surfaces)*
4. `Marker` + `RouteLayer` (§8.3, §8.4) *(the map's identity)*
5. `SplitView` (map/content ratio ladder, §7.2)
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
3. **MapLibre migration at parity** — same surfaces, same numbered markers, new renderer, route/marker
   colours from tokens. No layout change yet. *(§8)*
4. **The `Sheet` primitive + first map surface** — the trip route view. This is the visible leap.
   *(§7.3)*
5. **Preset system** — `theme.preset`, 8–12 presets, validation, lazy fonts, map style per preset.
   *(§6)*
6. **Dark mode.** *(§3.3)*
7. **Discovery surfaces** (public trips, follows, "things to do") — only once 3–5 exist, because they
   are all map surfaces. *(§2.2)*
8. **Album output** as a second print variant. *(§12.1)*
