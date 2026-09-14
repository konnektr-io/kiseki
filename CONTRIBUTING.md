# Contributing to Kiseki

Thanks for wanting to help. Kiseki is a personal project that has been made public so others can
read it, learn from it, and — if they want — improve it. Issues and pull requests are welcome.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

## Before you start

- **Small fixes** (typos, docs, obvious bugs): just open a pull request.
- **Anything larger** (a feature, a refactor, a new dependency): open an issue first and describe the
  problem you want solved, not only the solution. This repo has a strong opinionated design
  (`DESIGN.md` is treated as law) and a clear sense of what Kiseki is, so a quick conversation saves
  a lot of rework.
- **Security issues**: never in a public issue — see [`SECURITY.md`](SECURITY.md).

## Orientation

Read these before making a meaningful change:

| File | Why |
|---|---|
| [`docs/spec.md`](docs/spec.md) | What Kiseki is and why it is built this way |
| [`DESIGN.md`](DESIGN.md) | Visual and interaction law — required before any user-visible change |
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit together |
| [`docs/data-model.md`](docs/data-model.md) | The trip document and the graph model |
| [`AGENTS.md`](AGENTS.md) | Engineering conventions, including the rules AI coding agents follow here |

## Getting set up

```bash
# Backend — Python 3.13 + uv
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000

# Frontend — Node + pnpm
cd frontend
pnpm install
pnpm dev            # http://localhost:5173, proxies /api to :8000
```

Then check [`docs/development.md`](docs/development.md) for the data story (why a bare checkout has
no trips) and the full command list.

## What CI checks

Every pull request runs [`.github/workflows/build-image.yml`](.github/workflows/build-image.yml):

- the frontend type-check + production build (`pnpm build`), and
- the backend test suite (`uv run pytest`).

Green CI is required before merge. Please run both locally before pushing — it is much faster than
round-tripping through a runner.

## Conventions

- **Commits**: conventional-commit style, scoped — `feat(map): …`, `fix(sheet): …`, `docs(readme): …`,
  with the issue reference in the subject when there is one (`(#123)`).
- **Branches and merges**: work on a branch, land it through a pull request. Never push directly to
  `main`, never force-push a shared branch.
- **Keep the diff honest**: no drive-by reformatting, no unrelated refactors in the same PR, no
  committed artefacts (build output, `node_modules`, local scratch data).
- **Tests**: bug fixes come with a test that fails before and passes after. New API surface comes
  with tests for its access control as well as its happy path.
- **Access control**: every trip route must be gated through the existing ACL helpers
  (`require_trip_role`, `authorize_trip_path`) rather than open-coding a role check.
- **Content is data**: never hard-code trip content, colours, or per-trip special cases in code.
- **Design tokens**: never introduce a colour, radius, shadow or spacing value that is not a token
  (`frontend/src/index.css`), and keep the accessibility floor (`DESIGN.md`).
- **Secrets**: nothing secret in the repository, ever — no tokens, keys, real trip data or personal
  data in commits, fixtures, tests, screenshots or issues. Seed fixtures are anonymised on purpose;
  keep them that way.

## Reporting bugs and requesting features

Open an issue with: what you expected, what happened, the smallest reproduction you can manage, and
whether it happens on desktop or mobile. Screenshots or a link to a public trip help.

## Questions

Open a discussion or a plain issue — there is no mailing list.
