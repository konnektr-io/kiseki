---
name: kiseki-trip-identity
description: How each Kiseki trip gets its own look — the curated theme-preset system (palette, type pairing, map style, radius), lazy per-preset font loading, and keeping that identity intact in the PDF booklet and printed album. Use when setting or changing a trip's theme, extending the Theme model, adding presets, generating a look for a new trip, or working on the booklet/album output.
---

# Kiseki per-trip identity

Rationale: [`DESIGN.md`](../../../DESIGN.md) §6 and §12.

Per-trip identity is the product differentiator and the thing that makes a printed album
worth paying for. It is a **system**, not a color picker.

## Current state — the preset id is the whole contract (#40)

`theme` carries exactly one field:

```jsonc
"theme": { "preset": "alpine" }
```

| Trip | preset |
|---|---|
| canada-2027 | `alpine` |
| chile-peru-2027 | `ember` |
| japan-campervan-2028 | `nordic` |
| urban-legends-neon-dreams | `nocturne` |

**There are no per-trip color, font, radius or map overrides, and no way to add one.**
#40 first shipped an override surface and then removed it, deliberately: two ways to theme
a trip confuse the agent, and an agent-authored hex is the free-form picker this whole
system exists to avoid. `Theme` in `backend/app/models.py` is `extra="forbid"` (mirrored by
`frontend/src/lib/types.ts`), so sending a retired field — `primary`, `accent`, `surface`,
`font`, `displayFont`, `headingFont`, `bodyFont`, `radius`, `mapStyle` — is a **422** on
`PUT /api/trips/{id}`, never silently ignored. You pick a preset; you do not pick a color.

Presets are the only theming surface, and they live as **data** in
`frontend/src/lib/theme-presets.ts` (12 of them), not as code branches.

Authoritative model: `backend/app/models.py` (Python) mirrored by
`frontend/src/lib/types.ts`. Changing `Theme` means changing **both**, then regenerating
DTDL (`uv run python scripts/gen_dtdl.py`) — see `AGENTS.md`.

### Migrating a trip to a preset

`PUT /api/trips/{id}` with `{"theme": {"preset": "…"}}` is a **full replace** of the theme
block (`_theme_ops` in `backend/app/write.py`): it sets `preset` and emits a `remove` for
every *other* key currently on the twin. That is not incidental — DTDL validation rejects
the retired fields, so a half-migrated twin (new preset + leftover `primary`) is invalid.
One PUT replaces the block, so there is never an intermediate state to validate.

On the **read** path `graph_to_trip()` drops unknown theme keys before validation, so a
not-yet-migrated twin still renders (at the default preset) instead of 500ing. Keep that
asymmetry: strict writes, tolerant reads — the graph is the source of truth and lags the
code.

## The core rule: curated presets, not free-form

Free-form color and font pickers reliably produce ugly trips, and an ugly trip is an
unsellable album. The catalogue is **12 named presets**; a trip picks one, full stop.

A preset defines the whole identity:

| Field | Why it matters |
|---|---|
| `primary`, `accent` | The trip's voice (DESIGN.md §5.1 for role rules) |
| `surface` | Paper tint. This is what actually makes two albums feel different — more than the accent does. |
| `display` / `heading` / `body` | The three font roles. Families change; roles never do. |
| `radius` | Sharp (editorial) ↔ soft (album) |
| `mapStyle` | Basemap identity + `--color-route` + marker fill + terrain |

Presets are named by **mood, not destination** — a trip picks the mood that fits it:
`alpine` (cold blue, condensed sans, full relief) · `nordic` (near-monochrome, high
whitespace, quiet map) · `desert` (ochre/clay, warm serif) · `monsoon` (deep green/teal) ·
`archive` (sepia, book serif) · `coastal` · `highland` · `ember` (warm red over dark
earth) · `tundra` · `sakura` · `savanna` · `nocturne` (violet night, vivid signal colours).

## Identity must reach the map

A trip whose UI is ochre and whose map is default-blue has no identity. The preset's
`mapStyle` drives the basemap (a prebuilt OpenFreeMap style per preset), a runtime tint of
the base layers, `--color-route`, the marker fill, and the terrain/relief treatment — see
`frontend/src/lib/maps.ts` and `terrain.ts`, and **`kiseki-map-ux`**.

The route and marker colors follow the preset palette; the older hardcoded
`#1e3a8a` route color is gone. Stage markers are **derived** from which blocks reference a
place (`locationStage` / `markerPinClass`), not stored on the `Location` — no model field.

## Contrast is enforced by test, not at render time

Because a preset is the only source of color, contrast is a property of the catalogue
rather than something the render path sanitises. Every preset's light **and** dark palette
is pinned by a unit test asserting the WCAG floors (≥4.5:1 body, ≥3:1 large text and
borders). Add a preset and the test covers it — that test is the gate, so never weaken it.

## Fonts

Each preset brings its own type pairing, so fonts load **lazily, keyed by preset**
(`frontend/src/lib/fonts.ts` → `ensurePresetFonts`), with `font-display: swap` and the
system stack as fallback.

- Prefer **variable** fontsource packages (`@fontsource-variable/*`) — one file per family.
- **Booklet gotcha:** the Playwright PDF renderer must `await document.fonts.ready` before
  printing, or the PDF silently falls back to system type. Lazy fonts and that await ship
  together — otherwise the booklet regresses and nobody notices until a customer sees it.

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

- [ ] Palette passes contrast in **both** light and dark — the pinned test is the gate.
- [ ] Type pairing uses exactly the three roles; families are variable-font capable and
      wired into the lazy per-preset loader.
- [ ] `mapStyle` defined: basemap tone, `--color-route` (+ casing), marker fill/foreground,
      terrain treatment.
- [ ] Semantic status colors (`destructive`/`success`/`warning`) are **unchanged** — those
      are never per-trip.
- [ ] Rendered as a booklet PDF and eyeballed at A4.
- [ ] Added to `theme-presets.ts` **and** to the `preset` description in `models.py` if the
      catalogue size changes; DTDL regenerated.
- [ ] Checked against a photo-heavy trip *and* a text-heavy one — presets that only work
      with great photography aren't presets.

## Related
- Tokens, type roles, contrast floor → **`kiseki-design-system`**
- Map style, route and marker theming → **`kiseki-map-ux`**
- Data model and DTDL regeneration → [`AGENTS.md`](../../../AGENTS.md)
