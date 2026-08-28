import type { Trip } from "./types";

export async function fetchTrip(token: string): Promise<Trip> {
  const res = await fetch(`/api/trips/${encodeURIComponent(token)}`);
  if (!res.ok) {
    throw new Error(res.status === 404 ? "Trip not found" : "Failed to load trip");
  }
  return (await res.json()) as Trip;
}

export const bookletUrl = (token: string) => `/api/trips/${encodeURIComponent(token)}/booklet.pdf`;
