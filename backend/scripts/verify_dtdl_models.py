#!/usr/bin/env python3
"""Verify the live Konnektr Graph has the DTDL models the app code expects.

Why this exists: app code and graph models deploy INDEPENDENTLY. When a PR
extends ``app/models.py`` (e.g. new ``Location`` fields in v0.23.12), the new
image writes the NEW property names while the live graph still enforces the
OLD schema — the first live write using a new property 500s with
``Property '<name>' is not defined in the model`` (via GraphWriteError).
Local pytest stays green (it uses freshly generated models), so CI never
catches it. Run this AFTER every deploy whose diff touched ``app/models.py``
or ``scripts/gen_dtdl.py``, BEFORE any live write/smoke — see
``docs/post-deploy-dtdl-check.md``.

Read-only: NEVER mutates the graph. Exit 0 = in sync, exit 1 = reload
required (live graph is missing properties), exit 2 = cannot reach the graph
or bad local input (infra/config failure, not drift).

Usage (same env as reload_dtdl_models.py):
  KONNEKTR_GRAPH_URL=http://<graph-api>:8080 \
    uv run python scripts/verify_dtdl_models.py
  KONNEKTR_GRAPH_URL=http://<graph-api>:8080 \
    uv run python scripts/verify_dtdl_models.py --quiet  # exit code only

``KONNEKTR_GRAPH_TOKEN`` is OPTIONAL (see reload_dtdl_models.py); without
cluster credentials this fails with a clear "cannot reach graph" message
(exit 2), never a traceback.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))


def short_name(dtmi: str) -> str:
    """``dtmi:kiseki:travel:Location;1`` -> ``Location``."""
    name = dtmi.split(":")[-1]
    return name.split(";")[0]


def expected_properties(doc: list[dict]) -> dict[str, set[str]]:
    """Per-model Property names from a ``kiseki-models.json``-shaped doc.

    Only ``@type == "Property"`` contents count — Relationship names (e.g.
    ``atLocation``) are edges, not properties, and must never be reported.
    """
    out: dict[str, set[str]] = {}
    for model in doc:
        if model.get("@type") != "Interface" or "@id" not in model:
            continue
        props = {
            c["name"]
            for c in (model.get("contents") or [])
            if isinstance(c, dict) and c.get("@type") == "Property" and c.get("name")
        }
        out[model["@id"]] = props
    return out


def _live_entry_id(entry) -> str:
    if isinstance(entry, dict):
        return entry.get("id", "")
    return getattr(entry, "id", "")


def _live_entry_props(entry) -> set[str]:
    """Property names for one live model entry (SDK object or raw dict)."""
    model = entry.get("model") if isinstance(entry, dict) else getattr(entry, "model", None)
    if isinstance(model, dict):
        contents = model.get("contents") or []
    else:
        contents = getattr(model, "contents", None) or []
    props = {
        c.get("name") if isinstance(c, dict) else getattr(c, "name", None)
        for c in contents
    }
    props = {p for p in props if p}
    # Fallback: some SDK surfaces flatten properties outside the definition.
    if not props:
        flat = entry.get("properties") if isinstance(entry, dict) else getattr(entry, "properties", None)
        for p in flat or []:
            name = p.get("name") if isinstance(p, dict) else getattr(p, "name", None)
            if name:
                props.add(name)
    # Filter to plain properties: drop anything that is actually a
    # relationship edge carried alongside (defensive; the definition path
    # above already selects Property contents only).
    return props


def live_properties(entries) -> dict[str, set[str]]:
    """Map live model @id -> registered property names."""
    return {mid: _live_entry_props(e) for e in entries if (mid := _live_entry_id(e))}


def diff_models(
    expected: dict[str, set[str]], live: dict[str, set[str]]
) -> dict[str, list[str]]:
    """Missing properties per model, keyed by SHORT name, values sorted.

    Missing-only on purpose: extra live properties (older schema, base-model
    contents inclusion via `extends`) are fine — only a live graph that LACKS
    what the code writes can 500. A model absent from the live graph entirely
    reports all its expected properties as missing.
    """
    missing: dict[str, list[str]] = {}
    for mid, props in expected.items():
        gap = sorted(props - live.get(mid, set()))
        if gap:
            missing[short_name(mid)] = gap
    return missing


def _client():
    # Mirrored from reload_dtdl_models.py — same env, same no-auth fallback.
    from konnektr_graph import KonnektrGraphClient  # noqa: PLC0415
    from konnektr_graph.auth.static_token_credential import (  # noqa: PLC0415
        StaticTokenCredential,
    )

    # The kiseki pod env uses KISEKI_GRAPH_*; the SDK convention is KONNEKTR_GRAPH_*.
    url = os.environ.get("KONNEKTR_GRAPH_URL") or os.environ.get("KISEKI_GRAPH_URL")
    if not url:
        raise SystemExit(
            "cannot reach graph: set KONNEKTR_GRAPH_URL "
            "(or KISEKI_GRAPH_URL, the pod's own env) first."
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


def fetch_live_properties(client) -> dict[str, set[str]]:
    entries = list(client.list_models(include_model_definition=True))
    return live_properties(entries)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--models",
        default=str(ROOT / "dtdl" / "kiseki-models.json"),
        help="path to kiseki-models.json (override when running outside the repo, e.g. /tmp in-pod)",
    )
    ap.add_argument(
        "--quiet", action="store_true", help="exit code only (no output)"
    )
    args = ap.parse_args()

    try:
        doc = json.loads(Path(args.models).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read models file {args.models}: {exc}", file=sys.stderr)
        return 2
    expected = expected_properties(doc)

    try:
        client = _client()
    except SystemExit as exc:
        print(exc.code, file=sys.stderr)
        return 2
    try:
        live = fetch_live_properties(client)
    except Exception as exc:  # noqa: BLE001 — any transport/auth failure
        print(f"cannot reach graph: {exc}", file=sys.stderr)
        return 2

    missing = diff_models(expected, live)
    if not missing:
        if not args.quiet:
            print(f"post-deploy model check: OK ({len(expected)} models in sync)")
        return 0

    if not args.quiet:
        for name in sorted(missing):
            print(f"{name}: missing {', '.join(missing[name])}")
        print(
            "live graph models lag the code — run "
            "uv run python scripts/reload_dtdl_models.py, then re-run this check. "
            "(Without the reload, the first live write using a new property 500s: "
            "Property '<name>' is not defined in the model.)"
        )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
