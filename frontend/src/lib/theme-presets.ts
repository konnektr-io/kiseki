/**
 * The twelve curated trip identities (#40 D1).
 *
 * Pure data — no per-preset `if`/`switch` anywhere. An agent picks one by id
 * when it creates a trip ("Japan in winter → nordic") and a human overrides
 * scalar values later without a deploy. Names are moods, not destinations.
 *
 * Each preset carries a light AND a dark palette (print always uses light),
 * the three font roles (families change, roles never do), a radius voice
 * (sharp editorial ↔ soft album) and a mapStyle (basemap density, runtime
 * tint, terrain). Route/marker colours are NOT stored: they resolve from the
 * palette at emit time (`theme.tsx`), so the map can never drift from the UI.
 */

export type PresetBasemap = "positron" | "bright" | "liberty" | "dark";

export interface PresetPalette {
  /** Page paper. */
  background: string;
  /** Body text on the background (≥4.5:1, pinned by test). */
  foreground: string;
  /** The trip's voice — links, nav, route lines (≥4.5:1 vs background). */
  primary: string;
  /** Confirmed/booked states, map highlights (≥3:1 vs background). */
  accent: string;
  /** Card paper — the tint that makes two albums feel different. */
  surface: string;
}

export interface PresetTerrain {
  hillshade: boolean;
  exaggeration: number;
  terrain3d: boolean;
}

export interface PresetMapStyle {
  /** Prebuilt OpenFreeMap style key — density varies per trip (minimal ↔ dense). */
  basemap: PresetBasemap;
  /** Runtime tint of the base layers (never labels/glyphs — see maps.ts). */
  tint?: {
    background?: string;
    water?: string;
    landcover?: string;
    park?: string;
    boundary?: string;
  };
  terrain: PresetTerrain;
  /** Escape hatch: a full custom style JSON URL wins over `basemap`. */
  styleUrl?: string;
}

export interface ThemePreset {
  id: string;
  /** One line for the preset picker / agent prompt. */
  blurb: string;
  light: PresetPalette;
  dark: PresetPalette;
  fonts: { display: string; heading: string; body: string };
  /** Corner voice, CSS length shifting the whole radius scale. */
  radius: string;
  mapStyle: PresetMapStyle;
}

const PRESETS: ThemePreset[] = [
  {
    id: "alpine",
    blurb: "Cold blue, condensed type, full relief — the heliski week.",
    light: {
      background: "#f2f6fb",
      foreground: "#17233a",
      primary: "#1e3a8a",
      accent: "#0f766e",
      surface: "#ffffff",
    },
    dark: {
      background: "#0b1526",
      foreground: "#e3ebf7",
      primary: "#93c5fd",
      accent: "#2dd4bf",
      surface: "#111f33",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Oswald', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.25rem",
    mapStyle: {
      basemap: "positron",
      terrain: { hillshade: true, exaggeration: 0.7, terrain3d: true },
    },
  },
  {
    id: "nordic",
    blurb: "Near-monochrome, high whitespace, quiet map — winter minimalism.",
    light: {
      background: "#fafafa",
      foreground: "#27272a",
      primary: "#3f3f46",
      accent: "#52525b",
      surface: "#ffffff",
    },
    dark: {
      background: "#101012",
      foreground: "#e4e4e7",
      primary: "#e4e4e7",
      accent: "#a1a1aa",
      surface: "#18181b",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Oswald', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.25rem",
    mapStyle: {
      basemap: "positron",
      tint: { background: "#fafafa", water: "#e2e2e6", landcover: "#f0f0f2", park: "#e8ebe8", boundary: "#c9c9cf" },
      terrain: { hillshade: false, exaggeration: 0, terrain3d: false },
    },
  },
  {
    id: "desert",
    blurb: "Ochre and clay under a warm serif — canyon country.",
    light: {
      background: "#faf5ec",
      foreground: "#3d2a18",
      primary: "#9a3412",
      accent: "#b45309",
      surface: "#fffdf7",
    },
    dark: {
      background: "#1c1008",
      foreground: "#f5e8d5",
      primary: "#fdba74",
      accent: "#f59e0b",
      surface: "#2a1a0c",
    },
    fonts: { display: "'Fraunces', Georgia, serif", heading: "'Fraunces', Georgia, serif", body: "'Inter', sans-serif" },
    radius: "0.5rem",
    mapStyle: {
      basemap: "liberty",
      tint: { background: "#faf5ec", water: "#e5d9bd", landcover: "#f3ead3", park: "#e4dfc0", boundary: "#c9b183" },
      terrain: { hillshade: true, exaggeration: 0.5, terrain3d: true },
    },
  },
  {
    id: "monsoon",
    blurb: "Deep green and teal, dense map — the tropics in the rains.",
    light: {
      background: "#effaf4",
      foreground: "#123527",
      primary: "#065f46",
      accent: "#0e7490",
      surface: "#ffffff",
    },
    dark: {
      background: "#071712",
      foreground: "#d9f2e5",
      primary: "#6ee7b7",
      accent: "#22d3ee",
      surface: "#0d2119",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Space Grotesk', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.375rem",
    mapStyle: {
      basemap: "liberty",
      tint: { background: "#effaf4", water: "#bcdcc9", landcover: "#dcefe0", park: "#c4e2c9", boundary: "#9dbfa6" },
      terrain: { hillshade: true, exaggeration: 0.6, terrain3d: true },
    },
  },
  {
    id: "archive",
    blurb: "Sepia paper, book serif, minimal map — the trip as a volume.",
    light: {
      background: "#f5efe2",
      foreground: "#3a2d1a",
      primary: "#713f12",
      accent: "#92400e",
      surface: "#fdf9ef",
    },
    dark: {
      background: "#171208",
      foreground: "#ece0c4",
      primary: "#e8cf9a",
      accent: "#f59e0b",
      surface: "#221a0c",
    },
    fonts: { display: "'Fraunces', Georgia, serif", heading: "'Fraunces', Georgia, serif", body: "Georgia, 'Times New Roman', serif" },
    radius: "0.25rem",
    mapStyle: {
      basemap: "positron",
      tint: { background: "#f5efe2", water: "#ddd2b8", landcover: "#ece3cb", park: "#e0d7b8", boundary: "#b8a67e" },
      terrain: { hillshade: false, exaggeration: 0, terrain3d: false },
    },
  },
  {
    id: "coastal",
    blurb: "Sea air and pale blue — island-hopping, ferries, salt.",
    light: {
      background: "#eef7fa",
      foreground: "#14344a",
      primary: "#0c4a6e",
      accent: "#0369a1",
      surface: "#ffffff",
    },
    dark: {
      background: "#08131b",
      foreground: "#d9edf6",
      primary: "#7dd3fc",
      accent: "#38bdf8",
      surface: "#0e1f29",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Oswald', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.625rem",
    mapStyle: {
      basemap: "bright",
      tint: { background: "#eef7fa", water: "#c2e2f0" },
      terrain: { hillshade: false, exaggeration: 0, terrain3d: false },
    },
  },
  {
    id: "highland",
    blurb: "Moss and granite with the relief turned up — walking country.",
    light: {
      background: "#f1f4ec",
      foreground: "#26301a",
      primary: "#3f6212",
      accent: "#4d7c0f",
      surface: "#fbfdf8",
    },
    dark: {
      background: "#101408",
      foreground: "#e2ebcf",
      primary: "#bef264",
      accent: "#a3e635",
      surface: "#1a2010",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Oswald', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.375rem",
    mapStyle: {
      basemap: "bright",
      tint: { background: "#f1f4ec", water: "#c3d8c9", landcover: "#dfe8d2", park: "#ccd9b8", boundary: "#a3b184" },
      terrain: { hillshade: true, exaggeration: 0.7, terrain3d: true },
    },
  },
  {
    id: "ember",
    blurb: "Warm red and clay over dark earth — volcanic ground.",
    light: {
      background: "#faf1ec",
      foreground: "#3d1d16",
      primary: "#7f1d1d",
      accent: "#b45309",
      surface: "#fffdfb",
    },
    dark: {
      background: "#1c0d0b",
      foreground: "#f6e3da",
      primary: "#fca5a5",
      accent: "#fb923c",
      surface: "#2a1410",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Oswald', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.375rem",
    mapStyle: {
      basemap: "liberty",
      tint: { background: "#faf1ec", water: "#e8cdb8", landcover: "#f2e2d2", park: "#e6d5b8", boundary: "#c8a181" },
      terrain: { hillshade: true, exaggeration: 0.7, terrain3d: true },
    },
  },
  {
    id: "tundra",
    blurb: "Pale ice-blue, crisp grotesk, flat light — the far north.",
    light: {
      background: "#f4f8fa",
      foreground: "#1d303c",
      primary: "#155e75",
      accent: "#475569",
      surface: "#ffffff",
    },
    dark: {
      background: "#0a1116",
      foreground: "#dcedf5",
      primary: "#a5f3fc",
      accent: "#94a3b8",
      surface: "#101b22",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Space Grotesk', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.25rem",
    mapStyle: {
      basemap: "positron",
      tint: { background: "#f4f8fa", water: "#cfe3ec", landcover: "#e8f0f3", boundary: "#b3c9d4" },
      terrain: { hillshade: true, exaggeration: 0.4, terrain3d: false },
    },
  },
  {
    id: "sakura",
    blurb: "Soft pink, serif display, round corners — the album trip.",
    light: {
      background: "#fdf2f6",
      foreground: "#451525",
      primary: "#9d174d",
      accent: "#be185d",
      surface: "#fffbfd",
    },
    dark: {
      background: "#1c0b14",
      foreground: "#f8dce9",
      primary: "#f9a8d4",
      accent: "#f472b6",
      surface: "#2a1220",
    },
    fonts: { display: "'Fraunces', Georgia, serif", heading: "'Fraunces', Georgia, serif", body: "'Inter', sans-serif" },
    radius: "0.75rem",
    mapStyle: {
      basemap: "positron",
      tint: { background: "#fdf2f6", water: "#f2cddf", landcover: "#f8e4ec", park: "#f2d5de", boundary: "#d9a9bd" },
      terrain: { hillshade: false, exaggeration: 0, terrain3d: false },
    },
  },
  {
    id: "savanna",
    blurb: "Golden grass and long light — overland, dust, distance.",
    light: {
      background: "#f8f4e4",
      foreground: "#3a2f14",
      primary: "#713f12",
      accent: "#a16207",
      surface: "#fffdf4",
    },
    dark: {
      background: "#161204",
      foreground: "#efe6c4",
      primary: "#fde047",
      accent: "#eab308",
      surface: "#211b08",
    },
    fonts: { display: "'Bebas Neue', sans-serif", heading: "'Oswald', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.5rem",
    mapStyle: {
      basemap: "liberty",
      tint: { background: "#f8f4e4", water: "#ddd3a8", landcover: "#efe8c8", park: "#e2d8a8", boundary: "#bfae72" },
      terrain: { hillshade: true, exaggeration: 0.4, terrain3d: false },
    },
  },
  {
    id: "nocturne",
    blurb: "Violet night with vivid signal colours — after dark.",
    light: {
      background: "#f1f0f7",
      foreground: "#241d42",
      primary: "#4c1d95",
      accent: "#6d28d9",
      surface: "#ffffff",
    },
    dark: {
      background: "#0d0a1a",
      foreground: "#e2dbf7",
      primary: "#c4b5fd",
      accent: "#a78bfa",
      surface: "#171226",
    },
    fonts: { display: "'Space Grotesk', sans-serif", heading: "'Space Grotesk', sans-serif", body: "'Inter', sans-serif" },
    radius: "0.25rem",
    mapStyle: {
      basemap: "dark",
      terrain: { hillshade: true, exaggeration: 0.6, terrain3d: true },
    },
  },
];

/** The twelve mood ids, in curated order. */
export const PRESET_IDS = PRESETS.map((p) => p.id);

export const DEFAULT_PRESET_ID = "alpine";

const BY_ID: Record<string, ThemePreset> = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

/** Unknown/absent ids fall back to the default — a bad string never breaks a trip. */
export function presetById(id: string | null | undefined): ThemePreset {
  if (id && BY_ID[id]) return BY_ID[id];
  return BY_ID[DEFAULT_PRESET_ID];
}
