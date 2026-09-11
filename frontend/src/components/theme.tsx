import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import type { Trip } from "../lib/types";
import { ensureContrast, parseHexColor, readableFgOn, rgbToHex } from "../lib/color";
import { presetById, type ThemePreset } from "../lib/theme-presets";

interface TripState {
  trip: Trip;
  /** Replace the in-session trip document — the write path applies the
   *  canonical doc returned by the API here (and the optimistic snapshot
   *  while a write is in flight). */
  apply: (trip: Trip) => void;
}

const TripContext = createContext<TripState | null>(null);

export function TripProvider({
  trip,
  apply,
  children,
}: {
  trip: Trip;
  apply: (trip: Trip) => void;
  children: ReactNode;
}) {
  return <TripContext.Provider value={{ trip, apply }}>{children}</TripContext.Provider>;
}

export function useTripState(): TripState {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error("useTripState must be used inside TripProvider");
  return ctx;
}

export function useTrip(): Trip {
  return useTripState().trip;
}

/** The preset a trip resolves to — unknown/absent ids never break a trip. */
export function tripPreset(trip: Trip): ThemePreset {
  return presetById(trip.theme?.preset);
}

/**
 * A per-trip colour override: strict `#rgb`/`#rrggbb` parse, else the preset
 * value. Anything else is untrusted input from the trip document, not a colour.
 */
function overrideColor(value: string | undefined, presetValue: string): string {
  if (value == null) return presetValue;
  const parsed = parseHexColor(value);
  return parsed ? rgbToHex(parsed) : presetValue;
}

/** Font stacks are untrusted strings — allowlist the characters, cap the length. */
function overrideFont(value: string | undefined, presetValue: string): string {
  if (value == null || value.trim() === "") return presetValue;
  const clean = value.trim().slice(0, 120);
  return /^[A-Za-z0-9 '"\-,]+$/.test(clean) ? clean : presetValue;
}

/** A CSS length for the radius knob, else the preset voice. */
function overrideRadius(value: string | undefined, presetValue: string): string {
  if (value == null) return presetValue;
  return /^\d+(\.\d+)?(rem|px|em)$/.test(value.trim()) ? value.trim() : presetValue;
}

/**
 * Per-trip theme → CSS variables (--trip-*) consumed by the Tailwind tokens.
 *
 * The single place untrusted `theme` values are sanitised (DESIGN.md §6.4):
 * strict parse with preset fallback, then WCAG contrast with OKLCH
 * auto-derive — never a silent reject. Semantic status colours are deliberately
 * absent here: they are never per-trip (DESIGN.md §5.1).
 *
 * Contrast is checked against the light runtime (the only mode the app and
 * the booklet render today). The dark palettes are pinned by the preset test
 * instead, so enabling `data-theme` later cannot regress them.
 */
export function tripStyle(trip: Trip): CSSProperties {
  const preset = tripPreset(trip);
  const bg = preset.light.background;
  const theme = trip.theme ?? {};
  const style: Record<string, string> = {};

  // Signature colours: parse strictly, then fit to the paper they sit on.
  const primary = ensureContrast(overrideColor(theme.primary, preset.light.primary), bg, 4.5);
  const accent = ensureContrast(overrideColor(theme.accent, preset.light.accent), bg, 3);
  style["--trip-bg"] = bg;
  style["--trip-fg"] = preset.light.foreground;
  style["--trip-primary"] = primary;
  style["--trip-primary-fg"] = readableFgOn(primary);
  style["--trip-accent"] = accent;
  style["--trip-accent-fg"] = readableFgOn(accent);

  // Paper tint: parsed strictly but never contrast-derived — it is a
  // background by design, and deriving it would erase the preset's voice.
  const surface = overrideColor(theme.surface, preset.light.surface);
  style["--trip-surface"] = surface;
  style["--trip-card"] = surface;

  // Type roles: the legacy `font` scalar keeps working as the body role.
  const body = overrideFont(theme.bodyFont ?? theme.font, preset.fonts.body);
  style["--trip-font-display"] = overrideFont(theme.displayFont, preset.fonts.display);
  style["--trip-font-heading"] = overrideFont(theme.headingFont, preset.fonts.heading);
  style["--trip-font-body"] = body;
  style["--trip-font"] = body;

  // Radius: one knob in the data, the full Tailwind scale in the CSS.
  const radius = overrideRadius(theme.radius, preset.radius);
  const unit = radius.endsWith("px") ? "px" : radius.endsWith("em") ? "em" : "rem";
  const base = parseFloat(radius);
  const scale = (f: number) => `${Math.round(base * f * 1000) / 1000}${unit}`;
  style["--trip-radius"] = radius;
  style["--trip-radius-sm"] = scale(0.67);
  style["--trip-radius-md"] = radius;
  style["--trip-radius-lg"] = scale(1.33);
  style["--trip-radius-xl"] = scale(2);

  // Map identity: the route and pins ARE the trip colour (tokens.ts reads
  // these off the DOM — no hex literal belongs in map code). Per-trip map
  // overrides are parsed strictly; casing defaults to paper-white.
  style["--trip-route"] = overrideColor(theme.mapStyle?.route, primary);
  style["--trip-route-casing"] = overrideColor(theme.mapStyle?.routeCasing, "#ffffff");
  style["--trip-marker"] = overrideColor(theme.mapStyle?.marker, primary);
  style["--trip-marker-fg"] = overrideColor(theme.mapStyle?.markerFg, readableFgOn(primary));

  return style as CSSProperties;
}
