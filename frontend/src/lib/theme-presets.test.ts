import { describe, expect, it } from "vitest";
import { contrastRatio, parseHexColor, readableFgOn } from "./color";
import { DEFAULT_PRESET_ID, PRESET_IDS, presetById, type ThemePreset } from "./theme-presets";

const REQUIRED_IDS = [
  "alpine",
  "nordic",
  "desert",
  "monsoon",
  "archive",
  "coastal",
  "highland",
  "ember",
  "tundra",
  "sakura",
  "savanna",
  "nocturne",
];

describe("preset set", () => {
  it("is exactly the twelve mood-named presets", () => {
    expect(PRESET_IDS).toEqual(REQUIRED_IDS);
  });

  it("defaults to alpine and never throws on unknown ids", () => {
    expect(presetById(undefined).id).toBe(DEFAULT_PRESET_ID);
    expect(presetById(null).id).toBe(DEFAULT_PRESET_ID);
    expect(presetById("atlantis").id).toBe(DEFAULT_PRESET_ID);
    expect(presetById("").id).toBe(DEFAULT_PRESET_ID);
  });

  it("has no two presets sharing a palette", () => {
    const seen = new Set<string>();
    for (const id of PRESET_IDS) {
      const p: ThemePreset = presetById(id);
      const sig = [p.light.primary, p.light.accent, p.light.background, p.dark.primary].join("|");
      expect(seen.has(sig), id).toBe(false);
      seen.add(sig);
    }
  });
});

describe("preset contrast — both palettes, so a bad preset fails CI", () => {
  for (const id of REQUIRED_IDS) {
    describe(id, () => {
      for (const mode of ["light", "dark"] as const) {
        it(`${mode}: primary vs background ≥ 4.5, foreground vs primary ≥ 4.5, accent vs background ≥ 3`, () => {
          const pal = presetById(id)[mode];
          const bg = parseHexColor(pal.background)!;
          const primary = parseHexColor(pal.primary)!;
          const accent = parseHexColor(pal.accent)!;
          expect(parseHexColor(pal.background), "background parses").not.toBeNull();
          expect(parseHexColor(pal.foreground), "foreground parses").not.toBeNull();
          expect(parseHexColor(pal.surface), "surface parses").not.toBeNull();
          expect(contrastRatio(primary, bg), "primary vs background").toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(parseHexColor(pal.foreground)!, bg), "foreground vs background").toBeGreaterThanOrEqual(
            4.5,
          );
          const fgOn = parseHexColor(readableFgOn(pal.primary))!;
          expect(contrastRatio(fgOn, primary), "foreground-on-primary").toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(accent, bg), "accent vs background").toBeGreaterThanOrEqual(3);
        });
      }
    });
  }
});

describe("preset shape", () => {
  it("every preset has three non-empty font roles, a radius and a mapStyle", () => {
    for (const id of PRESET_IDS) {
      const p = presetById(id);
      expect(p.fonts.display.trim(), `${id} display`).not.toBe("");
      expect(p.fonts.heading.trim(), `${id} heading`).not.toBe("");
      expect(p.fonts.body.trim(), `${id} body`).not.toBe("");
      expect(p.radius, `${id} radius`).toMatch(/^\d+(\.\d+)?rem$/);
      expect(["positron", "bright", "liberty", "dark"], `${id} basemap`).toContain(p.mapStyle.basemap);
      expect(p.mapStyle.terrain.exaggeration, `${id} exaggeration`).toBeGreaterThanOrEqual(0);
      expect(p.mapStyle.terrain.exaggeration, `${id} exaggeration`).toBeLessThanOrEqual(2);
      for (const hex of Object.values(p.mapStyle.tint ?? {})) {
        expect(parseHexColor(hex), `${id} tint ${hex}`).not.toBeNull();
      }
    }
  });

  it("spans densities — minimal and dense basemaps are both used", () => {
    const basemaps = new Set(PRESET_IDS.map((id) => presetById(id).mapStyle.basemap));
    expect(basemaps.has("positron")).toBe(true);
    expect(basemaps.has("liberty")).toBe(true);
  });

  it("spans voices — sharp and soft radii both exist", () => {
    const radii = PRESET_IDS.map((id) => parseFloat(presetById(id).radius));
    expect(Math.min(...radii)).toBeLessThanOrEqual(0.25);
    expect(Math.max(...radii)).toBeGreaterThanOrEqual(0.625);
  });
});
