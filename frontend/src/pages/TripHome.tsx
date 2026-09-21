import { Navigate } from "react-router-dom";
import { useTrip } from "../components/theme";
import { OverviewPage } from "./OverviewPage";
import { shouldShowToday, todayDayIdx } from "../lib/dates";

export function TripHome() {
  const trip = useTrip();
  // While live, land straight on the current day — the same day surface as
  // any other day (not a separate page). Overview stays one tap away in
  // the nav.
  if (shouldShowToday(trip)) {
    const idx = todayDayIdx(trip);
    if (idx != null) return <Navigate to={`day/${idx}`} replace />;
  }
  return <OverviewPage />;
}
