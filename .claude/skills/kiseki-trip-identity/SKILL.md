---
name: kiseki-trip-identity
description: How each Kiseki trip gets its own look — the curated theme-preset system (palette, type pairing, map style, radius), safe per-trip color overrides with contrast validation, lazy per-trip font loading, and keeping that identity intact in the PDF booklet and printed album. Use when setting or changing a trip's theme in trip.json, extending the Theme model, adding presets or fonts, generating a look for a new trip, or working on the booklet/album output.
---

# Kiseki per-trip identity

Rationale: [`DESIGN.md`](../../../DESIGN.md) §6 and §12.

Per-trip identity is the product differentiator and the thing that makes a printed album
worth paying for. It is a **system**, not a color picker.

## Current state

`theme: { primary, accent, font }` in `trip.json` → three `--trip-*` CSS variables via
`tripStyle()` in `frontend/src/components/theme.tsx` → consumed by the `@theme inline`
tokens in `index.css`. The three live trips only set `primary` and `accent`:

| Trip | primary | accent |
|---|---|---|
| canada-2027 | `#1e3a8a` | `#0f766e` |
| chile-peru-2027 | `#7f1d1d` | `#b45309` |
| japan-campervan-2028 | `#334155` | `#b45309` |

Authoritative model: `backend/app/models.py` (Python) mirrored by
`frontend/src/lib/types.ts`. Changing `Theme` means changing **both**, then regenerating
DTDL (`uv run python scripts/gen_dtdl.py`) — see `AGENTS.md`.

## The core rule: curated presets, not free-form

Free-form color and font pickers reliably produce ugly trips, and an ugly trip is an
unsellable album. Ship **8–12 named presets**; a trip picks one and may override a value.

```jsonc
"theme": {
  "preset": "alpine",      // identity: palette + type pairing + map style + radius
  "primary": "#1e3a8a",    // optional override — validated, see below
  "accent":  "#0f766e"
}
```

A preset defines:

| Field | Why it matters |
|---|---|
| `primary`, `accent` | The trip's voice (DESIGN.md §5.1 for role rules) |
| `surface` | Paper tint. **This is what actually makes two albums feel different** — more than the accent does. |
| `display` / `heading` / `body` | The three font roles. Families change; roles never do. |
| `radius` | Sharp (editorial) ↔ soft (album) |
| `mapStyle` | Basemap identity + `--color-route` + marker fill |

Presets are named by **mood, not destination** — a trip picks the mood that fits it.
Sketch of the range: `alpine` (cold blue, condensed sans, terrain basemap) · `desert`
(ochre/clay, warm serif headings) · `monsoon` (deep green/teal) · `nordic` (near-monochrome,
high whitespace, minimal basemap) · `archive` (sepia, book serif).

Keep presets as **data**, not code branches — so the agent can pick one when it creates a
trip ("Japan in winter → nordic") and a human can override it later without a deploy.

## Identity must reach the map

A trip whose UI is ochre and whose map is Google-default-blue has no identity. The preset's
`mapStyle` drives the basemap, `--color-route`, and the marker fill. This is a large part of
why the app is moving to MapLibre — Google's basemap isn't ours to theme. See
**`kiseki-map-ux`**.

`MapView.tsx` currently hardcodes `#1e3a8a` as the route color (Canada's primary in shared
code), so today every trip already draws Canada-blue routes. Fixing that is step one of
making identity real.

## Validating per-trip colors — do this in `tripStyle()`, once

Any value from `trip.json` is untrusted input. Before it becomes a CSS variable:

1. **Parse strictly** — `#rgb` / `#rrggbb` only. Anything else → fall back to the preset value.
2. **Check contrast** of `primary` against `background`, and `primary-foreground` against
   `primary` — in **both** light and dark palettes (≥4.5:1 body, ≥3:1 large text and borders).
3. **On failure, auto-derive** rather than reject: nudge lightness in OKLCH until it passes.
   The trip keeps its color, just a usable one. Rejecting silently gives the author a broken
   trip with no feedback; deriving gives them a working one.

Do it in one place. Scattering validation across components guarantees a component that
skips it.

## Fonts

Today three families × 8 weights are `@import`ed eagerly in `index.css` for every trip. That
does not scale once each preset brings its own type.

- Prefer **variable** fontsource packages (`@fontsource-variable/*`) — one file per family.
- Load a preset's non-default fonts **lazily**, keyed by preset, with `font-display: swap`
  and the current stack as fallback.
- **Booklet gotcha:** the Playwright PDF renderer must `await document.fonts.ready` before
  printing, or the PDF silently falls back to system type. If you add lazy fonts, add this
  in the same PR — otherwise the booklet regresses and nobody notices until a customer sees it.

## Print & album coherence

The identity has to survive the page — that's the whole value proposition of the album.

- Preset fonts and colors are **identical** on screen and in the booklet.
- Print is always the **light** palette. `dark:` must never appear in a `.booklet-*` rule.
- **Test the PDF with a non-default preset before shipping any theming change.** It is the
  first thing that silently breaks.
- Toward the album (DESIGN.md §12.1): drive page geometry from CSS variables now, even
  though only A4 exists — so a square album page (e.g. 210×210mm) is a variant, not a
  rewrite.

## Adding a preset — checklist

- [ ] Palette passes contrast in **both** light and dark (§ validation above).
- [ ] Type pairing uses exactly the three roles; families are variable-font capable.
- [ ] `mapStyle` defined: basemap tone, `--color-route` (+ casing), marker fill/foreground.
- [ ] Semantic status colors (`destructive`/`success`/`warning`) are **unchanged** — those
      are never per-trip.
- [ ] Rendered as a booklet PDF and eyeballed at A4.
- [ ] Added to `models.py` + `types.ts` together; DTDL regenerated.
- [ ] Checked against a photo-heavy trip *and* a text-heavy one — presets that only work
      with great photography aren't presets.

## Related
- Tokens, type roles, contrast floor → **`kiseki-design-system`**
- Map style, route and marker theming → **`kiseki-map-ux`**
- Data model and DTDL regeneration → [`AGENTS.md`](../../../AGENTS.md)
