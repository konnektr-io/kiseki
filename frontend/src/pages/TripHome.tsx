import { Navigate } from "react-router-dom";
import { useTrip } from "../components/theme";
import { OverviewPage } from "./OverviewPage";
import { shouldShowToday, todayDayIdx } from "../lib/dates";

export function TripHome() {
  const trip = useTrip();
  // While live, land straight on the today view — the current day on the day
  // surface with top-level chrome. Overview stays one tap away in the nav.
  // The resolvability check matters: without it a live trip with no day to
  // open would bounce between the index and /today forever (/today falls
  // back here when it cannot resolve).
  if (shouldShowToday(trip) && todayDayIdx(trip) != null) {
    return <Navigate to="today" replace />;
  }
  return <OverviewPage />;
}
