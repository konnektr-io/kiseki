import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import type { Trip } from "../lib/types";

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

/** Per-trip theme → CSS variables (--trip-*) consumed by the Tailwind tokens. */
export function tripStyle(trip: Trip): CSSProperties {
  const style: Record<string, string> = {};
  if (trip.theme?.primary) style["--trip-primary"] = trip.theme.primary;
  if (trip.theme?.accent) style["--trip-accent"] = trip.theme.accent;
  if (trip.theme?.font) style["--trip-font"] = trip.theme.font;
  return style as CSSProperties;
}
