---
name: kiseki-design-system
description: Kiseki's UI law — design tokens, component rules, responsive layout, motion, and the accessibility floor. Use when writing or reviewing ANY user-visible frontend code in this repo — adding or restyling a component, page, card, button, badge, sheet or nav; touching frontend/src/index.css, ui.tsx, blocks.tsx or any page; picking colors, spacing, radii, shadows or typography; or when the user says the UI looks "basic", "unpolished", "generic", or asks to modernize/redesign the styling.
---

# Kiseki design system

Full rationale lives in [`DESIGN.md`](../../../DESIGN.md). This skill is the operational
part: what to do, in what order, and what will bite you.

**The tiebreaker for every visual decision:** Kiseki is *a printed travel booklet that
happens to be alive.* Editorial, cartographic, calm. If a change makes the app feel more
like a SaaS dashboard, it's wrong.

## Before you write any UI code

1. **Identify the surface class.** Every component is exactly one of three (DESIGN.md §2):
   - **Document** — reading column, opaque, editorial, **must print** in the booklet.
   - **Map** — floats over a map canvas, translucent, never printed (a static image
     replaces it).
   - **Chrome** — header/nav/sheets/controls, must survive both paper-white and a satellite
     photo, always `no-print`.

   Getting this wrong is the most expensive mistake here — a `position: fixed` document
   component silently breaks the PDF.

2. **Check whether the component already exists.** `frontend/src/components/ui.tsx` has
   `Button`, `Card`, `Badge`, `StageBadge`, `StatusChip`, `Separator`.
   `blocks.tsx` has the ten block renderers. Reuse before creating.

3. **Never add a color, radius or shadow that isn't a token.**

## Hard rules

### Tokens
- All color goes through the `@theme inline` tokens in `frontend/src/index.css`.
  **Zero hex literals in components.** (`MapView.tsx` violates this with `#1e3a8a` — that's
  Canada 2027's primary hardcoded into shared code; fix it if you touch that file.)
- `@theme inline` is intentional — it inlines `var(--trip-*, fallback)` so per-trip runtime
  theming works. Do not convert it to plain `@theme`.
- Per-trip theming is injected as `--trip-*` CSS variables by `tripStyle()` in
  `components/theme.tsx`. Anything that should change per trip must read a token, not a class.
- **`--color-destructive` does not exist yet** but `text-destructive` is used in
  `LandingPage.tsx` and `JoinPage.tsx` — those error messages currently render as plain
  body text. Add the token when you're next in `index.css`.

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
DESIGN.md §7.5 — the surface list there is the intended IA, not a suggestion.

### Elevation
Anything floating over a map or photo needs all four layers, not just a shadow
(DESIGN.md §2.4):

```
bg-background/85  backdrop-blur-md  border border-border/60  shadow-[0_2px_12px_rgb(0_0_0/0.12)]
```

`StageBadge` already does the first two by hand. Prefer promoting this to a shared
`Floating` primitive over copying it a fifth time.

### Motion
Durations: **120ms** state/hover · **200ms** page/detent · **400–600ms** map camera. Nothing
else. `ease-out` in, `ease-in` out. Animate `transform`/`opacity` only — never `height` or
`top`. The `live` stage pulse is the only looping animation permitted.

`prefers-reduced-motion` is **not handled anywhere in this repo today.** If you add or
touch an animation, add the global guard from DESIGN.md §10 in the same PR.

## Accessibility floor — verify before calling anything done

- [ ] `focus-visible:ring-2 ring-primary ring-offset-2 ring-offset-background` on every
      interactive element. **The codebase currently has zero focus styles** — every PR that
      touches an interactive element should leave this better.
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
1. `Button` is defined in `ui.tsx` and used **zero times**; there are 4 hand-rolled copies
   of the same outline button in `TripLayout.tsx` and `LandingPage.tsx`. Adopt it when you
   touch those files.
2. Missing `--color-destructive` (see above).
3. Hardcoded `#1e3a8a` route color in `MapView.tsx`.
4. No focus styles, no reduced-motion guard, no dark mode, no spacing/radius/elevation tokens.

## Related
- Map surfaces, markers, routes, sheets → **`kiseki-map-ux`**
- Per-trip palettes, fonts, presets → **`kiseki-trip-identity`**
- Product/architecture context → [`AGENTS.md`](../../../AGENTS.md), [`docs/spec.md`](../../../docs/spec.md)
