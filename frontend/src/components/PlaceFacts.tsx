import { ChevronDown, ExternalLink, Star, StarHalf } from "lucide-react";
import { gmapsSearchUrl } from "../lib/gmaps";
import { Markdown } from "../lib/markdown";
import { placePhotoUrl, usePlaceLive, type PlaceLiveDetails, type PlaceLiveReview } from "../lib/place-live";
import { WeatherStrip } from "./Weather";
import type { TripLocation } from "../lib/types";

/** Whether a registry place carries any metadata worth rendering — the
 *  Location metadata the v0.23.12 model carries (placeId / address / website /
 *  types / summary / photo). Absence (a bare name+coords place) renders
 *  nothing. Live Google overlay content (#95) is deliberately NOT part of
 *  this check: it is fetched client-side and can never light up a place with
 *  no static facts and no place_id. */
export function placeHasFacts(place: TripLocation): boolean {
  return !!(
    place.placeId ||
    place.address ||
    place.website ||
    (place.types && place.types.length > 0) ||
    place.summary ||
    place.photo
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

/** True when two URLs point at the same site (host, ignoring www.). */
function sameSite(a: string, b: string): boolean {
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    }
  };
  return host(a) === host(b);
}

/** Five-star row (lucide), quarter-point rounded to full/half/empty. */
export function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`Rated ${rating} out of 5`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const filled = rating - i;
        return filled >= 0.75 ? (
          <Star key={i} className="h-3.5 w-3.5 fill-accent text-accent" aria-hidden="true" />
        ) : filled >= 0.25 ? (
          <StarHalf key={i} className="h-3.5 w-3.5 fill-accent text-accent" aria-hidden="true" />
        ) : (
          <Star key={i} className="h-3.5 w-3.5 text-muted-foreground/40" aria-hidden="true" />
        );
      })}
    </span>
  );
}

/** Stored rights-clean photo — print-ELIGIBLE by deliberate decision (#95):
 *  own/rights-cleared imagery survives in the booklet; Google imagery never
 *  does. Renders nothing without a photo; credit line only when present. */
function StoredPhoto({ place }: { place: TripLocation }) {
  if (!place.photo) return null;
  return (
    <figure className="overflow-hidden rounded-lg border border-border">
      <img src={place.photo} alt={place.name} loading="lazy" className="h-40 w-full object-cover" />
      {(place.photoCredit || place.photoLicense || place.photoSourceUrl) && (
        <figcaption className="bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
          {place.photoCredit}
          {place.photoLicense ? ` · ${place.photoLicense}` : ""}
          {place.photoSourceUrl && (
            <>
              {" · "}
              <a
                href={place.photoSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline focus-visible:focus-ring"
              >
                source
              </a>
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
}

/** Live Google photo — only when the place has no stored image (stored wins:
 *  fast, print-eligible, rights-clean). Web-only (inside the no-print
 *  region), served through the keyless backend proxy, Google attribution
 *  line underneath. */
function LivePhoto({ place, live }: { place: TripLocation; live: PlaceLiveDetails }) {
  const ref = live.photos?.find((p) => p.name)?.name;
  if (!ref) return null;
  const author = live.photos?.find((p) => p.name)?.authorAttributions?.[0]?.displayName;
  return (
    <figure className="overflow-hidden rounded-lg border border-border">
      <img
        src={placePhotoUrl(ref)}
        alt={place.name}
        loading="lazy"
        className="h-36 w-full object-cover"
      />
      <figcaption className="bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
        {author ? `Photo: ${author}` : "Photo"} via{" "}
        {live.googleMapsUri ? (
          <a
            href={live.googleMapsUri}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline focus-visible:focus-ring"
          >
            Google Maps
          </a>
        ) : (
          "Google Maps"
        )}
      </figcaption>
    </figure>
  );
}

/** Disclosure label for the collapsed snippet set ("Show 3 reviews from
 *  Google") — ONE string, so the count and its plural never render as two
 *  separate text nodes (#286). */
function reviewsSummaryLabel(count: number): string {
  const n = Math.min(count, 3);
  return `Show ${n} review${n > 1 ? "s" : ""} from Google`;
}

/** One review snippet — the inline, collapsed and expanded variants share this
 *  so the wording/attribution can't drift between them. Renders nothing for a
 *  review that carries neither text nor an author. */
function ReviewSnippet({ review, clamp = false }: { review: PlaceLiveReview; clamp?: boolean }) {
  const r = review;
  if (!r.text && !r.authorName) return null;
  return (
    <li className="text-sm leading-relaxed text-muted-foreground">
      {r.text && (
        <span className={clamp ? "italic line-clamp-2" : "italic"}>“{r.text}”</span>
      )}
      {r.authorName && (
        <>
          {r.text ? " — " : ""}
          {r.googleMapsUri || r.authorUri ? (
            <a
              href={r.googleMapsUri || r.authorUri}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline focus-visible:focus-ring"
            >
              {r.authorName}
            </a>
          ) : (
            <span>{r.authorName}</span>
          )}
        </>
      )}
      {r.relativePublishTimeDescription ? ` · ${r.relativePublishTimeDescription}` : ""}
    </li>
  );
}

/**
 * Place-metadata facts for a registry place — registry-shared location
 * content renders first (above the block's own user-editable prose, which
 * lives in the card body): the stored rights-clean photo (print-eligible),
 * then the user actions (the Google Maps link, a place_id deep link when
 * present, name search otherwise — plus the website as a hostname pill, but
 * only when no block link already points at the same site, #135), then the
 * facts (address / types), the LIVE Google overlay (rating / review snippets
 * / photo — web-only, #95), then the agent-authored summary last. Every row
 * except the Maps link renders only when its data is present — absence IS
 * the empty state, and a place with no metadata at all renders nothing.
 *
 * Web-only (`no-print`): everything Google-derived (chips row, live overlay,
 * summary) sits inside the no-print region — the booklet keeps its own prose
 * and ONLY gains the stored rights-clean photo (deliberate #95 decision).
 * The tree stays auth-agnostic (no role branching — pitfall 16).
 *
 * `reviewsQuiet` (#286/#289): the caller's block is DONE, i.e. this day already
 * happened. The live Google overlay reads as a *choosing* aid (what should we
 * do here?), so on a finished activity it is noise next to the traveller's own
 * words and photos: the star icons go entirely, the rating survives as one
 * quiet text line (its "N reviews on Google" link keeps the route out), the
 * whole snippet set collapses behind one disclosure line, and the Google photo
 * stays unrendered. Planning blocks (`planned` / `booked` / no status) render
 * exactly as before.
 */
export function PlaceFacts({
  place,
  blockLinks,
  reviewsQuiet = false,
  showWeather = false,
}: {
  place: TripLocation;
  blockLinks?: { label: string; url: string }[];
  /** Collapse the review snippets — set for a `done` block. */
  reviewsQuiet?: boolean;
  /** Render the live weather strip (#334) — the caller sets this only when a
   *  forecast can actually cover the trip (`tripInForecastWindow`), so a trip
   *  months out never spends a request or a pixel on it. */
  showWeather?: boolean;
}) {
  const live = usePlaceLive(place.placeId);
  const hasLive = !!live && (live.rating != null || (live.reviews?.length ?? 0) > 0 || !!live.photos?.some((p) => p.name));
  // Weather strip (#334) needs only coords — unlike the Google overlay it MAY
  // light up a place with no static facts (a resort mapped but not yet
  // enriched is exactly the ski case). It renders null while loading or
  // absent, so returning it directly adds no wrapper margin either way.
  const weather =
    showWeather && place.lat != null && place.lng != null ? (
      <WeatherStrip lat={place.lat} lng={place.lng} />
    ) : null;
  if (!placeHasFacts(place) && !hasLive) return weather;
  // A block link pointing at the same site as the registry's website makes
  // the facts Website chip redundant — the bottom links row already has it.
  const hasWebsiteLink = !!place.website && (blockLinks ?? []).some((l) => sameSite(l.url, place.website!));
  // Print parity: without a stored photo the whole region stays no-print
  // (byte-identical booklet — an empty wrapper would still add margin);
  // with one, the photo prints and the Google-derived rows stay hidden.
  return (
    <div className={`${place.photo ? "" : "no-print "}mt-2 space-y-1.5`}>
      <StoredPhoto place={place} />
      <div className="no-print space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          <a
            href={gmapsSearchUrl(place.name, { placeId: place.placeId })}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-muted"
          >
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            Open in Google Maps
          </a>
          {place.website && !hasWebsiteLink && (
            <a
              href={place.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-muted"
            >
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
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
        {showWeather && place.lat != null && place.lng != null && (
          <WeatherStrip lat={place.lat} lng={place.lng} />
        )}
        {live?.rating != null && !reviewsQuiet && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <Stars rating={live.rating} />
            <span className="font-medium tabular-nums text-foreground">{live.rating.toFixed(1)}</span>
            {live.userRatingCount != null && live.googleMapsUri ? (
              <a
                href={live.googleMapsUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground hover:underline focus-visible:focus-ring"
              >
                · View {live.userRatingCount.toLocaleString("en-US")} reviews on Google
              </a>
            ) : live.userRatingCount != null ? (
              <span className="text-muted-foreground">
                · {live.userRatingCount.toLocaleString("en-US")} reviews
              </span>
            ) : live.googleMapsUri ? (
              <a
                href={live.googleMapsUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground hover:underline focus-visible:focus-ring"
              >
                · View on Google
              </a>
            ) : null}
          </div>
        )}
        {live?.rating != null && reviewsQuiet && (
          /* DONE block (#289): the star icons read as chrome next to the
             traveller's own words and photos — the rating survives as one
             quiet text line, and the link keeps the route out to Google. */
          <div className="text-[12px] text-muted-foreground">
            <span className="font-medium tabular-nums">{live.rating.toFixed(1)}</span>
            {live.userRatingCount != null && live.googleMapsUri ? (
              <>
                {" · "}
                <a
                  href={live.googleMapsUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground hover:underline focus-visible:focus-ring"
                >
                  View {live.userRatingCount.toLocaleString("en-US")} reviews on Google
                </a>
              </>
            ) : live.userRatingCount != null ? (
              <span> · {live.userRatingCount.toLocaleString("en-US")} reviews</span>
            ) : live.googleMapsUri ? (
              <>
                {" · "}
                <a
                  href={live.googleMapsUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground hover:underline focus-visible:focus-ring"
                >
                  View on Google
                </a>
              </>
            ) : null}
          </div>
        )}
        {!!live?.reviews?.length && reviewsQuiet && (
          /* DONE block (#286/#289): a snippet set is a *choosing* aid, not a
             record — a finished day collapses it behind one line. The quiet
             rating line above keeps the "N reviews on Google" route out for
             anyone who wants them. */
          <details className="group">
            <summary className="cursor-pointer list-none text-[12px] text-muted-foreground hover:text-foreground focus-visible:focus-ring [&::marker]:hidden">
              {reviewsSummaryLabel(live.reviews.length)}
              <ChevronDown className="ml-1 inline h-3 w-3 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <ul aria-label="Review snippets" className="mt-1 space-y-1">
              {live.reviews.slice(0, 3).map((r, i) => (
                <ReviewSnippet key={i} review={r} />
              ))}
            </ul>
          </details>
        )}
        {!!live?.reviews?.length && !reviewsQuiet && (
          <div>
            {/* First snippet inline, clamped — long reviews stay 2 lines. */}
            <ul aria-label="Review snippets">
              {live.reviews.slice(0, 1).map((r, i) => (
                <ReviewSnippet key={i} review={r} clamp />
              ))}
            </ul>
            {live.reviews.length > 1 && (
              <details className="group">
                <summary className="cursor-pointer list-none text-[12px] text-muted-foreground hover:text-foreground focus-visible:focus-ring [&::marker]:hidden">
                  Show {Math.min(live.reviews.length, 3) - 1} more review
                  {Math.min(live.reviews.length, 3) > 2 ? "s" : ""} from Google
                  <ChevronDown className="ml-1 inline h-3 w-3 transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <ul className="mt-1 space-y-1">
                  {live.reviews.slice(1, 3).map((r, i) => (
                    <ReviewSnippet key={i} review={r} />
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {live && !place.photo && !reviewsQuiet && <LivePhoto place={place} live={live} />}
        {place.summary && (
          <div className="text-sm leading-relaxed text-muted-foreground">
            <Markdown>{place.summary}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
