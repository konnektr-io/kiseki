import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";
import type { Trip } from "../lib/types";
import { ensureContrast, readableFgOn } from "../lib/color";
import { ensurePresetFonts } from "../lib/fonts";
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
  // Preset fonts load lazily, keyed by preset (#40 D5) — here so every themed
  // subtree (TripLayout, JoinPage, and the booklet under TripLayout) requests
  // its families. The booklet PDF awaits document.fonts.ready AFTER content
  // renders (pdf.py), i.e. after this effect has fired, so lazy families are
  // in flight before the await — a fonts.ready that resolved before the CSS
  // asked for the font would silently print the fallback stack.
  useEffect(() => {
    void ensurePresetFonts(trip.theme?.preset);
  }, [trip.theme?.preset]);
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
 * Per-trip theme → CSS variables (--trip-*) consumed by the Tailwind tokens.
 *
 * The preset is the single source: colours, fonts and radius resolve ONLY
 * from the preset (#40 follow-up). Retired per-trip fields that may still
 * linger in a trip document (primary/accent/surface/font/…/radius/mapStyle)
 * are ignored — they are not read here, so they can never reach a variable.
 *
 * `ensureContrast()` stays applied to the preset's own colours as a defensive
 * no-op (every palette is pinned by theme-presets.test.ts). Semantic status
 * colours are deliberately absent here: they are never per-trip (DESIGN.md §5.1).
 *
 * Contrast is checked against the light runtime (the only mode the app and
 * the booklet render today). The dark palettes are pinned by the preset test
 * instead, so enabling `data-theme` later cannot regress them.
 */
export function tripStyle(trip: Trip): CSSProperties {
  const preset = tripPreset(trip);
  const bg = preset.light.background;
  const style: Record<string, string> = {};

  // Signature colours: the preset's own, fitted to the paper they sit on.
  const primary = ensureContrast(preset.light.primary, bg, 4.5);
  const accent = ensureContrast(preset.light.accent, bg, 3);
  style["--trip-bg"] = bg;
  style["--trip-fg"] = preset.light.foreground;
  style["--trip-primary"] = primary;
  style["--trip-primary-fg"] = readableFgOn(primary);
  style["--trip-accent"] = accent;
  style["--trip-accent-fg"] = readableFgOn(accent);

  // Paper tint: the preset's voice, never contrast-derived — it is a
  // background by design, and deriving it would erase the preset's voice.
  style["--trip-surface"] = preset.light.surface;
  style["--trip-card"] = preset.light.surface;

  // Type roles: straight from the preset.
  style["--trip-font-display"] = preset.fonts.display;
  style["--trip-font-heading"] = preset.fonts.heading;
  style["--trip-font-body"] = preset.fonts.body;
  style["--trip-font"] = preset.fonts.body;

  // Radius: one voice in the preset, the full Tailwind scale in the CSS.
  const radius = preset.radius;
  const unit = radius.endsWith("px") ? "px" : radius.endsWith("em") ? "em" : "rem";
  const base = parseFloat(radius);
  const scale = (f: number) => `${Math.round(base * f * 1000) / 1000}${unit}`;
  style["--trip-radius"] = radius;
  style["--trip-radius-sm"] = scale(0.67);
  style["--trip-radius-md"] = radius;
  style["--trip-radius-lg"] = scale(1.33);
  style["--trip-radius-xl"] = scale(2);

  // Map identity: the route and pins ARE the trip colour (tokens.ts reads
  // these off the DOM — no hex literal belongs in map code). Casing is
  // paper-white.
  style["--trip-route"] = primary;
  style["--trip-route-casing"] = "#ffffff";
  style["--trip-marker"] = primary;
  style["--trip-marker-fg"] = readableFgOn(primary);

  return style as CSSProperties;
}
