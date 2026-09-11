import { describe, expect, it } from "vitest";
import { tripPreset, tripStyle } from "./theme";
import { contrastRatio, parseHexColor } from "../lib/color";
import type { Trip } from "../lib/types";

function trip(theme: Trip["theme"]): Trip {
  return {
    id: "t-40",
    slug: "preset-trip",
    title: "Preset trip",
    stage: "planned",
    visibility: "private",
    crew: [],
    practical: {},
    days: [],
    theme,
  } as Trip;
}

function vars(t: Trip): Record<string, string> {
  return tripStyle(t) as unknown as Record<string, string>;
}

describe("tripStyle", () => {
  it("resolves the default preset when none is set, emitting the full token set", () => {
    const v = vars(trip(undefined));
    expect(tripPreset(trip(undefined)).id).toBe("alpine");
    for (const key of [
      "--trip-bg",
      "--trip-fg",
      "--trip-primary",
      "--trip-primary-fg",
      "--trip-accent",
      "--trip-accent-fg",
      "--trip-surface",
      "--trip-card",
      "--trip-font-display",
      "--trip-font-heading",
      "--trip-font-body",
      "--trip-font",
      "--trip-radius",
      "--trip-radius-sm",
      "--trip-radius-md",
      "--trip-radius-lg",
      "--trip-radius-xl",
      "--trip-route",
      "--trip-route-casing",
      "--trip-marker",
      "--trip-marker-fg",
    ]) {
      expect(v[key], key).toBeTruthy();
    }
  });

  it("falls back to the default preset on an unknown id", () => {
    expect(vars(trip({ preset: "atlantis" }))["--trip-primary"]).toBe(
      vars(trip(undefined))["--trip-primary"],
    );
  });

  it("keeps a passing override byte-identical (canada keeps its blue)", () => {
    const v = vars(trip({ preset: "alpine", primary: "#1e3a8a", accent: "#0f766e" }));
    expect(v["--trip-primary"]).toBe("#1e3a8a");
    expect(v["--trip-accent"]).toBe("#0f766e");
    expect(v["--trip-primary-fg"]).toBe("#ffffff");
  });

  it("rejects non-hex input to the preset value, then auto-derives failures", () => {
    const fallback = vars(trip({ preset: "alpine" }));
    const v = vars(trip({ preset: "alpine", primary: "red", accent: "var(--x)" }));
    expect(v["--trip-primary"]).toBe(fallback["--trip-primary"]);
    expect(v["--trip-accent"]).toBe(fallback["--trip-accent"]);

    // A pale override on light paper cannot stand — it comes back darker and passing.
    const derived = vars(trip({ preset: "alpine", primary: "#d6cfff" }));
    expect(derived["--trip-primary"]).not.toBe("#d6cfff");
    expect(
      contrastRatio(parseHexColor(derived["--trip-primary"])!, parseHexColor(derived["--trip-bg"])!),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        parseHexColor(derived["--trip-primary-fg"])!,
        parseHexColor(derived["--trip-primary"])!,
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("honours the legacy font scalar as the body role", () => {
    expect(vars(trip({ font: "Georgia, serif" }))["--trip-font-body"]).toBe("Georgia, serif");
    expect(vars(trip({ font: "Georgia, serif" }))["--trip-font"]).toBe("Georgia, serif");
  });

  it("sanitises hostile font and radius input to the preset", () => {
    const fallback = vars(trip({ preset: "alpine" }));
    const v = vars(
      trip({ preset: "alpine", bodyFont: "x; color: red", radius: "10px; color:red" } as Trip["theme"]),
    );
    expect(v["--trip-font-body"]).toBe(fallback["--trip-font-body"]);
    expect(v["--trip-radius"]).toBe(fallback["--trip-radius"]);
    expect(vars(trip({ preset: "alpine", radius: "1rem" }))["--trip-radius"]).toBe("1rem");
  });

  it("never emits semantic status colours", () => {
    const v = vars(trip({ preset: "nocturne", primary: "#ff0000", accent: "#00ff00" }));
    for (const key of Object.keys(v)) {
      expect(key).not.toMatch(/destructive|success|warning/);
    }
  });

  it("drives the map from the trip colour unless overridden", () => {
    const v = vars(trip({ preset: "ember" }));
    expect(v["--trip-route"]).toBe(v["--trip-primary"]);
    expect(v["--trip-marker"]).toBe(v["--trip-primary"]);
    const w = vars(trip({ preset: "ember", mapStyle: { route: "#123456" } }));
    expect(w["--trip-route"]).toBe("#123456");
    expect(w["--trip-marker"]).toBe(w["--trip-primary"]);
  });

  it("surface overrides tint the card without being derived away", () => {
    expect(vars(trip({ preset: "alpine", surface: "#f5efe2" }))["--trip-card"]).toBe("#f5efe2");
  });
});
