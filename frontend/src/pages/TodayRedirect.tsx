import { Navigate, useParams } from "react-router-dom";
import { useTrip } from "../components/theme";
import { todayDayIdx } from "../lib/dates";

/**
 * /today is a redirect, not a page: it resolves to the current day page
 * (`day/<idx>` — the same surface as any other day). Kept so shared and
 * bookmarked /today links keep landing on today. Anything without a day to
 * open (before / after / dateless / section-without-days) falls back to the
 * trip root (the overview).
 */
export function TodayRedirect() {
  const trip = useTrip();
  const { tripId = "" } = useParams();
  const idx = todayDayIdx(trip);
  if (idx != null) return <Navigate to={`/t/${tripId}/day/${idx}`} replace />;
  return <Navigate to={`/t/${tripId}`} replace />;
}
