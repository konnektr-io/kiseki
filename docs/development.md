# Development

## Prerequisites

- **Python 3.13** with [uv](https://docs.astral.sh/uv/) (the package declares `>=3.12`)
- **Node.js 22** with [pnpm](https://pnpm.io/) 11 (the lockfile and `pnpm-workspace.yaml` are pinned to it)
- A modern browser for manual testing. Playwright is a backend dependency, and its Chromium is what
  renders booklets — `cd backend && uv run python -m playwright install chromium` if you work on the
  booklet. Nothing else needs a browser.

## Getting running

```bash
# Backend
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000

# Frontend, second terminal
cd frontend
pnpm install
pnpm dev            # http://localhost:5173, proxies /api → :8000
```

Then open <http://localhost:5173>. Useful URLs: `/` (landing), `/t/<trip-id>/itinerary`,
`/t/<trip-id>/day/0`, `/t/<trip-id>/booklet`, `/feed`, `/me`.

### Where the data comes from in dev

The Konnektr Graph is the only production store, and it is not expected to be running locally.
When `KISEKI_GRAPH_URL` is unset the backend serves three **anonymised** sample trips
(`backend/data/mocks/*.graph.anon.json`) — enough to exercise every surface, with no real trip data
and no secrets. This is also exactly what the test suite runs against.

To point a checkout at a real graph:

```bash
export KISEKI_GRAPH_URL="http://localhost:8080"     # e.g. a port-forwarded graph-cluster-api
export KISEKI_GRAPH_TOKEN="…"
uv run uvicorn app.main:app --reload --port 8000
```

`trip.json` and `*.graph.json` files are **authoring scratch** — git-ignored, never read at runtime.

### Production-like single process

```bash
pnpm --dir frontend build
rm -rf backend/app/static && cp -r frontend/dist backend/app/static
cd backend && uv run uvicorn app.main:app --port 8000
```

## Tests

```bash
cd backend  && uv run pytest         # API, ACL, auth, graph conversion, claims, feed, chat relay, erasure
cd frontend && pnpm test             # vitest: components, chat panel, analytics consent, api client
cd frontend && pnpm build            # tsc type-check + production build (the CI gate)
```

The backend suite needs no external services: auth is exercised against a locally generated RSA key
pair and JWKS server, and the graph is replaced by `backend/tests/fake_graph.py`. If your shell has a
stray `PYTHONPATH`, run the suite with `env -u PYTHONPATH uv run pytest` so a fresh venv resolves its
own packages.

CI (`.github/workflows/build-image.yml`) runs all three on every pull request, then builds and pushes
the image on `main` and on `v*` tags. Note that CI sets `KISEKI_STATIC_DIR=../frontend/dist` for the
backend tests — without a built SPA, the SPA-shell tests skip silently.

## Repository layout

```
backend/
  app/            FastAPI application
    main.py         routes (all of them)
    acl.py          the single access-control decision point
    store.py        trip store (graph, with anonymised fixture fallback)
    models.py       the trip document (authoritative Python shape)
    write.py        the write API — the only mutation path
    graph/          Konnektr Graph client + graph→document conversion
    claims.py       crew identity claiming / following
    feed.py         the activity feed
    chat.py         chat relay to the agent (Runs API)
    media.py        Garage/S3 media store + proxy
    places.py       Google Places overlay (server-side key)
    tricount.py     expense snapshots
    erasure.py      account export + erasure
  dtdl/           kiseki-models.json — the DTDL v4 graph model
  data/mocks/     committed anonymised sample trips (dev + CI)
  scripts/        operator and authoring tools (see below)
  tests/          pytest suite
frontend/
  src/pages/      one file per surface (landing, trip, day, crew, feed, profile, join, booklet)
  src/components/ cards, blocks, map surface, chat panel, sheet, theme
  src/lib/        api client, auth, tokens, analytics
deployments/docker/Dockerfile    single-container build (SPA + API + Chromium)
docs/                            these documents
DESIGN.md                        design system & UX law
AGENTS.md                        engineering conventions (and coding-agent context)
.claude/skills/                  repo-local agent skills (design system, map UX, trip identity)
```

## Scripts

| Script | What it does |
|---|---|
| `scripts/gen_dtdl.py` | Generate/refresh the DTDL models from `app/models.py` |
| `scripts/validate_dtdl.py`, `verify_dtdl_models.py`, `reload_dtdl_models.py` | Check and reload the models against a live graph |
| `scripts/seed_graph.py`, `trip_to_graph.py` | Turn an authoring `trip.json` into graph twins |
| `scripts/api_write.py` | The agent's write-API wrapper — the supported way to script trip changes |
| `scripts/kiseki_m2m.py` | Machine-to-machine token helper for scripted access |
| `scripts/migrate_assets_to_s3.py`, `migrate_place_ids.py` | One-off media/place-id migrations |
| `scripts/release.sh` | Cut a release (tag + notes + vault record), with a post-deploy DTDL check |
| `scripts/probe_*.py`, `smoke_write_path.py` | Ad-hoc probes against a deployed instance |

## Conventions

- **Conventional commits**, scoped, with the issue reference when there is one:
  `feat(map): …`, `fix(sheet): …`, `docs(readme): …`, `(#123)`.
- **Branch → pull request → squash merge.** CI must be green. Never push to `main` directly.
- **Content is data.** No trip content, colour or per-trip special case in code; themes and tokens
  are content.
- **One read path, one write path.** Access decisions in `acl.py`, mutations in `write.py`.
- **No secrets, ever** — not in code, fixtures, tests, screenshots, commit messages or issues, and no
  real trip data in the repository. The committed fixtures are anonymised on purpose.
- **Design system first.** `DESIGN.md` is law for anything user-visible; tokens in
  `frontend/src/index.css` are the only source of colour, radius, type and shadow.
- **Tests come with the change**, including access-control tests for new API surface.

`AGENTS.md` carries the longer version of these rules, written for AI coding agents (which are used
heavily on this repo).
