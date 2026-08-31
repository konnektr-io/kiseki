#!/usr/bin/env python3
"""Seed the Konnektr Graph from the baked trip.json files (P1).

Today this writes the ADT-shaped graph payloads (twins + relationships) to
``backend/data/seed/<slug>.graph.json`` — the files the future live sink will
ingest. The converter (``trip_to_graph.py``) maps each node's opaque ``id``
(verbatim $dtId) so re-running replaces twins by id (no drift).

When a live Graph endpoint is configured (KONNEKTR_GRAPH_URL + token), pass
``--sink`` to upsert twins/relationships via the REST API instead of writing
JSON. The sink is intentionally a thin adapter — the graph shape is identical.

Usage:
    uv run python scripts/seed_graph.py                 # write JSON seed files
    uv run python scripts/seed_graph.py --sink           # upsert to live Graph
    uv run python scripts/seed_graph.py --sink --dry-run # print what would upsert
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import models as M  # noqa: E402
from scripts.trip_to_graph import trip_to_graph  # noqa: E402

TRIPS_DIR = ROOT / "data" / "trips"
SEED_DIR = ROOT / "data" / "seed"


def _discover_slugs() -> list[str]:
    return sorted(p.name for p in TRIPS_DIR.iterdir() if (p / "trip.json").exists())


def build_payloads(anonymize: bool = False) -> dict[str, dict]:
    payloads: dict[str, dict] = {}
    for slug in _discover_slugs():
        raw = (TRIPS_DIR / slug / "trip.json").read_text(encoding="utf-8")
        trip = M.Trip.model_validate_json(raw)
        payloads[slug] = trip_to_graph(trip, anonymize=anonymize)
    return payloads


def write_json(payloads: dict[str, dict]) -> None:
    SEED_DIR.mkdir(parents=True, exist_ok=True)
    for slug, g in payloads.items():
        out = SEED_DIR / f"{slug}.graph.json"
        out.write_text(json.dumps(g, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"[seed] wrote {out.name}: {len(g['twins'])} twins, {len(g['relationships'])} rels")


def upsert_sink(payloads: dict[str, dict], dry_run: bool) -> None:
    """Upsert every twin + relationship into a live Konnektr Graph.

    Requires KONNEKTR_GRAPH_URL (and auth via env). Thin adapter: the payload is
    already ADT-shaped, so this is just PUT/POST per twin/relationship.
    """
    import os

    base = os.environ.get("KONNEKTR_GRAPH_URL")
    if not base:
        raise SystemExit(
            "KONNEKTR_GRAPH_URL is not set — cannot upsert to a live Graph. "
            "Set it (and any auth env) or run without --sink to write JSON seeds."
        )
    # Lazily import so the JSON path needs no HTTP deps.
    import urllib.request

    token = os.environ.get("KONNEKTR_GRAPH_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    def _put(url: str, body: dict) -> None:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="PUT")
        if dry_run:
            print(f"[dry-run] PUT {url}")
            return
        try:
            urllib.request.urlopen(req, timeout=30)  # noqa: S310 (internal/trusted)
        except urllib.error.HTTPError as e:
            # 409 = already exists → PATCH update by id (idempotent re-seed)
            if e.code == 409:
                patch = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="PATCH")
                urllib.request.urlopen(patch, timeout=30)  # noqa: S310
            else:
                raise

    for slug, g in payloads.items():
        for t in g["twins"]:
            _put(f"{base.rstrip('/')}/digitaltwins/{t['$dtId']}", t)
        for r in g["relationships"]:
            _put(f"{base.rstrip('/')}/digitaltwins/{r['$sourceId']}/relationships/{r['$relationshipName']}/{r['$relationshipId']}", r)
        print(f"[seed] {'would upsert' if dry_run else 'upserted'} {slug}: {len(g['twins'])} twins, {len(g['relationships'])} rels")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sink", action="store_true", help="upsert to a live Graph (needs KONNEKTR_GRAPH_URL)")
    ap.add_argument("--dry-run", action="store_true", help="with --sink, print instead of writing")
    ap.add_argument("--anonymize", action="store_true", help="strip tokens/personal data before seeding")
    args = ap.parse_args()

    payloads = build_payloads(anonymize=args.anonymize)
    if args.sink:
        upsert_sink(payloads, dry_run=args.dry_run)
    else:
        write_json(payloads)


if __name__ == "__main__":
    main()
