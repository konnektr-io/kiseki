import { describe, expect, it } from "vitest";
import { tripPreset, tripStyle } from "./theme";
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

  it("falls back to the default preset on an unknown/absent id and never throws", () => {
    const fallback = vars(trip(undefined));
    for (const theme of [undefined, { preset: "atlantis" }, { preset: "" }, { preset: null }]) {
      const v = vars(trip(theme as Trip["theme"]));
      expect(tripPreset(trip(theme as Trip["theme"])).id).toBe("alpine");
      expect(v["--trip-primary"]).toBe(fallback["--trip-primary"]);
    }
    expect(() => tripStyle(trip({ preset: "atlantis" }))).not.toThrow();
  });

  it("ignores legacy per-trip fields — they never reach a --trip-* variable", () => {
    const clean = vars(trip({ preset: "ember" }));
    const legacy = {
      preset: "ember",
      primary: "#ff0000",
      accent: "#00ff00",
      surface: "#000000",
      font: "Comic Sans MS",
      displayFont: "Comic Sans MS",
      headingFont: "Comic Sans MS",
      bodyFont: "Comic Sans MS",
      radius: "99px",
      mapStyle: { basemap: "dark", styleUrl: "https://example.com/evil.json", route: "#ff0000" },
    } as unknown as Trip["theme"];
    const v = vars(trip(legacy));
    expect(v).toEqual(clean);
    for (const value of Object.values(v)) {
      expect(value).not.toBe("#ff0000");
      expect(value).not.toBe("#00ff00");
      expect(value).not.toContain("Comic Sans");
      expect(value).not.toContain("evil.json");
    }
  });

  it("never emits semantic status colours", () => {
    const v = vars(trip({ preset: "nocturne" }));
    for (const key of Object.keys(v)) {
      expect(key).not.toMatch(/destructive|success|warning/);
    }
  });

  it("drives the map from the trip colour", () => {
    const v = vars(trip({ preset: "ember" }));
    expect(v["--trip-route"]).toBe(v["--trip-primary"]);
    expect(v["--trip-marker"]).toBe(v["--trip-primary"]);
  });
});
