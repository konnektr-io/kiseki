import { Link } from "react-router-dom";
import { MapPin } from "lucide-react";
import { useTrip } from "../components/theme";
import { Badge } from "../components/ui";
import { formatDay } from "../lib/dates";
import type { Block } from "../lib/types";

function dayBlocksSummary(blocks: Block[]) {
  const kinds = new Set(blocks.map((b) => b.kind));
  const icons: Record<string, string> = {
    activity: "🏔️",
    transport: "🚐",
    lodging: "🛏️",
    meal: "🍽️",
    todo: "☑️",
    note: "📝",
    gallery: "📷",
    link: "🔗",
    booking: "💳",
    custom: "✨",
  };
  return [...kinds].map((k) => icons[k] ?? "•").join(" ");
}

export function ItineraryPage() {
  const trip = useTrip();
  if (!trip.days.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
        No itinerary yet — this trip is still in the {trip.stage} stage.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <h1 className="mb-4 text-2xl font-bold">Itinerary</h1>
      {trip.days.map((day, idx) => {
        const booked = day.blocks.some((b) => b.status === "booked");
        const planned = day.blocks.some((b) => b.status === "planned");
        return (
          <Link
            key={day.date}
            to={`day/${idx}`}
            className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <div className="w-20 shrink-0 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Day {idx + 1}
              </p>
              <p className="text-sm font-bold">{formatDay(day.date)}</p>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                <MapPin className="mr-1 inline h-3.5 w-3.5 text-primary" />
                {day.title || "Flex day"}
              </p>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{day.blocks.length} items</span>
                <span>{dayBlocksSummary(day.blocks)}</span>
                {booked && <Badge variant="accent">booked</Badge>}
                {planned && !booked && <Badge variant="outline">planned</Badge>}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
