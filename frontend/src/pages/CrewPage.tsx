import { useTrip } from "../components/theme";
import { Badge, Card } from "../components/ui";
import type { Role } from "../lib/types";

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
  follower: "Follower",
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export function CrewPage() {
  const trip = useTrip();
  if (!trip.crew.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
        Crew not announced yet.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Crew</h1>
      {trip.crew.map((p) => (
        <Card key={p.name} className="flex items-center gap-4 p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
            {initials(p.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{p.name}</p>
              <Badge variant={p.role === "owner" ? "default" : "outline"}>
                {ROLE_LABELS[p.role]}
              </Badge>
            </div>
            {p.note && <p className="mt-0.5 text-sm text-muted-foreground">{p.note}</p>}
          </div>
        </Card>
      ))}
    </div>
  );
}
