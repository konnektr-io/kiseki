#!/usr/bin/env python3
"""Reload all DTDL v4 models into the Konnektr Graph, preserving twins.

SAFE-BY-DEFAULT: ``delete_all_models`` removes schema metadata only — existing
twins/edges survive (the pg-age-digitaltwins rule: a model reload is twins-safe).
Twins only stop validating if their new schema is incompatible, which this script
never produces (it re-registers the exact committed ``dtdl/kiseki-models.json``).

Usage (run inside the kiseki pod, or anywhere with the SDK + env):
  KONNEKTR_GRAPH_URL=http://<graph-api>:8080 \
    uv run python scripts/reload_dtdl_models.py            # reload
  KONNEKTR_GRAPH_URL=http://<graph-api>:8080 \
    uv run python scripts/reload_dtdl_models.py --dry-run  # count only

``KONNEKTR_GRAPH_TOKEN`` is OPTIONAL (auth is disabled on this cluster's Graph
API; the kiseki pod's ``KISEKI_GRAPH_*`` env is picked up automatically when
run in-pod). It is NOT the graph-DB password.

In-pod one-liner (the slim image ships NO dtdl/ or scripts/ — stdin-copy both
files, kubectl cp is flaky):
  kubectl exec -i -n kiseki <pod> -- python -c "import sys; open('/tmp/kiseki-models.json','wb').write(sys.stdin.buffer.read())" < backend/dtdl/kiseki-models.json
  kubectl exec -i -n kiseki <pod> -- python -c "import sys; open('/tmp/reload.py','wb').write(sys.stdin.buffer.read())" < backend/scripts/reload_dtdl_models.py
  kubectl exec -n kiseki <pod> -- python /tmp/reload.py --models /tmp/kiseki-models.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))


def _client():
    from konnektr_graph import KonnektrGraphClient  # noqa: PLC0415
    from konnektr_graph.auth.static_token_credential import (  # noqa: PLC0415
        StaticTokenCredential,
    )

    # The kiseki pod env uses KISEKI_GRAPH_*; the SDK convention is KONNEKTR_GRAPH_*.
    url = os.environ.get("KONNEKTR_GRAPH_URL") or os.environ.get("KISEKI_GRAPH_URL")
    if not url:
        raise SystemExit(
            "Set KONNEKTR_GRAPH_URL (or KISEKI_GRAPH_URL, the pod's own env) first."
        )
    token = os.environ.get("KONNEKTR_GRAPH_TOKEN") or os.environ.get(
        "KISEKI_GRAPH_TOKEN"
    )
    if token:
        return KonnektrGraphClient(url, StaticTokenCredential(token))

    class _NoAuth:
        def get_token(self) -> str:
            return ""

        def get_headers(self) -> dict:
            return {}

    return KonnektrGraphClient(url, _NoAuth())  # type: ignore[arg-type]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dry-run", action="store_true", help="count models without writing"
    )
    ap.add_argument(
        "--models",
        default=str(ROOT / "dtdl" / "kiseki-models.json"),
        help="path to kiseki-models.json (override when running outside the repo, e.g. /tmp in-pod)",
    )
    args = ap.parse_args()

    raw = json.loads(Path(args.models).read_text(encoding="utf-8"))
    # DtdlInterface.from_dict strips the @context/@id keys into their proper
    # SDK attributes — never hand DtdlInterface(**d) with raw @-prefixed keys.
    from konnektr_graph.types import DtdlInterface  # noqa: E402

    models = [DtdlInterface.from_dict(m) for m in raw]

    if args.dry_run:
        print(f"[dry-run] would reload {len(models)} models")
        return

    client = _client()
    client.delete_all_models()
    client.create_models(models)
    print(f"[reload] registered {len(models)} models (twins preserved)")
    for m in models:
        print(f"  - {m.id}")


if __name__ == "__main__":
    main()
