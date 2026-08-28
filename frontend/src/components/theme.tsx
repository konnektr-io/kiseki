import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import type { Trip } from "../lib/types";

const TripContext = createContext<Trip | null>(null);

export function TripProvider({ trip, children }: { trip: Trip; children: ReactNode }) {
  return <TripContext.Provider value={trip}>{children}</TripContext.Provider>;
}

export function useTrip(): Trip {
  const trip = useContext(TripContext);
  if (!trip) throw new Error("useTrip must be used inside TripProvider");
  return trip;
}

/** Per-trip theme → CSS variables (--trip-*) consumed by the Tailwind tokens. */
export function tripStyle(trip: Trip): CSSProperties {
  const style: Record<string, string> = {};
  if (trip.theme?.primary) style["--trip-primary"] = trip.theme.primary;
  if (trip.theme?.accent) style["--trip-accent"] = trip.theme.accent;
  if (trip.theme?.font) style["--trip-font"] = trip.theme.font;
  return style as CSSProperties;
}
