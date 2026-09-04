import { Globe, Lock } from "lucide-react";
import { useTripState } from "./theme";
import { useTripWrite } from "../lib/useTripWrite";
import { putTrip } from "../lib/api";
import {
  roleAtLeast,
  stageOptions,
  STAGES,
  withTripStage,
  withTripVisibility,
} from "../lib/editing";
import type { Stage, Visibility } from "../lib/types";

const controlCls =
  "h-8 rounded-md border border-border bg-card px-2 text-xs font-medium text-foreground transition-colors focus-visible:focus-ring disabled:opacity-50";

/**
 * Trip-level write controls (issue #46, milestone C): stage transitions for
 * `editor+` and the public/private visibility switch for the `owner`. The
 * server enforces both — this only gates what is offered. Rendered in the
 * TripLayout header on a slim strip that only exists for editors, so
 * viewers/followers/anonymous see zero change.
 */
export function TripControls() {
  const { trip } = useTripState();
  const isOwner = trip.myRole === "owner";
  const canEdit = roleAtLeast(trip.myRole, "editor");
  const { busy, error, run } = useTripWrite();

  if (!canEdit) return null;

  const changeStage = (stage: Stage) => {
    void run((token) => putTrip(trip.id, { stage }, token), (t) => withTripStage(t, stage));
  };
  const changeVisibility = (visibility: Visibility) => {
    void run(
      (token) => putTrip(trip.id, { visibility }, token),
      (t) => withTripVisibility(t, visibility),
    );
  };

  const options = stageOptions(trip.stage, trip.myRole);
  const seg = (active: boolean) =>
    `inline-flex h-8 items-center gap-1 px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${
      active ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"
    }`;

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      role="group"
      aria-label="Trip settings"
    >
      {options.length > 0 && (
        <label className="flex items-center gap-1.5">
          Stage
          <select
            value={trip.stage}
            disabled={busy}
            onChange={(e) => changeStage(e.target.value as Stage)}
            className={controlCls}
            aria-label="Change trip stage"
          >
            <option value={trip.stage} disabled>
              {trip.stage}
            </option>
            {options.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
      {isOwner && (
        <div className="flex items-center gap-1.5">
          Sharing
          <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Trip visibility">
            <button
              type="button"
              disabled={busy}
              onClick={() => changeVisibility("public")}
              aria-pressed={trip.visibility === "public"}
              className={seg(trip.visibility === "public")}
            >
              <Globe className="h-3.5 w-3.5" aria-hidden /> Public
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => changeVisibility("private")}
              aria-pressed={trip.visibility === "private"}
              className={seg(trip.visibility === "private")}
            >
              <Lock className="h-3.5 w-3.5" aria-hidden /> Private
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs font-medium normal-case text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export { STAGES };
