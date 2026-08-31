#!/usr/bin/env python3
"""Seed the Konnektr Graph from the baked trip.json files (P1).

Uses the real ``konnektr-graph`` SDK (the same client the backend will use).
Flow:
  1. ``create_models`` — upload the auto-generated DTDL v4 models.
  2. ``upsert_digital_twin`` (PUT) — one per node. Idempotent: re-running
     replaces a twin by its opaque $dtId (no drift).
  3. ``upsert_relationship`` (PUT) — one per edge, keyed by its stable
     ``<src>__<name>__<tgt>`` id.

The graph payload is produced by ``trip_to_graph.py`` (ADT-shaped JSON), which
already uses the $dtId / $metadata / $relationshipId keys the SDK consumes via
``BasicDigitalTwin.from_dict`` / ``BasicRelationship.from_dict``.

Endpoint + auth come from env:
  KONNEKTR_GRAPH_URL      e.g. http://localhost:8080  (or the in-cluster svc)
  KONNEKTR_GRAPH_TOKEN    the bearer/basic password for the graph-cluster-app

Usage:
  uv run python scripts/seed_graph.py                 # seed models + twins + rels
  uv run python scripts/seed_graph.py --dry-run        # count what would be written
  uv run python scripts/seed_graph.py --anonymize      # strip tokens/personal data first
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import models as M  # noqa: E402
from konnektr_graph import (  # noqa: E402
    BasicDigitalTwin,
    BasicRelationship,
    KonnektrGraphClient,
)
from konnektr_graph.auth.static_token_credential import (  # noqa: E402
    StaticTokenCredential,
)
from scripts.trip_to_graph import trip_to_graph  # noqa: E402

TRIPS_DIR = ROOT / "data" / "trips"
DTDL_FILE = ROOT / "dtdl" / "kiseki-models.json"


def _client() -> KonnektrGraphClient:
    url = os.environ.get("KONNEKTR_GRAPH_URL")
    token = os.environ.get("KONNEKTR_GRAPH_TOKEN")
    if not url or not token:
        raise SystemExit(
            "Set KONNEKTR_GRAPH_URL and KONNEKTR_GRAPH_TOKEN "
            "(graph-cluster-app basic-auth password) before seeding."
        )
    return KonnektrGraphClient(url, StaticTokenCredential(token))


def _discover_slugs() -> list[str]:
    return sorted(p.name for p in TRIPS_DIR.iterdir() if (p / "trip.json").exists())


def build_payloads(anonymize: bool) -> dict[str, dict]:
    return {
        slug: trip_to_graph(
            M.Trip.model_validate_json((TRIPS_DIR / slug / "trip.json").read_text(encoding="utf-8")),
            anonymize=anonymize,
        )
        for slug in _discover_slugs()
    }


def seed_models(client: KonnektrGraphClient, dry_run: bool) -> int:
    raw = json.loads(DTDL_FILE.read_text(encoding="utf-8"))
    from konnektr_graph.types import DtdlInterface

    models = [DtdlInterface.from_dict(m) for m in raw]
    if dry_run:
        print(f"[dry-run] would ensure {len(models)} models")
        return len(models)
    # Idempotent re-seed: the backend exposes DELETE /models (DETAUCH DELETE, ordered
    # by `extends`) which wipes all models; we then re-upload the full set in one batch.
    # This avoids partial-update conflicts and stale model versions.
    client.delete_all_models()
    client.create_models(models)
    print(f"[seed] reset + registered {len(models)} models")
    return len(models)


def seed_graph(client: KonnektrGraphClient, payloads: dict[str, dict], dry_run: bool) -> tuple[int, int]:
    twins = rels = 0
    for slug, g in payloads.items():
        for t in g["twins"]:
            dt = BasicDigitalTwin.from_dict(t)
            if dry_run:
                twins += 1
                continue
            client.upsert_digital_twin(dt.dtId, dt)
            twins += 1
        for r in g["relationships"]:
            rel = BasicRelationship.from_dict(r)
            if dry_run:
                rels += 1
                continue
            client.upsert_relationship(rel.sourceId, rel.relationshipId, rel)
            rels += 1
        print(f"[seed] {'would upsert' if dry_run else 'upserted'} {slug}: {len(g['twins'])} twins, {len(g['relationships'])} rels")
    return twins, rels


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="count instead of writing")
    ap.add_argument("--anonymize", action="store_true", help="strip tokens/personal data before seeding")
    args = ap.parse_args()

    payloads = build_payloads(args.anonymize)
    client = _client()
    seed_models(client, args.dry_run)
    twins, rels = seed_graph(client, payloads, args.dry_run)
    print(f"[seed] done: {twins} twins, {rels} relationships across {len(payloads)} trips")


if __name__ == "__main__":
    main()
