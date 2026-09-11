import { describe, expect, it } from "vitest";
import { ensurePresetFonts, presetFontLoads } from "./fonts";
import { PRESET_IDS, presetById } from "./theme-presets";

describe("presetFontLoads", () => {
  it("loads nothing for the default trio", () => {
    expect(presetFontLoads("alpine")).toEqual([]);
    expect(presetFontLoads("nordic")).toEqual([]);
    expect(presetFontLoads(undefined)).toEqual([]);
  });

  it("loads exactly the non-default families each preset names", () => {
    expect(presetFontLoads("desert")).toEqual(["Fraunces"]);
    expect(presetFontLoads("nocturne")).toEqual(["Space Grotesk"]);
    expect(presetFontLoads("monsoon")).toEqual(["Space Grotesk"]);
    expect(presetFontLoads("sakura")).toEqual(["Fraunces"]);
  });

  it("covers every non-default family named in any stack", () => {
    const defaults = ["Bebas Neue", "Oswald", "Inter", "Georgia", "Times New Roman", "serif", "sans-serif"];
    const named = new Set<string>();
    for (const id of PRESET_IDS) {
      const p = presetById(id);
      for (const stack of [p.fonts.display, p.fonts.heading, p.fonts.body]) {
        const first = stack.split(",")[0].trim().replace(/^'|'$/g, "");
        if (!defaults.includes(first)) named.add(first);
      }
    }
    expect([...named].sort()).toEqual(["Fraunces", "Space Grotesk"]);
    for (const name of named) {
      expect(presetFontLoads(PRESET_IDS.find((id) => JSON.stringify(presetById(id).fonts).includes(name))!).includes(name)).toBe(
        true,
      );
    }
  });
});

describe("ensurePresetFonts", () => {
  it("is idempotent and never throws", async () => {
    await expect(ensurePresetFonts("desert")).resolves.toBeDefined();
    await expect(ensurePresetFonts("desert")).resolves.toBeDefined();
    await expect(ensurePresetFonts(undefined)).resolves.toBeDefined();
  });
});
