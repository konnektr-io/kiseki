import { Link } from "react-router-dom";
import { ArrowRight, MapPin, X } from "lucide-react";
import type { Stage } from "../lib/types";
import { Floating, StageBadge } from "./ui";

/** The minimum the pin preview needs — band data when present, geo otherwise. */
export interface PinCardTrip {
  dtId: string;
  title: string;
  stage: Stage;
  cover?: string | null;
  anchorName?: string | null;
}

/**
 * The trip preview a home-map pin opens (#249, slice 5).
 *
 * The same card language as the bands, condensed: photography-led, the trip's
 * own stage badge, the anchor place, one explicit way in. It previews — it
 * never navigates on its own. Floating recipe throughout (§2.4), `no-print`
 * chrome (the home is not a document surface).
 */
export function TripPinCard({ trip, onClose }: { trip: PinCardTrip; onClose: () => void }) {
  return (
    <Floating
      role="dialog"
      aria-label={`${trip.title} — trip preview`}
      className="no-print overflow-hidden rounded-xl"
    >
      <div className="flex items-center gap-3 p-3">
        {trip.cover ? (
          <img
            src={trip.cover}
            alt=""
            loading="lazy"
            className="h-16 w-16 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-muted">
            <MapPin className="h-6 w-6 text-muted-foreground/60" strokeWidth={1.5} aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <StageBadge stage={trip.stage} />
          <p className="font-heading mt-1 truncate text-base font-semibold tracking-wide">
            {trip.title}
          </p>
          {trip.anchorName && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{trip.anchorName}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close trip preview"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:focus-ring"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <Link
        to={`/t/${trip.dtId}`}
        className="flex items-center justify-center gap-1.5 border-t border-border/60 px-3 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted/50 focus-visible:focus-ring"
      >
        Open trip
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </Floating>
  );
}
