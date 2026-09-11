import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  ensureContrast,
  oklchToSrgb,
  parseHexColor,
  readableFgOn,
  relativeLuminance,
  rgbToHex,
  srgbToOklch,
} from "./color";

describe("parseHexColor", () => {
  it("parses #rrggbb and #rgb", () => {
    expect(parseHexColor("#1e3a8a")).toEqual({ r: 30, g: 58, b: 138 });
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#FFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("rejects everything else", () => {
    for (const bad of [
      "red",
      "rgb(1,2,3)",
      "#12345",
      "#1234567",
      "#gggggg",
      "1e3a8a",
      "",
      null,
      undefined,
      42,
      "var(--trip-primary)",
      "#1e3a8a ",
    ]) {
      if (bad === "#1e3a8a ") continue; // trailing space trims to a valid colour
      expect(parseHexColor(bad), String(bad)).toBeNull();
    }
    expect(parseHexColor("#1e3a8a ")).not.toBeNull();
  });
});

describe("relativeLuminance / contrastRatio", () => {
  it("matches the canonical WCAG examples", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(relativeLuminance(black)).toBeCloseTo(0, 5);
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 4);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 4);
    // #777 on white is the textbook ~4.48:1 failure just under AA body text.
    expect(contrastRatio({ r: 119, g: 119, b: 119 }, white)).toBeCloseTo(4.48, 1);
  });

  it("round-trips hex", () => {
    expect(rgbToHex(parseHexColor("#1e3a8a")!)).toBe("#1e3a8a");
  });
});

describe("OKLCH", () => {
  it("round-trips representative colours within a step", () => {
    for (const hex of ["#1e3a8a", "#0f766e", "#7f1d1d", "#b45309", "#334155", "#fafaf9", "#f472b6"]) {
      const back = rgbToHex(oklchToSrgb(srgbToOklch(parseHexColor(hex)!)));
      const a = parseHexColor(hex)!;
      const b = parseHexColor(back)!;
      const dist = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
      expect(dist, hex).toBeLessThan(6);
    }
  });

  it("keeps hue while pulling chroma into gamut", () => {
    const wild = oklchToSrgb({ l: 0.7, c: 0.4, h: 20 });
    expect([wild.r, wild.g, wild.b].every((v) => v >= 0 && v <= 255)).toBe(true);
  });
});

describe("ensureContrast", () => {
  it("leaves a passing colour alone (byte-identical)", () => {
    expect(ensureContrast("#1e3a8a", "#fafaf9", 4.5)).toBe("#1e3a8a");
  });

  it("nudges a failing colour until it passes, keeping the hue family", () => {
    const fixed = ensureContrast("#d6cfff", "#ffffff", 4.5);
    expect(contrastRatio(parseHexColor(fixed)!, { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(4.5);
    const before = srgbToOklch(parseHexColor("#d6cfff")!);
    const after = srgbToOklch(parseHexColor(fixed)!);
    // Same hue neighbourhood, lower lightness: the colour, just usable.
    expect(Math.abs(after.h - before.h)).toBeLessThan(12);
    expect(after.l).toBeLessThan(before.l);
  });

  it("repairs from either side — light text on a dark surface goes lighter", () => {
    const fixed = ensureContrast("#5a5a66", "#111827", 4.5);
    expect(
      contrastRatio(parseHexColor(fixed)!, parseHexColor("#111827")!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("passes untrusted input straight through", () => {
    expect(ensureContrast("red", "#ffffff", 4.5)).toBe("red");
  });

  it("ships a hex at or above the requested ratio for awkward inputs, both directions", () => {
    const cases: Array<[string, string, number]> = [
      // [fg, bg, ratio] — near-threshold greys, vivid out-of-gamut hues,
      // darken direction (light bg) and lighten direction (dark bg).
      ["#5a5a66", "#111827", 4.5],
      ["#767676", "#ffffff", 4.5],
      ["#777777", "#ffffff", 4.5],
      ["#888888", "#111111", 4.5],
      ["#d6cfff", "#ffffff", 4.5],
      ["#f472b6", "#fdf2f8", 4.5],
      ["#22d3ee", "#ecfeff", 4.5],
      ["#a3e635", "#1a2e05", 4.5],
      ["#fb923c", "#431407", 3],
      ["#94a3b8", "#0f172a", 3],
      ["#808080", "#808080", 4.5], // mid-grey on mid-grey: best effort, must not throw
      ["#c0c0c0", "#0a0a0a", 7],
      ["#404040", "#f5f5f5", 7],
    ];
    for (const [fg, bg, ratio] of cases) {
      const fixed = ensureContrast(fg, bg, ratio);
      expect(parseHexColor(fixed), `${fg} on ${bg}`).not.toBeNull();
      const got = contrastRatio(parseHexColor(fixed)!, parseHexColor(bg)!);
      const already = contrastRatio(parseHexColor(fg)!, parseHexColor(bg)!);
      if (already >= ratio) {
        expect(fixed, `${fg} on ${bg} already passes`).toBe(fg.toLowerCase());
      } else if (fg.toLowerCase() !== bg.toLowerCase()) {
        // Reachable bar: the shipped hex really passes, not just nominally.
        expect(got, `${fg} on ${bg} → ${fixed} = ${got}`).toBeGreaterThanOrEqual(ratio);
      }
    }
  });
});

describe("readableFgOn", () => {
  it("picks white on a dark primary, ink on a light one", () => {
    expect(readableFgOn("#1e3a8a")).toBe("#ffffff");
    expect(readableFgOn("#f5f0e6")).toBe("#18181b");
  });

  it("always meets the floor it promises", () => {
    for (const bg of ["#1e3a8a", "#b45309", "#f5f0e6", "#111827", "#0f766e", "#f472b6"]) {
      expect(contrastRatio(parseHexColor(readableFgOn(bg))!, parseHexColor(bg)!), bg).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});
