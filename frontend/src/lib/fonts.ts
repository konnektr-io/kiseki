/**
 * Lazy, preset-keyed font loading (#40 D5).
 *
 * The default trio (Bebas Neue / Oswald / Inter) ships eagerly in index.css:
 * it is the fallback stack everything renders in first paint, and six of the
 * twelve presets use it as-is. Every other family loads lazily — a trip on
 * the default trio downloads nothing extra.
 *
 * Variable fontsource packages (one file per family) with `font-display:
 * swap` from the package CSS. Loading never throws: a failed font must fall
 * back to the stack, never break the trip.
 */

import { presetById } from "./theme-presets";

type FontLoader = () => Promise<unknown>;

// The non-default families any preset names. Keys must match the family names
// used in theme-presets.ts stacks exactly — presetFontLoads() matches them
// by substring, and the test below pins that every non-default family named
// in a stack has a loader here.
const LAZY_FAMILIES: Array<{ name: string; load: FontLoader }> = [
  { name: "Fraunces", load: () => import("@fontsource-variable/fraunces") },
  { name: "Space Grotesk", load: () => import("@fontsource-variable/space-grotesk") },
];

/** Non-default families a preset's three stacks name — pure, for tests. */
export function presetFontLoads(presetId: string | null | undefined): string[] {
  const preset = presetById(presetId ?? undefined);
  const stacks = [preset.fonts.display, preset.fonts.heading, preset.fonts.body].join(" ");
  return LAZY_FAMILIES.filter(({ name }) => stacks.includes(name)).map(({ name }) => name);
}

const loaded = new Set<string>();

/** Idempotent: request a preset's families once per session, never throw. */
export function ensurePresetFonts(presetId: string | null | undefined): Promise<void[]> {
  const loads = LAZY_FAMILIES.filter(
    ({ name }) => !loaded.has(name) && presetFontLoads(presetId).includes(name),
  );
  return Promise.all(
    loads.map(({ name, load }) =>
      load().then(
        () => {
          loaded.add(name);
        },
        () => {
          // A font that will not load costs the trip its voice, not its
          // content — the fallback stack in every preset stack string covers it.
        },
      ),
    ),
  );
}
