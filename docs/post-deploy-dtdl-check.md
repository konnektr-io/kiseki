# Post-deploy DTDL model check

**TL;DR:** after deploying a PR whose diff touched `backend/app/models.py` or
`backend/scripts/gen_dtdl.py`, run

```bash
cd backend && ./scripts/release.sh
```

**before any live write or smoke that touches a new property.**

## Why (the failure mode)

App code and graph models deploy **independently**. The graph server validates
every twin write against its *registered* DTDL models — which only change when
someone re-registers them. The new image ships code that writes NEW property
names; the live graph still enforces the OLD schema:

```
app.graph.client.GraphWriteError: Graph write failed (twin patch …)
  … Error 400: Property 'placeId' is not defined in the model
```

Local pytest stays green the whole time — the test graph uses the
freshly-generated models — so **CI cannot catch this**. It surfaced on
2026-09-07 (v0.23.12 / PR #127 / issues #15+#95): a clean `Location` model
extension (`placeId`, `address`, `website`, `phone`, `types`, `summary`, …)
and the very first live `PUT /locations` 500'd until the reload was run by
hand. Worse, `put_locations` deletes the root `atLocation` edges BEFORE the
per-location patch loop, so the failed write also **detached all 11 Location
twins from the trip** (edges deleted, twins alive) — the registry read back
empty until the names were re-PUT. See the v0.23.12 post-mortem in the ops
skill (`references/dtdl-model-reload.md`, `references/put-locations-semantics.md`).

## What to run

```bash
# after `kubectl rollout status deploy/kiseki` succeeds:
cd backend
./scripts/release.sh            # verify → reload if drifted → re-verify
./scripts/release.sh --no-reload  # verify only (CI / checking, no mutation)
./scripts/release.sh --dry-run    # verify + reload in dry-run (never converges if drift exists — by design)
```

Exit codes: **0** in sync · **1** drift (reload required; auto-reload attempted
unless `--no-reload`) · **2** cannot reach the graph (infra/config — never
auto-reloaded through).

## What the verifier does

`scripts/verify_dtdl_models.py` is **read-only**: it loads the committed
`backend/dtdl/kiseki-models.json`, lists the live graph's registered models
(`client.list_models(include_model_definition=True)`), extracts each model's
`Property` contents, and reports **missing-only** per model:

```
Location: missing placeId, address, website
live graph models lag the code — run uv run python scripts/reload_dtdl_models.py, then re-run this check.
```

Missing-only on purpose: extra live properties (an older schema, base-model
contents pulled in via `extends`) are harmless — only a graph that LACKS what
the code writes can 500. A model missing from the live graph entirely reports
all of its properties.

`scripts/reload_dtdl_models.py` (pre-existing) does the fix: `delete_all_models`
removes schema metadata only — twins/edges survive. Safe-by-default, proven
2026-09-06 (v0.22.0 empty-models incident) and 2026-09-07 (v0.23.12).

## Running inside the kiseki pod (no uv, no repo)

The slim image has neither `uv` nor the repo — copy the three files side by
side into `/tmp` (stdin copy; `kubectl cp` is flaky), then run with `bash`:

```bash
WT=backend  # your kiseki checkout
POD=$(kubectl -n kiseki get pod -l app.kubernetes.io/name=kiseki -o jsonpath='{.items[0].metadata.name}')
for f in verify_dtdl_models.py reload_dtdl_models.py release.sh; do
  kubectl exec -i -n kiseki $POD -- python -c "import sys; open('/tmp/$f','wb').write(sys.stdin.buffer.read())" < $WT/scripts/$f
done
# the committed schema too (the verifier reads it):
kubectl exec -i -n kiseki $POD -- python -c "import sys; open('/tmp/kiseki-models.json','wb').write(sys.stdin.buffer.read())" < $WT/dtdl/kiseki-models.json
kubectl exec -n kiseki $POD -- bash -c 'bash /tmp/release.sh --models /tmp/kiseki-models.json --no-reload; echo "exit=$?"'
```

`release.sh` auto-detects the environment: with `uv` on PATH it runs
`uv run python …` from the backend dir; without it (in-pod) plain `python`
with sibling scripts resolved next to `release.sh` itself. It also treats any
non-{0,1} verifier exit (127 command-not-found, import errors, …) as an infra
failure — exit 2, never auto-reload through a broken environment.

## When NOT to run it

Content-only deploys (no model/DTDL diff) don't need it — but running it is
free and read-only, so when in doubt, run it. A dirty worktree, stale venv, or
unreachable graph exits 2 with a clear message and mutates nothing.
