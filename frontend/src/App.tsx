import { Navigate, Route, Routes } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";
import { JoinPage } from "./pages/JoinPage";
import { TripLayout } from "./pages/TripLayout";
import { OverviewPage } from "./pages/OverviewPage";
import { ItineraryPage } from "./pages/ItineraryPage";
import { DayPage } from "./pages/DayPage";
import { PracticalsPage } from "./pages/PracticalsPage";
import { CrewPage } from "./pages/CrewPage";
import { BookletPage } from "./pages/BookletPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/join/:claimToken" element={<JoinPage />} />
      <Route path="/t/:token" element={<TripLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="itinerary" element={<ItineraryPage />} />
        <Route path="day/:idx" element={<DayPage />} />
        <Route path="practical" element={<PracticalsPage />} />
        <Route path="crew" element={<CrewPage />} />
        <Route path="booklet" element={<BookletPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
