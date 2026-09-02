import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";
import { JoinPage } from "./pages/JoinPage";
import { TripLayout } from "./pages/TripLayout";
import { TripHome } from "./pages/TripHome";
import { TodayPage } from "./pages/TodayPage";
import { ItineraryPage } from "./pages/ItineraryPage";
import { DayPage } from "./pages/DayPage";
import { PracticalsPage } from "./pages/PracticalsPage";
import { CrewPage } from "./pages/CrewPage";
import { BookletPage } from "./pages/BookletPage";
import { useTrip } from "./components/theme";

/** /s/<n> was a real page in v0.13.0; DESIGN.md §7.5 corrected it to a
 *  chapter ANCHOR inside the itinerary (sections are a grouping, not a level).
 *  Keep the route as a redirect (replace — no history pollution): links have
 *  been shared, and the map work (§2.2) wants a stable per-section target.
 *  The index is clamped against the trip's sections so a stale link still
 *  lands on a real chapter. */
function SectionRedirect() {
  const { tripId = "", n = "0" } = useParams();
  const trip = useTrip();
  const count = trip.sections?.length ?? 0;
  const si = count > 0 ? Math.min(Math.max(parseInt(n, 10) || 0, 0), count - 1) : -1;
  const hash = si >= 0 ? `#s-${si}` : "";
  return <Navigate to={`/t/${tripId}/itinerary${hash}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/join/:claimToken" element={<JoinPage />} />
      <Route path="/t/:tripId" element={<TripLayout />}>
        <Route index element={<TripHome />} />
        <Route path="today" element={<TodayPage />} />
        <Route path="itinerary" element={<ItineraryPage />} />
        <Route path="s/:n" element={<SectionRedirect />} />
        <Route path="day/:idx" element={<DayPage />} />
        <Route path="practical" element={<PracticalsPage />} />
        <Route path="crew" element={<CrewPage />} />
        <Route path="booklet" element={<BookletPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
