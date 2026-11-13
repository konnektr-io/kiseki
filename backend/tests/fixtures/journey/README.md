# Route-chain goldens (#457)

`<trip>.json` is a synthetic, content-free trip document. `<trip>.expected.json`
is the **exact** payload the TypeScript implementation produced for it —
`{journey, days}` in the same shape `GET /api/trips/{id}` now serves — captured
from the code that shipped in v0.104.3, at the port's base commit
`0daa4eb`.

`backend/tests/test_journey.py` asserts the Python port reproduces these files
**byte for byte**. A mismatch is a porting bug, never a fixture update. Changing
a rule on purpose is a separate issue with its own goldens.

The fixtures are synthetic on purpose: trip content does not belong in a code
repo, and a synthetic trip can state exactly one rule. Each one reproduces a
named regression shape from the issue:

| fixture | the shape it pins |
|---|---|
| `scaffold-registry` | #91 — no re-base evidence, so the registry is the chain, marker order, every pair a gap |
| `day-trip-from-base` | #435 — a place driven to and back from on one day is an excursion, never a chain stop |
| `revisited-base` | #433 — a base the trip returns to is two visits, and the return leg's own direction beats an earlier reversed block |
| `gateway-flight` | #361 — the chain nodes are cities, the flight block names airports ~17 km away |
| `iata-title-shorthand` | #435/#438 — `MCY → CCY` in a day title is shorthand, not two same-day stays |
| `shared-day-hub` | #454 + #438 — a shared day is ordered by its movements (the registry lists them the wrong way), and a pass-through is a chain node |
| `alias-nested-name` | a "Sapporo" alias must not claim "Sapporo Kokusai" (nested-hit rule) |

## How these were captured

The oracle was the real implementation, not a reading of it. At `0daa4eb`, in a
throwaway worktree with `node_modules` hardlinked from the main clone:

```ts
// frontend/src/parity/__probe457.test.ts  (throwaway — not committed)
import { tripJourney, placeRailHandle } from "../lib/route-surface";
import { daySurface } from "../lib/day-surface";
import { classifyTransportMode } from "../lib/transport";

const j = tripJourney(trip);
const journey = {
  stops: j.stops.map((l) => l.name),
  chain: j.chain.map((l) => l.name),
  visits: j.visits.map((v) => ({ place: v.place.name, days: v.days })),
  legs: j.legs.map((l) => ({
    from: l.from.name,
    to: l.to.name,
    stage: l.stage,
    mode: l.block ? classifyTransportMode(l.block) ?? null : null,
    gap: !l.block,
    blockId: l.block?.id ?? null,
  })),
  loop: j.loop,
  excursions: j.excursions.map((l) => l.name),
  rail: /* placeRailHandle per located place, nulls dropped */ {},
};
const days = (trip.days ?? []).map((_, i) => {
  const s = daySurface(trip, i);
  return s && {
    markers: s.markers.map((m) =>
      m.role === "place"
        ? { role: "place", place: m.place.name }
        : { role: "activity", place: m.place.name, letter: m.letter, blockIds: m.blockIds },
    ),
    legs: s.legs.map((l) => ({
      from: l.from.name, to: l.to.name, blockId: l.block.id, stage: l.stage, mode: l.mode ?? null,
    })),
    endpoints: s.endpoints.map((l) => l.name),
    tracks: s.tracks,
  };
});
fs.writeFileSync(out, JSON.stringify({ journey, days }));
```

The same harness was run over **all twelve** live trips (Canada 2027, Chile
2027, Chile+Peru, Peru 2027, Japow 2026/2028, Costa Rica 2023, Georgia 2028,
Burning Man 2027, Albany, Urban Legends, Little Switzerland) and the port was
byte-identical on every one — that run is what proved the rules, this fixture
set is what keeps proving them in CI without the content.

To re-capture after a deliberate rule change: check out the commit whose
behaviour you are pinning, run the probe above over these fixture documents,
and commit the result together with the spec change.
