import { ExternalLink } from "lucide-react";
import { gmapsSearchUrl } from "../lib/gmaps";
import { Markdown } from "../lib/markdown";
import type { TripLocation } from "../lib/types";

/** Whether a registry place carries any metadata worth rendering — the
 *  Location metadata the v0.23.12 model carries (placeId / address / website /
 *  types / summary). Absence (a bare name+coords place) renders nothing. */
export function placeHasFacts(place: TripLocation): boolean {
  return !!(
    place.placeId ||
    place.address ||
    place.website ||
    (place.types && place.types.length > 0) ||
    place.summary
  );
}

/** Hostname for the website chip-button — never a raw URL on screen. */
export function websiteHostname(website: string): string {
  try {
    return new URL(website).hostname;
  } catch {
    return website;
  }
}

/**
 * Place-metadata facts for a registry place — registry-shared location
 * content renders first (above the block's own user-editable prose, which
 * lives in the card body): the user actions first (the Google Maps link, a
 * place_id deep link when present, name search otherwise — plus the website
 * as a hostname chip-button, never raw URL text), then the facts
 * (address / types), then the agent-authored summary last. Every row except
 * the Maps link renders only when its field is set — absence IS the empty
 * state, and a place with no metadata at all renders nothing.
 *
 * Web-only (`no-print`): the booklet keeps its own prose — BookletPage renders
 * through the same BlockView, so without the wrapper the facts row would
 * change existing print output. The tree stays auth-agnostic (no role
 * branching — pitfall 16).
 */
export function PlaceFacts({ place }: { place: TripLocation }) {
  if (!placeHasFacts(place)) return null;
  return (
    <div className="no-print mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <a
          href={gmapsSearchUrl(place.name, { placeId: place.placeId })}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:focus-ring"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Open in Google Maps
        </a>
        {place.website && (
          <a
            href={place.website}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:focus-ring"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {websiteHostname(place.website)}
          </a>
        )}
      </div>
      {place.address && <p className="text-sm text-muted-foreground">{place.address}</p>}
      {place.types && place.types.length > 0 && (
        <ul aria-label="Place types" className="flex flex-wrap gap-1">
          {place.types.map((t) => (
            <li
              key={t}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t}
            </li>
          ))}
        </ul>
      )}
      {place.summary && (
        <div className="text-sm leading-relaxed text-muted-foreground">
          <Markdown>{place.summary}</Markdown>
        </div>
      )}
    </div>
  );
}
