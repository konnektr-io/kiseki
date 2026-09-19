import { useEffect, useState } from "react";
import type { Day, TripLocation } from "./types";

/**
 * Live snow-weather overlay (#334) — Open-Meteo forecast behind the
 * backend proxy (`/api/weather/forecast`).
 *
 * Same trust pattern as the Places overlay (`place-live.ts`): the browser
 * never talks to Open-Meteo, nothing weather-derived is ever stored (the
 * payload lives in this React state and in the backend's 30-min display
 * cache only, #15/#95), and any miss answers `{ available: false }` so
 * callers render nothing. Open-Meteo data is CC BY 4.0 — the UI must
 * render the attribution line wherever it renders data.
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

/**
 * Fetch-on-mount daily snow forecast for one point. Null while loading
 * and when Open-Meteo has nothing (graceful absence — the card renders
 * exactly as before).
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
    if (typeof window !== "undefined" && window.matchMedia("print").matches) return;
    let alive = true;
    setDaily(null);
    fetch(weatherForecastUrl(lat as number, lng as number, days))
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((d) => {
        if (alive && d?.available && Array.isArray(d.daily)) setDaily(d.daily as WeatherDay[]);
      })
      .catch(() => {
        /* overlay stays absent — the card is complete without it */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCoords, days]);
  return daily;
}

/** The forecast entry for one trip date (exact ISO match) — null when the
 *  date falls outside the returned window. That IS the honest empty state:
 *  no API forecasts a ski trip months out. */
export function daySnow(daily: WeatherDay[] | null, date: string): WeatherDay | null {
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

/** One-word WMO weather-code label — snowfall codes first (this overlay
 *  exists for powder), everything else compact. Unknown codes read as "". */
export function wmoLabel(wmo: number | null | undefined): string {
  if (wmo == null) return "";
  if ([71, 73, 75, 77, 85, 86].includes(wmo)) return "Snow";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(wmo)) return "Rain";
  if ([95, 96, 99].includes(wmo)) return "Storm";
  if ([45, 48].includes(wmo)) return "Fog";
  if (wmo === 0) return "Clear";
  if (wmo <= 3) return "Cloud";
  return "";
}
