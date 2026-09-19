import { useEffect, useState } from "react";
import type { Day, TripLocation } from "./types";

/**
 * Live weather overlay (#334) — Open-Meteo forecast behind the backend
 * proxy (`/api/weather/forecast`).
 *
 * Same trust pattern as the Places overlay (`place-live.ts`): the browser
 * never talks to Open-Meteo, nothing weather-derived is ever stored (the
 * payload lives in this React state and in the backend's 30-min display
 * cache only, #15/#95), and any miss answers `{ available: false }` so
 * callers render nothing. Open-Meteo data is CC BY 4.0 — the UI must
 * render the attribution line wherever it renders data.
 *
 * The readout is deliberately GENERAL (conditions · temperature ·
 * precipitation chance) because most trips are not powder trips; the snow
 * figure is one more token, shown only when the forecast has snow to
 * report. Nothing here is trip-type-aware — the forecast itself decides
 * what appears, so there is no per-trip weather knob.
 */

export interface WeatherDay {
  date: string;
  wmo: number | null;
  tmax_c: number | null;
  tmin_c: number | null;
  snowfall_cm: number | null;
  precip_prob: number | null;
  snow_depth_m: number | null;
}

export interface WeatherForecast {
  available: boolean;
  lat: number;
  lng: number;
  timezone?: string;
  current: { time?: string; temp_c: number | null; snowfall_cm: number | null; wmo: number | null };
  daily: WeatherDay[];
  attribution: { source: string; url: string };
}

/** CC BY 4.0 credit — render wherever forecast data is shown. */
export const WEATHER_ATTRIBUTION = { source: "Open-Meteo", url: "https://open-meteo.com/" } as const;

export function weatherForecastUrl(lat: number, lng: number, days = 7): string {
  return `/api/weather/forecast?lat=${lat}&lng=${lng}&days=${days}`;
}

/** Fulfilled forecast promises, session-scoped. Several day rows share one
 *  location (three days at Revelstoke = three identical requests), so the
 *  in-flight promise is shared: one request per point per session, and the
 *  backend's own 30-min cache absorbs the rest. A reload re-reads. */
const _pending = new Map<string, Promise<WeatherDay[] | null>>();

function fetchDaily(url: string): Promise<WeatherDay[] | null> {
  const hit = _pending.get(url);
  if (hit) return hit;
  const p = fetch(url)
    .then((r) => (r.ok ? r.json() : { available: false }))
    .then((d) => (d?.available && Array.isArray(d.daily) ? (d.daily as WeatherDay[]) : null))
    .catch(() => null);
  _pending.set(url, p);
  return p;
}

/** Test isolation — drop the shared request cache. */
export function clearWeatherCache(): void {
  _pending.clear();
}

/**
 * Fetch-on-mount daily forecast for one point. Null while loading and when
 * Open-Meteo has nothing (graceful absence — the card renders exactly as
 * before).
 *
 * Never fetched for print: the booklet PDF renders under emulated print
 * media and Ctrl+P flips the same media query. The overlay is web-only.
 */
export function useWeatherDaily(
  lat: number | null | undefined,
  lng: number | null | undefined,
  days = 7,
): WeatherDay[] | null {
  const [daily, setDaily] = useState<WeatherDay[] | null>(null);
  const hasCoords = lat != null && lng != null;
  useEffect(() => {
    if (!hasCoords) return;
    // `matchMedia` is universally available in the browsers Kiseki targets,
    // but a missing/odd implementation must never break the card — optional
    // access keeps the overlay from throwing on an absent API.
    if (typeof window !== "undefined" && window.matchMedia?.("print")?.matches) return;
    let alive = true;
    setDaily(null);
    void fetchDaily(weatherForecastUrl(lat as number, lng as number, days)).then((d) => {
      if (alive) setDaily(d);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCoords, lat, lng, days]);
  return daily;
}

/** The forecast entry for one trip date (exact ISO match) — null when the
 *  date falls outside the returned window. That IS the honest empty state:
 *  no API forecasts a ski trip months out, and the caller renders NOTHING
 *  (no placeholder, no reserved box). */
export function dayWeather(daily: WeatherDay[] | null, date: string): WeatherDay | null {
  if (!daily || !date) return null;
  return daily.find((d) => d.date === date) ?? null;
}

/** First registry coords a day's blocks point at (block `location` matched
 *  against name/alias, #91 derivation rule) — null when the day floats
 *  free of the registry. Pure so the itinerary row stays testable. */
export function dayCoords(
  day: Day,
  locations?: TripLocation[],
): { lat: number; lng: number } | null {
  if (!day || !locations?.length) return null;
  for (const b of day.blocks ?? []) {
    const ref = (b.location ?? "").trim().toLowerCase();
    if (!ref) continue;
    const loc = locations.find(
      (l) => l.name.toLowerCase() === ref || (l.alias ?? []).some((a) => a.toLowerCase() === ref),
    );
    if (loc?.lat != null && loc?.lng != null) return { lat: loc.lat, lng: loc.lng };
  }
  return null;
}

/** Condition family — drives the icon and the label. Snow-family codes
 *  double as the "is there snow to report" test. */
export type WeatherKind = "clear" | "cloud" | "rain" | "snow" | "storm" | "fog" | "unknown";

const _SNOW_CODES = [71, 73, 75, 77, 85, 86];
const _RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
const _STORM_CODES = [95, 96, 99];
const _FOG_CODES = [45, 48];

export function weatherKind(wmo: number | null | undefined): WeatherKind {
  if (wmo == null) return "unknown";
  if (_SNOW_CODES.includes(wmo)) return "snow";
  if (_RAIN_CODES.includes(wmo)) return "rain";
  if (_STORM_CODES.includes(wmo)) return "storm";
  if (_FOG_CODES.includes(wmo)) return "fog";
  if (wmo === 0) return "clear";
  if (wmo <= 3) return "cloud";
  return "unknown";
}

/** One-word condition label. Unknown codes read as "" (no label, no lie). */
export function weatherLabel(wmo: number | null | undefined): string {
  const kind = weatherKind(wmo);
  return kind === "unknown" ? "" : kind[0].toUpperCase() + kind.slice(1);
}

/** A day's readout tokens — the ONE place the display rules live, shared by
 *  the location strip and the day pill.
 *
 *  Always: temperature high (and low when known) + precipitation chance.
 *  Plus the snow figure when there is snow to report — a forecast snowfall
 *  ≥ 0.5 cm, or a real snowpack on the ground (≥ 10 cm base). A beach or
 *  city day therefore reads "31° · 10%" with no snow talk at all, and the
 *  snow tokens appear exactly when they mean something. No trip-type
 *  detection, no setting. */
export interface WeatherReadout {
  kind: WeatherKind;
  label: string;
  /** "9°" or "9° / -3°". */
  temp: string | null;
  /** "45%". */
  precip: string | null;
  /** "12 cm" — forecast snowfall for the day. */
  snow: string | null;
  /** "35 cm" — snowpack on the ground. */
  base: string | null;
}

export function weatherReadout(day: WeatherDay | null | undefined): WeatherReadout | null {
  if (!day) return null;
  const kind = weatherKind(day.wmo);
  const label = weatherLabel(day.wmo);
  const temp =
    day.tmax_c == null
      ? null
      : day.tmin_c == null
        ? `${Math.round(day.tmax_c)}°`
        : `${Math.round(day.tmax_c)}° / ${Math.round(day.tmin_c)}°`;
  const precip = day.precip_prob == null ? null : `${Math.round(day.precip_prob)}%`;
  const snowy = kind === "snow" || (day.snowfall_cm ?? 0) >= 0.5;
  const snow = snowy ? `${cm(day.snowfall_cm)} cm` : null;
  const depth = day.snow_depth_m ?? 0;
  const base = depth >= 0.1 ? `${Math.round(depth * 100)} cm` : null;
  if (temp == null && precip == null && snow == null && base == null && !label) return null;
  return { kind, label, temp, precip, snow, base };
}

function cm(value: number | null | undefined): string {
  if (value == null) return "0";
  return value >= 0.5 ? String(Math.round(value)) : "0";
}

/** "Fri 19" from an ISO date — weekday + day number, no year. */
export function shortDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()}`;
}
