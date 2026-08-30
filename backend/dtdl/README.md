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
```

`*` `Location` is a shared registry: `Trip.atLocation` and `Block.atLocation`
both point at the same place node (by `name`/`alias`).

- **Twins (entities)** — `Trip`, `Day`, `Block`, `Location`, `Person`,
  `Feature`, `TripSection`. Each is a digital twin with its own `$dtId`.
- **Inline value objects (no twin)** — `Link`, `Stat`, `Theme`, `MetaItem`,
  `TodoItem`, `FeatureCard`, `Contact`, `Practical`, `BlockItem`. They serialize
  as DTDL `Object`/inline `Array` schemas on the owning twin.
- **Enums** — `BlockKind` (the 10 block kinds), `Stage`, `BlockStatus`, `Role`.
- **P2 stubs** (declared now, code later) — `User`, `Integration`, `FeedEntry`.

## `$dtId` scheme (immutable)

The twin id is **structural and immutable**, derived from the `slug`:

| Twin | `$dtId` |
|---|---|
| Trip | `trip:<slug>` |
| Day | `trip:<slug>:day:<i>` |
| Block | `trip:<slug>:day:<i>:block:<j>` |
| Location | `trip:<slug>:loc:<slugified-name>` |
| Person | `trip:<slug>:person:<i>` |
| Feature | `trip:<slug>:feature:<i>` |
| TripSection | `trip:<slug>:section:<i>` |

`slug` **and** the secret `token` are ordinary editable Properties. You can
rotate the share token without re-wiring the graph — the `$dtId` never changes.
(This matches your call in the issue: keep an immutable id so lookups don't
require resolving the token each time.)

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
