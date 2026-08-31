#!/usr/bin/env python3
"""Convert a trip.json into an Azure Digital Twins-shaped graph mock.

Produces the twins + relationships you would get back from the ADT /
Konnektr-Graph REST API (``GET /digitaltwins/{id}`` + ``.../relationships``),
so the graph read-path can be mocked before the SDK is wired (issue #4).

ADT-compat rules baked in (see docs/spec.md §6 + agent memory):
  * Every twin carries ``$dtId`` (immutable, opaque) + ``$metadata.$model``.
    ``$lastUpdatedBy`` is intentionally STRIPPED from twin $metadata (the
    ADT-compat default for Kiseki — track it via x-user-id at the API layer).
  * Relationships carry ``$relationshipId/$sourceId/$relationshipName/$targetId``
    and STRIP THE ENTIRE ``$metadata`` block (per ADT-compat config).
  * ``$dtId`` is a plain opaque GUID stored on each node's ``id`` field in
    trip.json — used VERBATIM as the twin id. It carries NO semantic meaning
    (no type/slug/date prefix); all meaning lives in ``$metadata.$model`` and
    the content. Re-seed replaces the twin by id, so no drift. The repo folder
    name (``slug``) is unrelated to ``$dtId``. A logged-in ``User`` twin uses
    its own opaque global auth id. The secret ``token`` is an ordinary editable
    Property — rotate it without re-wiring the graph.

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
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import models as M  # noqa: E402

MODEL = lambda name: f"dtmi:kiseki:travel:{name};1"

# Fields that are RELATIONSHIP edges (not properties) on each entity.
REL_FIELDS = {
    "Trip": {"days", "locations", "crew", "features", "sections"},
    "Day": {"blocks"},
    "TripSection": {"blocks", "locationRefs"},
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


def _rel_id(src: str, name: str, tgt: str) -> str:
    """Deterministic, re-seed-stable relationship id (unique per src+name+tgt)."""
    return f"{src}__{name}__{tgt}"


def _strip_rel_fields(model_name: str, data: dict) -> dict:
    for f in REL_FIELDS.get(model_name, set()):
        data.pop(f, None)
    data.pop("id", None)  # `id` maps to $dtId, not a graph property
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


def _emit_block(bid, parent_did, blk, twins, rels, loc_ids):
    """Create a Block twin + its hasBlock edge and any atLocation edge."""
    bprops = _strip_rel_fields("Block", blk.model_dump())
    twins.append(twin(bid, "Block", bprops))
    rels.append(relationship(_rel_id(parent_did, "hasBlock", bid), parent_did, "hasBlock", bid))
    if blk.location and blk.location in loc_ids:
        rels.append(relationship(_rel_id(bid, "atLocation", loc_ids[blk.location]), bid, "atLocation", loc_ids[blk.location]))


def _emit_section_blocks(tid, sid, section, twins, rels, loc_ids):
    """Section-owned unscheduled blocks -> hasBlock edges (ideation content)."""
    for blk in section.blocks:
        bid = blk.id
        _emit_block(bid, sid, blk, twins, rels, loc_ids)


def trip_to_graph(trip: M.Trip, anonymize: bool = False) -> dict:
    if anonymize:
        trip = _anonymize(trip)

    tid = trip.id
    twins: list[dict] = []
    rels: list[dict] = []

    # --- location registry (name/alias -> $dtId) ------------------------------
    loc_ids: dict[str, str] = {}
    for loc in trip.locations:
        lid = loc.id
        loc_ids[loc.name] = lid
        for a in loc.alias:
            loc_ids[a] = lid
        twins.append(twin(lid, "Location", _strip_rel_fields("Location", loc.model_dump())))

    # --- crew (role is moved onto the hasCrew edge, not the Person twin) ------
    person_ids: list[str] = []
    for i, p in enumerate(trip.crew):
        pid = p.id
        person_ids.append(pid)
        twins.append(twin(pid, "Person", _strip_rel_fields("Person", p.model_dump())))
        rel = relationship(_rel_id(tid, "hasCrew", pid), tid, "hasCrew", pid, index=i)
        rel["role"] = p.role  # trip-relative role rides on the edge
        rels.append(rel)

    # --- features / sections -------------------------------------------------
    for i, f in enumerate(trip.features):
        fid = f.id
        twins.append(twin(fid, "Feature", _strip_rel_fields("Feature", f.model_dump())))
        rels.append(relationship(_rel_id(tid, "hasFeature", fid), tid, "hasFeature", fid, index=i))
    for i, s in enumerate(trip.sections):
        sid = s.id
        twins.append(twin(sid, "TripSection", _strip_rel_fields("TripSection", s.model_dump())))
        rels.append(relationship(_rel_id(tid, "hasSection", sid), tid, "hasSection", sid, index=i))
        # section -> Location edges (the region/stay it covers)
        for ref in s.locationRefs:
            if ref in loc_ids:
                rels.append(relationship(_rel_id(sid, "atLocation", loc_ids[ref]), sid, "atLocation", loc_ids[ref]))
        # section -> Day edges from the inclusive [first,last] index range (day identity is its opaque id)
        if len(s.days) == 2 and s.days[1] >= s.days[0]:
            for di in range(s.days[0], s.days[1] + 1):
                did = trip.days[di].id
                rels.append(relationship(_rel_id(sid, "hasDay", did), sid, "hasDay", did, index=di))
        # section-owned unscheduled blocks (ideation)
        _emit_section_blocks(tid, sid, s, twins, rels, loc_ids)

    # --- days + blocks -------------------------------------------------------
    for di, day in enumerate(trip.days):
        did = day.id
        for blk in day.blocks:
            bid = blk.id
            _emit_block(bid, did, blk, twins, rels, loc_ids)
        dprops = _strip_rel_fields("Day", day.model_dump())
        # remove blocks list already stripped; keep day scalar fields
        twins.append(twin(did, "Day", dprops))
        rels.append(relationship(_rel_id(tid, "hasDay", did), tid, "hasDay", did, index=di))

    # --- root trip twin ------------------------------------------------------
    tprops = _strip_rel_fields("Trip", trip.model_dump())
    twins.append(twin(tid, "Trip", tprops))
    for i, loc in enumerate(trip.locations):
        rels.append(relationship(_rel_id(tid, "atLocation", loc_ids[loc.name]), tid, "atLocation", loc_ids[loc.name], index=i))

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
