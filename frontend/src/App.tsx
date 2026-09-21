import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";
import { JoinPage } from "./pages/JoinPage";
import { MePage, ProfilePage } from "./pages/ProfilePage";
import { TripLayout } from "./pages/TripLayout";
import { TripHome } from "./pages/TripHome";
import { TodayRedirect } from "./pages/TodayRedirect";
import { TripMapSurface } from "./pages/TripMapSurface";
import { PracticalsPage } from "./pages/PracticalsPage";
import { CrewPage } from "./pages/CrewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BookletPage } from "./pages/BookletPage";
import { FeedPage } from "./pages/FeedPage";
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

/** /map was the standalone route surface (#39) — retired by #93: the
 *  Itinerary/Day pair IS the map surface now (DESIGN.md §7.6), so the old URL
 *  redirects (replace) to the itinerary scan level. */
function MapRedirect() {
  const { tripId = "" } = useParams();
  return <Navigate to={`/t/${tripId}/itinerary`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/join/:claimToken" element={<JoinPage />} />
      {/* User profiles (#196d): /u/:sub is anyone's profile, /me the
          signed-in user's own (with the ensure step + publicName control). */}
      <Route path="/u/:sub" element={<ProfilePage />} />
      <Route path="/me" element={<MePage />} />
      <Route path="/feed" element={<FeedPage />} />
      <Route path="/t/:tripId" element={<TripLayout />}>
        <Route index element={<TripHome />} />
        {/* Retired page, kept as a redirect (replace — no history pollution):
            /today used to be its own surface; now it resolves to the current
            day page, the same surface as any other day. Shared/bookmarked
            /today links keep landing on today. */}
        <Route path="today" element={<TodayRedirect />} />
        {/* ONE persistent map surface (DESIGN.md §7.6): the itinerary is the
            scan level (#92) and /day/<idx> the day level (#90). Both render
            TripMapSurface — level is derived from the URL, the map instance
            stays alive between them. */}
        <Route path="itinerary" element={<TripMapSurface />} />
        <Route path="day/:idx" element={<TripMapSurface />} />
        <Route path="map" element={<MapRedirect />} />
        <Route path="s/:n" element={<SectionRedirect />} />
        <Route path="practical" element={<PracticalsPage />} />
        <Route path="crew" element={<CrewPage />} />
        {/* Trip settings (#248) — the trip-level actions re-homed out of the
            header's overflow menu. A child of /t/:tripId, so the shared
            AppHeader + bottom nav stay, and the history-mode whitelist in
            the backend already covers it (`is_spa_route` matches `t/`). */}
        <Route path="settings" element={<SettingsPage />} />
        <Route path="booklet" element={<BookletPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
