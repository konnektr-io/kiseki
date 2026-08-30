#!/usr/bin/env python3
"""Convert a trip.json into an Azure Digital Twins-shaped graph mock.

Produces the twins + relationships you would get back from the ADT /
Konnektr-Graph REST API (``GET /digitaltwins/{id}`` + ``.../relationships``),
so the graph read-path can be mocked before the SDK is wired (issue #4).

ADT-compat rules baked in (see docs/spec.md §6 + agent memory):
  * Every twin carries ``$dtId`` (immutable, structural) + ``$metadata.$model``.
    ``$lastUpdatedBy`` is intentionally STRIPPED from twin $metadata (the
    ADT-compat default for Kiseki — track it via x-user-id at the API layer).
  * Relationships carry ``$relationshipId/$sourceId/$relationshipName/$targetId``
    and STRIP THE ENTIRE ``$metadata`` block (per ADT-compat config).
  * ``$dtId`` is the immutable id (``trip:<id>``, ``trip:<id>:day:0`` …). The
    secret ``token`` and human ``slug`` are ordinary editable Properties — you
    can rotate the token without re-wiring the graph.

Usage:
    uv run python scripts/trip_to_graph.py data/trips/canada-2027/trip.json
    uv run python scripts/trip_to_graph.py data/trips/canada-2027/trip.json --anonymize
    uv run python scripts/trip_to_graph.py data/trips/canada-2027/trip.json --out data/mocks/canada-2027.graph.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import models as M  # noqa: E402

MODEL = lambda name: f"dtmi:kiseki:travel:{name};1"

# Fields that are RELATIONSHIP edges (not properties) on each entity.
REL_FIELDS = {
    "Trip": {"days", "locations", "crew", "features", "sections"},
    "Day": {"blocks"},
}


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


def twin(dt_id: str, model_name: str, props: dict) -> dict:
    """Build an ADT-shaped twin with $metadata.$model (no $lastUpdatedBy)."""
    t = {
        "$dtId": dt_id,
        "$etag": 'W/"mock-etag"',
        "$metadata": {"$model": MODEL(model_name)},
    }
    t.update(props)
    return t


def relationship(rel_id: str, src: str, name: str, tgt: str, index: int | None = None) -> dict:
    """Build an ADT-shaped relationship — ENTIRE $metadata stripped."""
    r = {
        "$relationshipId": rel_id,
        "$sourceId": src,
        "$relationshipName": name,
        "$targetId": tgt,
        "$etag": 'W/"mock-etag"',
    }
    if index is not None:
        r["index"] = index
    return r


def _strip_rel_fields(model_name: str, data: dict) -> dict:
    for f in REL_FIELDS.get(model_name, set()):
        data.pop(f, None)
    return data


def _anonymize(trip: M.Trip) -> M.Trip:
    """Return a copy with PII redacted but structure/dates/locations intact."""
    data = trip.model_dump()
    # 1) crew names -> Person N, drop contact
    names = [p["name"] for p in data.get("crew", []) if p.get("name")]
    for i, p in enumerate(data.get("crew", [])):
        p["name"] = f"Person {i + 1}"
        p.pop("contact", None)
        p.pop("note", None)
    # 2) token + media
    data["token"] = "SECRET_TOKEN"
    data["cover"] = "/media/REDACTED" if data.get("cover") else None
    data["map"] = "/media/REDACTED" if data.get("cover") else None
    data["coverCredit"] = "REDACTED" if data.get("coverCredit") else None
    # 3) replace known names inside free text + media urls
    repl: dict[str, str] = {n: f"Person {i + 1}" for i, n in enumerate(names)}
    repl[r"/(media|assets)/[^\"'\s]+"] = "/media/REDACTED"

    def scrub(v):
        if isinstance(v, str):
            for n, p in repl.items():
                v = re.sub(n, p, v)
            return v
        if isinstance(v, list):
            return [scrub(x) for x in v]
        if isinstance(v, dict):
            return {k: scrub(x) for k, x in v.items()}
        return v

    return M.Trip.model_validate(scrub(data))


def trip_to_graph(trip: M.Trip, anonymize: bool = False) -> dict:
    if anonymize:
        trip = _anonymize(trip)

    tid = f"trip:{trip.slug}"
    twins: list[dict] = []
    rels: list[dict] = []

    # --- location registry (name/alias -> $dtId) ------------------------------
    loc_ids: dict[str, str] = {}
    for loc in trip.locations:
        lid = f"{tid}:loc:{slugify(loc.name)}"
        loc_ids[loc.name] = lid
        for a in loc.alias:
            loc_ids[a] = lid
        twins.append(twin(lid, "Location", _strip_rel_fields("Location", loc.model_dump())))

    # --- crew ----------------------------------------------------------------
    person_ids: list[str] = []
    for i, p in enumerate(trip.crew):
        pid = f"{tid}:person:{i}"
        person_ids.append(pid)
        twins.append(twin(pid, "Person", _strip_rel_fields("Person", p.model_dump())))
        rels.append(relationship(f"{tid}-crew-{i}", tid, "hasCrew", pid, index=i))

    # --- features / sections -------------------------------------------------
    for i, f in enumerate(trip.features):
        fid = f"{tid}:feature:{i}"
        twins.append(twin(fid, "Feature", _strip_rel_fields("Feature", f.model_dump())))
        rels.append(relationship(f"{tid}-feature-{i}", tid, "hasFeature", fid, index=i))
    for i, s in enumerate(trip.sections):
        sid = f"{tid}:section:{i}"
        twins.append(twin(sid, "TripSection", _strip_rel_fields("TripSection", s.model_dump())))
        rels.append(relationship(f"{tid}-section-{i}", tid, "hasSection", sid, index=i))

    # --- days + blocks -------------------------------------------------------
    for di, day in enumerate(trip.days):
        did = f"{tid}:day:{di}"
        block_ids: list[str] = []
        for bi, blk in enumerate(day.blocks):
            bid = f"{did}:block:{bi}"
            block_ids.append(bid)
            bprops = _strip_rel_fields("Block", blk.model_dump())
            twins.append(twin(bid, "Block", bprops))
            rels.append(relationship(f"{did}-block-{bi}", did, "hasBlock", bid, index=bi))
            # Block.atLocation -> Location (by name/alias)
            if blk.location and blk.location in loc_ids:
                rels.append(relationship(f"{bid}-loc", bid, "atLocation", loc_ids[blk.location]))
        dprops = _strip_rel_fields("Day", day.model_dump())
        # remove blocks list already stripped; keep day scalar fields
        twins.append(twin(did, "Day", dprops))
        rels.append(relationship(f"{tid}-day-{di}", tid, "hasDay", did, index=di))

    # --- root trip twin ------------------------------------------------------
    tprops = _strip_rel_fields("Trip", trip.model_dump())
    twins.append(twin(tid, "Trip", tprops))
    for i, loc in enumerate(trip.locations):
        rels.append(relationship(f"{tid}-loc-{i}", tid, "atLocation", loc_ids[loc.name], index=i))

    return {"$dtId": tid, "twins": twins, "relationships": rels}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("trip_json", help="path to a trip.json")
    ap.add_argument("--anonymize", action="store_true", help="redact PII for test mocks")
    ap.add_argument("--out", help="output path (default: data/mocks/<slug>.graph{,.anon}.json)")
    args = ap.parse_args()

    raw = Path(args.trip_json).read_text(encoding="utf-8")
    trip = M.Trip.model_validate_json(raw)
    graph = trip_to_graph(trip, anonymize=args.anonymize)

    if args.out:
        out = Path(args.out)
    else:
        mocks = ROOT / "data" / "mocks"
        mocks.mkdir(parents=True, exist_ok=True)
        suffix = ".anon.json" if args.anonymize else ".json"
        out = mocks / f"{trip.slug}.graph{suffix}"
    out.write_text(json.dumps(graph, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(graph['twins'])} twins + {len(graph['relationships'])} relationships -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
