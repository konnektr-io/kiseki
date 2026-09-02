# `backend/data/trips/` — local scratch only

The graph is the source of truth. No `trip.json` is committed.

- Real trip data lives in the Konnektr Graph (production) and is updated via the SDK/API as JSON-Patch on individual twins/relationships (#46), not as whole-file reseeds.
- `backend/data/trips/<slug>/trip.json` files are **git-ignored scratch** for local authoring only. Copy from the graph, edit, then `uv run python scripts/trip_to_graph.py <file>` / `seed_graph.py` to push to a local graph — never commit them.
- `backend/data/seed/*.graph.json` is likewise ignored (real data). `backend/data/mocks/*.graph.anon.json` stays committed as anonymized test fixtures.
- DTDL models (`backend/dtdl/kiseki-models.json`, generated from `app/models.py`) remain versioned — they must be `delete_all_models` + `create_models` atomically.

To create a scratch file for local dev: `cp backend/data/mocks/canada-2027.graph.anon.json` → author, or pull via `seed_graph.py --dry-run` from a running graph.
