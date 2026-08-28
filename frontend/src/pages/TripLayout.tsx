import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useParams } from "react-router-dom";
import { CalendarDays, FileDown, Home, ListChecks, Map } from "lucide-react";
import { fetchTrip, bookletUrl } from "../lib/api";
import { formatDate, dayCount } from "../lib/dates";
import type { Trip } from "../lib/types";
import { TripProvider, tripStyle } from "../components/theme";
import { StageBadge } from "../components/ui";

const NAV = [
  { to: "", label: "Overview", icon: Home, end: true },
  { to: "itinerary", label: "Itinerary", icon: Map },
  { to: "practical", label: "Practical", icon: ListChecks },
];

function NavLinks({ token }: { token: string }) {
  const { pathname } = useLocation();
  const base = `/t/${token}`;
  const active = (to: string, end?: boolean) =>
    end ? pathname === base : pathname === `${base}/${to}` || (to === "itinerary" && pathname.startsWith(`${base}/day`));
  return (
    <nav className="flex items-center gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <Link
          key={to}
          to={to}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            active(to, end) ? "bg-primary text-primary-foreground" : "hover:bg-muted"
          }`}
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function TripLayout() {
  const { token = "" } = useParams();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrip(null);
    setError(null);
    fetchTrip(token)
      .then((t) => {
        if (!cancelled) setTrip(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load trip");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-2xl font-bold">Kiseki</h1>
        <p className="text-muted-foreground">{error}</p>
        <p className="text-sm text-muted-foreground">
          Check the link you were given — trip links are private.
        </p>
        <Link to="/" className="text-sm font-medium underline underline-offset-2">
          Home
        </Link>
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-muted-foreground">Loading trip…</p>
      </div>
    );
  }

  const days = dayCount(trip.startDate, trip.endDate);
  const { pathname } = useLocation();
  const onDayPage = pathname.includes(`/t/${trip.token}/day/`);

  return (
    <TripProvider trip={trip}>
      <div style={tripStyle(trip)} className="min-h-full">
        {/* Header */}
        <header className="no-print sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-lg font-bold leading-tight">{trip.title}</h1>
                <StageBadge stage={trip.stage} />
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarDays className="h-3 w-3" />
                {trip.startDate && trip.endDate
                  ? `${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}${days ? ` · ${days} days` : ""}`
                  : "Dates TBD"}
              </p>
            </div>
            <a
              href={bookletUrl(trip.token)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              <FileDown className="h-4 w-4" />
              <span className="hidden sm:inline">PDF</span>
            </a>
          </div>
          {/* Desktop nav */}
          <div className="mx-auto hidden max-w-3xl px-4 pb-2 md:block">
            <NavLinks token={trip.token} />
          </div>
        </header>

        {/* Content */}
        <main className="mx-auto max-w-3xl px-4 py-5 pb-24 md:pb-10">
          <Outlet />
        </main>

        {/* Mobile bottom nav (hidden on day pages — DayPage has its own bar) */}
        {!onDayPage && (
          <nav className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur md:hidden">
            <div className="grid grid-cols-3">
              {NAV.map(({ to, label, icon: Icon, end }) => {
                const isActive = end
                  ? pathname === `/t/${trip.token}`
                  : pathname === `/t/${trip.token}/${to}` ||
                    (to === "itinerary" && pathname.startsWith(`/t/${trip.token}/day`));
                return (
                  <Link
                    key={to}
                    to={to}
                    className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
                      isActive ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </Link>
                );
              })}
            </div>
          </nav>
        )}
      </div>
    </TripProvider>
  );
}
