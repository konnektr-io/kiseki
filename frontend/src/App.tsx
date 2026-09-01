import { Navigate, Route, Routes } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";
import { JoinPage } from "./pages/JoinPage";
import { TripLayout } from "./pages/TripLayout";
import { TripHome } from "./pages/TripHome";
import { TodayPage } from "./pages/TodayPage";
import { ItineraryPage } from "./pages/ItineraryPage";
import { SectionPage } from "./pages/SectionPage";
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
        <Route index element={<TripHome />} />
        <Route path="today" element={<TodayPage />} />
        <Route path="itinerary" element={<ItineraryPage />} />
        <Route path="s/:n" element={<SectionPage />} />
        <Route path="day/:idx" element={<DayPage />} />
        <Route path="practical" element={<PracticalsPage />} />
        <Route path="crew" element={<CrewPage />} />
        <Route path="booklet" element={<BookletPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
