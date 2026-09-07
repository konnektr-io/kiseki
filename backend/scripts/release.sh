#!/usr/bin/env bash
# Post-deploy tail for Kiseki releases: verify the live graph's registered
# DTDL models match the code, reloading when they lag.
#
# Run AFTER `kubectl rollout status deploy/kiseki` succeeds, BEFORE any live
# write / smoke that touches a new property (see docs/post-deploy-dtdl-check.md):
#
#   backend/scripts/release.sh
#
# Flow: verify -> (exit 1 = drift) reload -> re-verify. Fails loudly
# (non-zero) if still unsynced after the reload, or if the graph is
# unreachable (exit 2 — infra failure, never auto-reloaded through).
#
# Flags:
#   --no-reload   verify only; exit 1 if unsynced (CI / checking, no mutation)
#   --dry-run     pass through to reload_dtdl_models.py (counts, never writes;
#                 the re-verify will still fail — that is the point: dry runs
#                 cannot converge, so this exits non-zero when drift exists)
#   --models PATH pass through to verifier + reloader (e.g. /tmp in-pod runs)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
cd "$BACKEND_DIR"

NO_RELOAD=0
DRY_RUN=()
MODELS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-reload) NO_RELOAD=1; shift ;;
    --dry-run) DRY_RUN=(--dry-run); shift ;;
    --models) MODELS=(--models "$2"); shift 2 ;;
    -h|--help)
      sed -n '2,/^set /p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "release.sh: unknown flag $1 (see --help)" >&2; exit 2 ;;
  esac
done

echo "==> verifying live graph DTDL models against the shipped schema..."
# Sibling scripts resolve next to THIS file, not the backend dir — in the repo
# that's scripts/, in-pod it's /tmp (both files copied side by side).
VERIFY="$SCRIPT_DIR/verify_dtdl_models.py"
RELOAD="$SCRIPT_DIR/reload_dtdl_models.py"
# Runner resolution: dev checkouts use `uv run python`; the slim kiseki pod has
# NO uv and NO repo layout — there, plain `python` (with the SDK preinstalled)
# + --models /tmp/... is the only mode. Detect once, use everywhere below.
if command -v uv >/dev/null 2>&1; then
  PYRUN=(uv run python)
else
  PYRUN=(python)
fi
set +e
"${PYRUN[@]}" "$VERIFY" "${MODELS[@]}"
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  echo "release.sh: done — models in sync, safe to run live writes/smokes."
  exit 0
fi
if [[ $rc -ne 1 ]]; then
  # 2 = graph unreachable / bad input; anything else (127 command-not-found,
  # import errors, …) is infra failure too — NEVER treat it as drift.
  echo "release.sh: FAIL — verifier exited $rc (infra/config failure, not drift); fix and re-run." >&2
  exit 2
fi
if [[ $NO_RELOAD -eq 1 ]]; then
  echo "release.sh: FAIL — live graph models lag the code (--no-reload: not reloading)." >&2
  exit 1
fi

echo "==> drift detected — reloading DTDL models (twins/edges are never touched)..."
"${PYRUN[@]}" "$RELOAD" "${DRY_RUN[@]}" "${MODELS[@]}"

echo "==> re-verifying after reload..."
if "${PYRUN[@]}" "$VERIFY" "${MODELS[@]}"; then
  if [[ ${#MODELS[@]} -eq 0 ]]; then
    N_MODELS=$("${PYRUN[@]}" -c "import json; print(len(json.load(open('dtdl/kiseki-models.json'))))")
  else
    N_MODELS=$("${PYRUN[@]}" -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "${MODELS[1]}")
  fi
  echo "release.sh: reloaded ${N_MODELS} models — now in sync."
  exit 0
fi

echo "release.sh: FAIL — still unsynced after reload; do NOT run live writes. Inspect the diff above." >&2
exit 1
