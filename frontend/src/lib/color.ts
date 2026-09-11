/**
 * Small, pure colour maths for theme validation (#40 D4).
 *
 * No dependency: sRGB ↔ linear ↔ OKLab/OKLCH plus WCAG relative luminance and
 * contrast ratio, in one place so `tripStyle()` and the preset tests share
 * the exact same numbers. Anything from the trip document is untrusted input,
 * so parsing is strict (`#rgb` / `#rrggbb` only) and every function takes a
 * fallback path instead of throwing.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** Strict parse — anything else is untrusted input, not a colour. */
export function parseHexColor(value: unknown): Rgb | null {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) return null;
  const hex = m[1];
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function srgbChannelToLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, s)) * 255;
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance(rgb: Rgb): number {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. Argument order is irrelevant. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---- OKLab / OKLCH (Björn Ottosson, sRGB D65) -------------------------------

function srgbToOklab(rgb: Rgb): { l: number; a: number; b: number } {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    l: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

export function srgbToOklch(rgb: Rgb): Oklch {
  const { l, a, b } = srgbToOklab(rgb);
  const c = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l, c, h: c < 1e-6 ? 0 : h };
}

/** OKLCH → sRGB, pulling chroma in until the colour is in gamut (hue kept). */
export function oklchToSrgb({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  let chroma = Math.max(0, c);
  for (let i = 0; i < 24; i++) {
    const a = chroma * Math.cos(rad);
    const b = chroma * Math.sin(rad);
    // Round-trip check in linear space: out-of-gamut channels clip, which
    // moves the colour, so compare against the unclipped conversion.
    const cand = oklabToLinear(l, a, b);
    if (cand.inGamut) return linearToSrgbClipped(cand);
    chroma *= 0.85;
    if (chroma < 0.001) break;
  }
  // Achromatic fallback at this lightness is always in gamut.
  const grey = oklabToLinear(l, 0, 0);
  return linearToSrgbClipped(grey);
}

interface Linear {
  r: number;
  g: number;
  b: number;
  inGamut: boolean;
}

function oklabToLinear(l: number, a: number, b: number): Linear {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const r = +4.0767416621 * l_ ** 3 - 3.3077115913 * m_ ** 3 + 0.2309699292 * s_ ** 3;
  const g = -1.2684380046 * l_ ** 3 + 2.6097574011 * m_ ** 3 - 0.3413193965 * s_ ** 3;
  const bl = -0.0041960863 * l_ ** 3 - 0.7034186147 * m_ ** 3 + 1.7076147010 * s_ ** 3;
  const eps = 1e-4;
  return {
    r,
    g,
    b: bl,
    inGamut: r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && bl >= -eps && bl <= 1 + eps,
  };
}

function linearToSrgbClipped({ r, g, b }: Linear): Rgb {
  return {
    r: linearChannelToSrgb(Math.min(1, Math.max(0, r))),
    g: linearChannelToSrgb(Math.min(1, Math.max(0, g))),
    b: linearChannelToSrgb(Math.min(1, Math.max(0, b))),
  };
}

// ---- contrast repair ----------------------------------------------------------

/**
 * Nudge `fg` in OKLCH lightness until it reaches `minRatio` against `bg`.
 *
 * Hue and chroma are kept, so the trip keeps its colour, just a usable one.
 * Both directions are tried and the closer passing colour wins; when nothing
 * reaches the bar the strongest reachable side is returned. Pure function —
 * `tripStyle()` is the only caller in production.
 *
 * Guarantee: a returned colour that claims a pass really passes — every
 * candidate is checked as its 8-bit hex self (rounding a float channel can
 * shed ~0.01 of ratio), against `minRatio` plus a small margin, then refined
 * by bisection so the nudge stays minimal.
 */
export function ensureContrast(fgHex: string, bgHex: string, minRatio: number): string {
  const fg = parseHexColor(fgHex);
  const bg = parseHexColor(bgHex);
  if (!fg || !bg) return fgHex;
  if (contrastRatio(fg, bg) >= minRatio) return rgbToHex(fg);

  // Margin above the real floor: 8-bit rounding plus float error must never
  // leave the shipped hex under the ratio the caller asked for.
  const target = minRatio + 0.02;
  const base = srgbToOklch(fg);
  /** Ratio of the colour that would actually ship at this lightness. */
  const shippedRatio = (l: number): number => {
    const hex = rgbToHex(oklchToSrgb({ l, c: base.c, h: base.h }));
    return contrastRatio(parseHexColor(hex)!, bg);
  };
  const tryDirection = (up: boolean): { hex: string; dist: number } | null => {
    const step = up ? 0.005 : -0.005;
    let prev = base.l;
    for (let i = 1; i <= 200; i++) {
      const l = base.l + step * i;
      if (l < 0 || l > 1) break;
      if (shippedRatio(l) >= target) {
        // Bisect between the last failing and first passing lightness so the
        // nudge moves the colour as little as possible while still shipping
        // a hex that passes with margin.
        let lo = prev;
        let hi = l;
        for (let j = 0; j < 12; j++) {
          const mid = (lo + hi) / 2;
          if (shippedRatio(mid) >= target) hi = mid;
          else lo = mid;
        }
        return { hex: rgbToHex(oklchToSrgb({ l: hi, c: base.c, h: base.h })), dist: Math.abs(hi - base.l) };
      }
      prev = l;
    }
    return null;
  };
  const down = tryDirection(false);
  const up = tryDirection(true);
  if (down && up) return down.dist <= up.dist ? down.hex : up.hex;
  if (down ?? up) return (down ?? up)!.hex;
  // Unreachable bar (a mid-grey on a mid-grey): ship the strongest end of the
  // lightness ramp rather than the input, so the caller still moves forward.
  const ends = [0, 1].map((l) => ({
    hex: rgbToHex(oklchToSrgb({ l, c: base.c, h: base.h })),
    ratio: shippedRatio(l),
  }));
  ends.sort((a, b) => b.ratio - a.ratio);
  return ends[0].hex;
}

/** The readable text colour for `bgHex`: white or near-black, whichever passes. */
export function readableFgOn(bgHex: string, minRatio = 4.5): string {
  const bg = parseHexColor(bgHex);
  if (!bg) return "#ffffff";
  const white: Rgb = { r: 255, g: 255, b: 255 };
  const ink: Rgb = { r: 24, g: 24, b: 27 };
  return contrastRatio(white, bg) >= contrastRatio(ink, bg) &&
    contrastRatio(white, bg) >= minRatio
    ? "#ffffff"
    : contrastRatio(ink, bg) >= minRatio
      ? "#18181b"
      : ensureContrast(
          contrastRatio(white, bg) >= contrastRatio(ink, bg) ? "#ffffff" : "#18181b",
          bgHex,
          minRatio,
        );
}
