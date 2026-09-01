import { Navigate } from "react-router-dom";
import { useTrip } from "../components/theme";
import { OverviewPage } from "./OverviewPage";
import { shouldShowToday } from "../lib/dates";

export function TripHome() {
  const trip = useTrip();
  if (shouldShowToday(trip)) return <Navigate to="today" replace />;
  return <OverviewPage />;
}
