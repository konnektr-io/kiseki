---
name: kiseki-design-system
description: Kiseki's UI law — design tokens, component rules, responsive layout, motion, and the accessibility floor. Use when writing or reviewing ANY user-visible frontend code in this repo — adding or restyling a component, page, card, button, badge, sheet or nav; touching frontend/src/index.css, ui.tsx, blocks.tsx or any page; picking colors, spacing, radii, shadows or typography; or when the user says the UI looks "basic", "unpolished", "generic", or asks to modernize/redesign the styling.
---

# Kiseki design system

Full rationale lives in [`DESIGN.md`](../../../DESIGN.md). This skill is the operational
part: what to do, in what order, and what will bite you.

**The tiebreaker for every visual decision:** Kiseki is *one document for the whole life of a
trip — planned with the people coming, kept honest while it happens, printed at the end.*
Editorial, cartographic, calm. If a change makes the app feel more like a SaaS dashboard,
it's wrong.

## Before you write any UI code

1. **Identify the surface class.** Every component is exactly one of three (DESIGN.md §2):
   - **Document** — reading column, opaque, editorial, **must print** in the booklet.
   - **Map** — floats over a map canvas, translucent, never printed **as chrome**; map
     *content* prints live via the same MapLibre renderer (#37). Itinerary and Day are NOT
     document pages — they are one map surface (DESIGN.md §7.6) whose rail/sheet hosts the
     content; the surface is `no-print`. The booklet prints the same block content (with the
     block minimaps) through `DayBlocks`.
   - **Chrome** — header/nav/sheets/controls, must survive both paper-white and a satellite
     photo, always `no-print`.

   Getting this wrong is the most expensive mistake here — a `position: fixed` document
   component silently breaks the PDF.

2. **Check whether the component already exists.** `frontend/src/components/ui.tsx` has
   `Button`, `Card`, `Floating`, `Badge`, `StageBadge`, `StatusChip`, `Separator`.
   `blocks.tsx` has the ten block renderers. `Sheet.tsx` is the three-detent bottom sheet and
   `SplitView.tsx` the map/content ratio ladder (#39) — a map surface composes those two, it does
   not re-derive them. Reuse before creating.

3. **Never add a color, radius or shadow that isn't a token.**

## Hard rules

### Tokens
- All color goes through the `@theme inline` tokens in `frontend/src/index.css`.
  **Zero hex literals in components** — including map code, which reads the `--map-*` properties
  off the DOM via `lib/tokens.ts` because a canvas renderer takes strings, not classes. The old
  `#1e3a8a` leak (Canada 2027's primary in shared code) is dead; do not let one back in.
- `@theme inline` is intentional — it inlines `var(--trip-*, fallback)` so per-trip runtime
  theming works. Do not convert it to plain `@theme`.
- Per-trip theming is injected as `--trip-*` CSS variables by `tripStyle()` in
  `components/theme.tsx`. Anything that should change per trip must read a token, not a class.
- Tailwind v4 **drops a rule whose selector starts with an attribute** — it reads `[data-x] .y`
  as one of its own candidates and the rule never reaches the output, silently, with the source
  file still looking correct. Hook plain CSS on a class (`.map-surface .maplibregl-…`).

### Color roles
`primary` = the trip's signature (nav active, links, routes, primary CTA) — **never body
text**. `accent` = confirmed/booked states and map highlights. `muted-foreground` = all
secondary text. `border` = hairlines only. Status colors are **semantic and never
per-trip** — a failure must look like a failure in every palette.

### Typography
Three roles, fixed: `--font-display` (Bebas Neue — covers, wordmark, big numerals,
uppercase) · `--font-heading` (Oswald — h1–h4, section titles, nav) · `--font-sans`
(Inter — body, markdown, UI). A trip preset may swap the families; the roles never change.
Never more than three families on screen.

- Body ≥16px on mobile; markdown gets `leading-relaxed`; measure capped by `max-w-3xl`.
- Use the existing `.kicker` class for small uppercase labels — don't invent alternates.
- **`tabular-nums` on anything that aligns in a column**: distances, durations, costs,
  times, day counters. Currently missing across the drive/transport cards.
- Letter-spacing on display type only, never on body.

### Spacing & layout
- Rhythm: `4 / 8 / 12 / 16 / 24 / 32 / 48`. Nothing else.
- Card padding: 16 mobile / 20–24 desktop.
- Document surfaces stay at `max-w-3xl`. At ≥1280px **do not widen the text** — add a
  side rail instead (DESIGN.md §7.2).
- Mobile pages need `pb-24` for the bottom nav, and `env(safe-area-inset-bottom)` on
  anything fixed to the bottom.
- Use `100dvh`, never `100vh`.

### Navigation & information architecture
The hierarchy is **Trip → Section → Day → Block**, and blocks can attach at *section* level, not
only day level (`TripSection.blocks` — the unscheduled pool for a multi-night stay). The primary
unit changes with stage: section while planning, **today** while `live`, section again in the
archive. Mobile bottom nav caps at **four** items. Before adding a page or a nav entry, read
DESIGN.md §7.5 — the surface list there is the intended IA, not a suggestion. There is **no Map
nav item** (2026-09, #93): Itinerary and Day ARE the map surface (§7.6) — the Itinerary item
opens it. A nav entry for a map is itself a sign the design has drifted.

**Sections are a grouping, not a level** (§7.5, corrected 2026-09-01): there are exactly two
navigational levels — Itinerary (scan, sections as sticky anchored chapters `#s-<n>`) and Day
(read). `/s/<n>` is a redirect to `/itinerary#s-<n>`, never a page; the day page's "up" button
returns to its chapter anchor labelled with the section name. If a candidate page is a filtered
view of its parent, it is a *filter* or an *anchor*, not a page.

### Elevation
Anything floating over a map or photo needs all four layers, not just a shadow
(DESIGN.md §2.4) — that is the `Floating` component / `.floating` utility, already built:

```
bg-background/85  backdrop-blur-md  border border-border/60  shadow-[0_2px_12px_rgb(0_0_0/0.12)]
```

Use `<Floating>` (or the `.floating` class where the element already exists, as `StageBadge`
does). Never re-type the four layers.

### Motion
Durations: **120ms** state/hover · **200ms** page/detent · **400–600ms** map camera. Nothing
else. `ease-out` in, `ease-in` out. Animate `transform`/`opacity` only — never `height` or
`top`. The `live` stage pulse is the only looping animation permitted.

`prefers-reduced-motion` has the global CSS guard from DESIGN.md §10 in `index.css`. That only
reaches CSS: **JS-driven motion has to check the query itself** — `prefersReducedMotion()` in
`lib/maps.ts`, used by the map camera (`jumpTo`, not `easeTo`) and by the sheet's snap.

## Accessibility floor — verify before calling anything done

- [ ] A visible focus ring on every interactive element. There is a base rule in `index.css`
      (`a/button/summary/input/[tabindex]:focus-visible` → the `focus-ring` utility), so this is a
      floor, not a per-component chore. Where the target is a transparent 44px box around a small
      visible chip — markers, the MapLibre zoom controls, the map's frame button, the sheet's grab
      bar — ring the **chip**, or you get a stray rectangle (see `.map-chip-btn`, `.sheet-handle`).
- [ ] `<button>` for actions, `<a>`/`<Link>` for navigation.
- [ ] Touch targets ≥44×44 (visual size may be smaller; pad the hit area).
- [ ] `aria-label` on every icon-only button (the app has two, and needs ~six).
- [ ] `aria-current="page"` on the active nav item.
- [ ] Body text ≥4.5:1 contrast; large text and borders ≥3:1.
- [ ] Text over a photo gets a scrim, never just `drop-shadow`.
- [ ] Async state (loading, "Preparing…") announced via `aria-live="polite"`.

## Photography
Fixed `aspect-[…]` box + `object-cover`, always — no intrinsic-size images (CLS).
`loading="lazy"` below the fold, eager for the cover. Text over an image uses the scrim
gradient `from-black/85 via-black/25 to-transparent` (see `TripCard`). No masonry — it
breaks print.

## Print parity — check this on every Document component
- A4-safe: no `100vh`, no `position: fixed`, no horizontal scroll.
- `break-inside: avoid` on cards; `break-after: avoid` on headings.
- Print is **always the light palette** — `dark:` must never appear in a `.booklet-*` rule
  or on any component that prints.
- If you change theming or fonts, render the PDF for a non-default trip before shipping.
  It is the first thing that silently regresses.

## Existing debt — fix opportunistically, don't refactor everything at once
1. The numbered marker pin is built inline twice — as a DOM element in `MapView.tsx` and
   `RouteMap.tsx`, and as a React `Pin` in `RouteMapPage.tsx`. It is the app's strongest design
   idea and it wants to be one component (DESIGN.md §13.3 item 4).
2. Markers do not cluster, so two places closer than ~30px at the current zoom draw on top of
   each other (visible on chile-peru's Santiago / Valle Nevado). The list is still a complete path
   to both, so it degrades rather than breaks.
3. No dark mode (§3.3).
4. `--color-destructive`, focus styles, the reduced-motion guard, and the radius/elevation tokens
   are all **done** — don't re-fix them.

## Related
- Map surfaces, markers, routes, sheets, the ratio ladder → **`kiseki-map-ux`**
- Per-trip palettes, fonts, presets → **`kiseki-trip-identity`**
- Product/architecture context → [`AGENTS.md`](../../../AGENTS.md), [`docs/spec.md`](../../../docs/spec.md)
