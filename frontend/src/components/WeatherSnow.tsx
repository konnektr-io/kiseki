import { Snowflake } from "lucide-react";
import {
  WEATHER_ATTRIBUTION,
  dayCoords,
  daySnow,
  useWeatherDaily,
  wmoLabel,
  type WeatherDay,
} from "../lib/weather-live";
import type { Day, TripLocation } from "../lib/types";

/** "Fri 19" from an ISO date — weekday + day number, no year. */
function shortDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()}`;
}

function snowText(snowfall_cm: number | null): string {
  if (snowfall_cm == null) return "—";
  return snowfall_cm >= 0.5 ? `${Math.round(snowfall_cm)} cm` : "0 cm";
}

/** Attribution line (CC BY 4.0) — rendered under every weather readout. */
function Credit() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Snow forecast by{" "}
      <a
        href={WEATHER_ATTRIBUTION.url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-foreground hover:underline focus-visible:focus-ring"
      >
        {WEATHER_ATTRIBUTION.source}
      </a>
    </p>
  );
}

/**
 * Five-day snowfall strip for a registry place — the location-level
 * readout (#334). Coords come straight from the registry entry; renders
 * nothing without coords, while loading, or when Open-Meteo has nothing
 * (graceful absence — the place card is complete without it).
 *
 * Web-only (`no-print`): the booklet never calls a live API (#95 rule).
 */
export function SnowStrip({ lat, lng }: { lat?: number | null; lng?: number | null }) {
  const daily = useWeatherDaily(lat, lng, 5);
  if (lat == null || lng == null || !daily?.length) return null;
  return (
    <div className="no-print space-y-1" aria-label="Snow forecast">
      <ul className="flex flex-wrap gap-1.5">
        {daily.map((d: WeatherDay) => (
          <li
            key={d.date}
            title={`${d.date}${wmoLabel(d.wmo) ? ` · ${wmoLabel(d.wmo)}` : ""}`}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] tabular-nums ${
              (d.snowfall_cm ?? 0) >= 0.5
                ? "border-primary/40 bg-primary/10 font-semibold text-foreground"
                : "border-border bg-card text-muted-foreground"
            }`}
          >
            <span className="font-medium">{shortDay(d.date)}</span>
            <Snowflake className="h-3 w-3" aria-hidden="true" />
            <span>{snowText(d.snowfall_cm)}</span>
          </li>
        ))}
      </ul>
      <Credit />
    </div>
  );
}

/**
 * One-day powder pill for an itinerary row — the day-level readout (#334).
 * Resolves the day to registry coords (first located block) and renders
 * the forecast for that exact date, or nothing when the date falls outside
 * the 16-day window (the honest empty state — no API forecasts months out).
 *
 * Web-only (`no-print`), a non-interactive span so it can sit inside the
 * day row's link.
 */
export function DaySnowPill({ day, locations }: { day: Day; locations?: TripLocation[] }) {
  const coords = dayCoords(day, locations);
  const daily = useWeatherDaily(coords?.lat, coords?.lng, 7);
  if (!coords) return null;
  const match = daySnow(daily, day.date);
  if (!match) return null;
  const snow = match.snowfall_cm ?? 0;
  return (
    <span className="no-print inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
      <Snowflake
        className={`h-3 w-3 ${snow >= 0.5 ? "text-primary" : ""}`}
        aria-hidden="true"
      />
      <span className={snow >= 0.5 ? "font-semibold text-foreground" : undefined}>
        {snowText(match.snowfall_cm)}
      </span>
      {/* Plain-text credit: this pill lives inside the day row's link, so a
          nested <a> would be invalid HTML — the linked credit line lives on
          the SnowStrip. The source is still named (CC BY 4.0). */}
      <span title="Snow forecast by Open-Meteo (https://open-meteo.com/)">· Open-Meteo</span>
    </span>
  );
}
