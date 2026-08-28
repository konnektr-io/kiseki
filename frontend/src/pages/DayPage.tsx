import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Map } from "lucide-react";
import { useTrip } from "../components/theme";
import { DayBlocks, MetaChips } from "../components/blocks";
import { Markdown } from "../lib/markdown";
import { formatDay } from "../lib/dates";

type Dir = "prev" | "next" | null;

export function DayPage() {
  const trip = useTrip();
  const { idx } = useParams();
  const i = Math.min(Math.max(parseInt(idx ?? "0", 10) || 0, 0), trip.days.length - 1);
  const day = trip.days[i];
  const navigate = useNavigate();
  const touchX = useRef<number | null>(null);
  const [dir, setDir] = useState<Dir>(null);
  const [animKey, setAnimKey] = useState(i);
  if (!day) return <p className="py-10 text-center text-sm text-muted-foreground">Day not found.</p>;

  const prev = i > 0 ? i - 1 : null;
  const next = i < trip.days.length - 1 ? i + 1 : null;

  const go = (target: number | null, d: Dir) => {
    if (target == null || target === i) return;
    setDir(d);
    setAnimKey(target);
    navigate(`/t/${trip.token}/day/${target}`);
    window.scrollTo(0, 0);
  };

  const dayNavBtn = (target: number | null, d: "prev" | "next", label: string) => {
    if (target == null) return <span className="flex-1" />;
    return (
      <button
        onClick={() => go(target, d)}
        className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-left hover:bg-muted md:px-3"
      >
        {d === "prev" ? <ArrowLeft className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium leading-tight">{label}</span>
          <span className="block whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground">
            Day {target + 1} · {formatDay(trip.days[target].date).replace(",", "")}
          </span>
        </span>
        {d === "next" ? <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
      </button>
    );
  };

  return (
    <div
      className="space-y-5 pb-20"
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (Math.abs(dx) > 60) go(dx < 0 ? next : prev, dx < 0 ? "next" : "prev");
        touchX.current = null;
      }}
    >
      <div key={animKey} className={`space-y-5 ${dir === "prev" ? "animate-day-prev" : dir === "next" ? "animate-day-next" : ""}`}>
        <div>
          <p className="kicker">
            Day {i + 1} of {trip.days.length} · {formatDay(day.date)}
          </p>
          <h2 className="mt-1 font-display text-4xl uppercase leading-none text-foreground">
            {day.title || formatDay(day.date)}
          </h2>
          <div className="mt-3">
            <MetaChips meta={day.meta} />
          </div>
        </div>

        {day.notes && (
          <div className="rounded-xl border border-border bg-muted/40 p-4">
            <p className="kicker mb-1.5">Notes</p>
            <div className="text-sm leading-relaxed text-muted-foreground">
              <Markdown>{day.notes}</Markdown>
            </div>
          </div>
        )}

        <DayBlocks blocks={day.blocks} />
      </div>

      {/* sticky day navigation — always visible, same place */}
      <div className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-1.5 px-3 py-2.5 md:gap-2 md:px-4">
          {dayNavBtn(prev, "prev", trip.days[prev ?? i]?.title ?? "")}
          <Link
            to={`/t/${trip.token}/itinerary`}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            <Map className="h-4 w-4" /> <span className="hidden sm:inline">Itinerary</span>
          </Link>
          {dayNavBtn(next, "next", trip.days[next ?? i]?.title ?? "")}
        </div>
      </div>
    </div>
  );
}
