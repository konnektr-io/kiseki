import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, Sun, Thermometer } from "lucide-react";
import {
  WEATHER_ATTRIBUTION,
  dayCoords,
  dayWeather,
  shortDay,
  useWeatherDaily,
  weatherReadout,
  withinForecastWindow,
  type WeatherKind,
  type WeatherReadout,
} from "../lib/weather-live";
import type { Day, TripLocation } from "../lib/types";
import { tripTodayIso } from "../lib/dates";

/** Condition icon — one icon per family, so the same glyph means the same
 *  thing in the location strip and on a day row. */
function KindIcon({ kind, className }: { kind: WeatherKind; className?: string }) {
  const Icon =
    kind === "clear"
      ? Sun
      : kind === "rain"
        ? CloudRain
        : kind === "snow"
          ? CloudSnow
          : kind === "storm"
            ? CloudLightning
            : kind === "fog"
              ? CloudFog
              : kind === "cloud"
                ? Cloud
                : Thermometer;
  return <Icon className={className} aria-hidden="true" />;
}

/** Attribution line (CC BY 4.0) — rendered under every weather readout. */
function Credit() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Weather by{" "}
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

/** Full-text tooltip for a chip/pill — carries the numbers the compact
 *  layouts can't fit (label, low, snowpack). */
function readoutTitle(date: string, r: WeatherReadout): string {
  return [
    date,
    r.label,
    r.temp,
    r.precip ? `${r.precip} precipitation` : null,
    r.snow ? `${r.snow} snow` : null,
    r.base ? `${r.base} base` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Five-day conditions strip for a registry place — the location-level
 * readout (#334). Every chip carries conditions, the day's high and the
 * precipitation chance; a snowfall (or an existing snowpack) adds its own
 * token, so a powder resort and a city break both read correctly off the
 * same component. Coords come straight from the registry entry; renders
 * NOTHING without coords, while loading, or when Open-Meteo has nothing
 * (graceful absence — the place card is complete without it).
 *
 * Web-only (`no-print`): the booklet never calls a live API (#95 rule).
 */
export function WeatherStrip({
  lat,
  lng,
  onlyDate,
}: {
  lat?: number | null;
  lng?: number | null;
  /** Pin the strip to a single trip date (day view, #334) — renders only
   *  that day's chip instead of the five-day strip. Unset keeps the
   *  five-day location readout. */
  onlyDate?: string;
}) {
  const daily = useWeatherDaily(lat, lng, 5);
  if (lat == null || lng == null || !daily?.length) return null;
  const days = onlyDate ? daily.filter((d) => d.date === onlyDate) : daily;
  if (!days.length) return null;
  return (
    <div className="no-print space-y-1" aria-label="Weather forecast">
      <ul className="flex flex-wrap gap-1.5">
        {days.map((d) => {
          const r = weatherReadout(d);
          if (!r) return null;
          const snowy = r.snow != null || r.base != null;
          return (
            <li
              key={d.date}
              title={readoutTitle(d.date, r)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] tabular-nums ${
                snowy
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <span className="font-medium text-muted-foreground">{shortDay(d.date)}</span>
              <KindIcon kind={r.kind} className="h-3 w-3 shrink-0" />
              {r.temp && <span>{r.temp.split(" / ")[0]}</span>}
              {r.precip && <span className="text-muted-foreground">{r.precip}</span>}
              {r.snow && <span className="font-semibold">{r.snow}</span>}
              {r.snow == null && r.base && <span className="font-medium">{r.base} base</span>}
            </li>
          );
        })}
      </ul>
      <Credit />
    </div>
  );
}

/**
 * One-day weather pill for an itinerary row — the day-level readout (#334).
 * Resolves the day to registry coords (first located block) and renders the
 * forecast for that exact date. **Outside the forecast window it renders
 * NOTHING AT ALL** — no placeholder, no reserved box (a null child is not a
 * DOM node, so the row keeps its exact previous layout; pinned by
 * `Weather.test.tsx` / `Weather.dom.test.tsx`) — and it does not even ASK:
 * a day beyond the 16-day horizon has no forecast to fetch, so the request
 * is skipped outright (a trip planned months out makes no weather call at
 * all).
 *
 * Web-only (`no-print`), a non-interactive span so it can sit inside the day
 * row's link.
 */
export function DayWeatherPill({
  day,
  locations,
  today,
}: {
  day: Day;
  locations?: TripLocation[];
  /** Trip-local today (YYYY-MM-DD) — the caller already derives it for the
   *  today pill; falls back to the device date. */
  today?: string;
}) {
  const coords = dayCoords(day, locations);
  const todayIso = today ?? tripTodayIso({});
  const inWindow = withinForecastWindow(day?.date, todayIso);
  // Coords are withheld when the date cannot be forecast — the hook then
  // fetches nothing at all.
  const daily = useWeatherDaily(inWindow ? coords?.lat : null, inWindow ? coords?.lng : null, 7);
  if (!coords || !inWindow) return null;
  const match = dayWeather(daily, day.date);
  const r = weatherReadout(match);
  if (!r) return null;
  return (
    <span
      title={readoutTitle(day.date, r)}
      className="no-print inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
    >
      <KindIcon kind={r.kind} className={`h-3 w-3 ${r.snow ? "text-primary" : ""}`} />
      {r.snow && <span className="font-semibold text-foreground">{r.snow}</span>}
      {r.temp && <span className="text-foreground">{r.temp}</span>}
      {r.precip && <span>{r.precip}</span>}
      {/* Plain-text credit: this pill lives inside the day row's link, so a
          nested <a> would be invalid HTML — the linked credit line lives on
          the WeatherStrip. The source is still named (CC BY 4.0). */}
      <span title="Weather by Open-Meteo (https://open-meteo.com/)">· Open-Meteo</span>
    </span>
  );
}
