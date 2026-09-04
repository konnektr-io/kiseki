# Kiseki graph models (DTDL v4)

The graph data structure that backs the Kiseki trip document once it moves from
`trip.json` (P0) to **Konnektr Graph** (P1, issue #4). DTDL-driven, same pattern
as the Arcadis digital twins: *content lives in string fields (markdown/HTML),
structure is typed, relationships are graph edges* (docs/spec.md §6).

## Single source of truth

`backend/app/models.py` (the Pydantic `Trip` document model) is authoritative.
The DTDL models are **auto-generated** from it — run the generator, never hand-edit
the output:

```bash
cd backend
uv run python scripts/gen_dtdl.py            # writes dtdl/kiseki-models.json
uv run python scripts/gen_dtdl.py --check    # CI: fail if output drifted
uv run python scripts/validate_dtdl.py       # structural DTDL v4 check
```

The generator is bidirectional-safe: Python stays the source until proven
otherwise (spec §12). The "which model becomes a twin vs an inline value object"
decision lives in the declarative config blocks at the top of `gen_dtdl.py`.

## Graph shape

```
Trip ─hasDay→ Day ─hasBlock→ Block
 │ ─atLocation→ Location*   (shared place registry; Block also ─atLocation→)
 │ ─hasCrew→ Person         ─hasFeature→ Feature   ─hasSection→ TripSection
 │                                          TripSection ─hasDay→ Day  ─atLocation→ Location  ─hasBlock→ Block
```

`*` `Location` is a shared registry: `Trip.atLocation` and `Block.atLocation`
both point at the same place node (by `name`/`alias`).

- **Twins (entities)** — `Trip`, `Day`, `Block`, `Location`, `Person`,
  `Feature`, `TripSection`, `User`. Each is a digital twin with its own `$dtId`.
- **`TripSection`** is a real graph node with three edges: `hasDay` (from its
  inclusive `[first,last]` day-range), `atLocation` (from `locationRefs`), and
  `hasBlock` (unscheduled ideation content). This makes the section grouping —
  and ideation content — survive in the graph, not just in `trip.json`.
- **`User` EXTENDS `Person`** (DTDL `extends`): a logged-in user *is* a person,
  plus `email`/`displayName`/`authProvider`. Because a real user's `$dtId` is
  their global auth id (**an opaque GUID, no prefix** — not the trip-scoped
  person id), login does NOT mutate the placeholder twin — it creates the `User`
  twin and **transfers the `hasCrew` edges** (carrying `role` + `note`) onto
  it, then drops the placeholder. No field copy; `role` and `note` survive.
- **`role` + `note` are `hasCrew` edge properties** (trip-relative), NOT
  `Person` fields — they are kept in `models.py` only as the trip.json data
  carriers; the generator strips them from the `Person`/`User` DTDL and the
  converter moves them to the edge. (The node is shared across trips after
  claim; the edge belongs to the trip.)
- **Inline value objects (no twin)** — `Link`, `Stat`, `Theme`, `MetaItem`,
  `TodoItem`, `FeatureCard`, `Contact`, `Practical`, `BlockItem`. They serialize
  as DTDL `Object`/inline `Array` schemas on the owning twin.
- **Enums** — `BlockKind` (the 10 block kinds), `Stage`, `BlockStatus`, `Role`.
- **P2 stubs** (declared now, code later) — `Integration`, `FeedEntry`.

## `$dtId` scheme (opaque GUID, content-stored)

The twin id is **immutable** and carries **no semantic meaning**. Each node
stores an opaque `id` (a GUID) in `trip.json`; the converter uses that value
**verbatim** as the twin `$dtId`. There is **no type/slug/date prefix** — all
meaning lives in `$metadata.$model` + the content. Because the id is persisted
in `trip.json`, a re-seed **replaces** the existing twin rather than
duplicating it (no drift).

| Twin | `$dtId` | source |
|---|---|---|
| Trip | `<trip.id>` | the trip's `id` field (GUID) |
| Day | `<day.id>` | the day's `id` field (GUID) |
| Block | `<block.id>` | the block's `id` field (GUID) |
| Location | `<loc.id>` | the location's `id` field (GUID) |
| Person | `<person.id>` | the person's `id` field (GUID) |
| Feature | `<feature.id>` | the feature's `id` field (GUID) |
| TripSection | `<section.id>` | the section's `id` field (GUID) |
| User (P2) | `<authId>` | global auth id (own opaque GUID) |

The repo folder/file name (`slug`) is **unrelated** to `$dtId` — it is only for
finding the trip in the repo. The secret `token` is an ordinary editable
Property; rotate it without re-wiring the graph.

This matches your call in the issue: keep an **immutable, meaningless id** so
lookups don't depend on content (date/location/slug can all change), and store
it in `trip.json` so re-seeds replace, not duplicate.

## ADT-compat rules (see spec §6 + agent memory)

- Twins keep `$metadata.$model` but **strip `$lastUpdatedBy`** — ADT-compat
  default for Kiseki; who-changed-it is tracked via `x-user-id` at the API layer.
- Relationships strip the **entire** `$metadata` block.
- Content in string fields; media is a **plain URL** (`/media/<trip>/…` in P0,
  object storage URL in P1) so swapping the media backend only changes the prefix.

## Mocking the read-path (before the SDK is wired)

`scripts/trip_to_graph.py` turns a `trip.json` into the exact twins +
relationships the ADT/Konnektr-Graph REST API returns — so the P1 read-path can
be developed and tested against mocks today:

```bash
uv run python scripts/trip_to_graph.py data/trips/canada-2027/trip.json
uv run python scripts/trip_to_graph.py data/trips/canada-2027/trip.json --anonymize
```

Output under `data/mocks/`:

- `canada-2027.graph.anon.json` — **committed** (safe; token + names scrubbed).
- `canada-2027.graph.json` — **gitignored** (token-bearing real graph; never
  commit the non-anonymized mock).

- `canada-2027.graph.json` — faithful single-trip graph (token + names present).
- `canada-2027.graph.anon.json` — **anonymized**: crew → `Person 1..N`,
  token + `/media/…` URLs scrubbed. Safe for public repos / CI.

These mocks are the seed fixture for issue #8 (seed graph from trip.json +
anonymized mocks) and the regression fixtures for the SDK read-path in issue #4.

## Looking ahead (issue #4 wiring)

When `graph-client-sdk-python` is integrated, the backend's `store.py` swaps
`load_trips()` from file reads to `client.get_twin(trip_dtid)` + relationship
walks, keeping the P0 `GET /api/trips/{token}` contract intact. The mock above
is the contract it must satisfy.

**Status (issue #4):** DONE. `app/graph/client.py` (live `konnektr-graph` SDK
adapter) + `app/graph/convert.py` (`graph_to_trip`, the inverse of
`trip_to_graph.py`) implement the read-path. `store.get_trip_by_token` serves
from the graph as the SOLE source of truth when `KISEKI_GRAPH_URL` +
`KISEKI_GRAPH_TOKEN` are set — a graph read failure surfaces as a 404, never a
stale `trip.json`. The committed
`data/seed/*.graph.json` fixtures (the already-seeded graph) are consumed by the
same `graph_to_trip` — proven byte-faithful against `trip.json` in
`tests/test_graph_read_path.py`. Write-path (agent/UI edits) is the next step.
