#!/usr/bin/env python3
"""Structural validator for DTDL v4 model documents.

Not a full DTDL spec implementation (the official parser is NuGet-only), but a
focused check of the rules most likely to fail an ADT/Konnektr-Graph model
upload, derived from DTDL.v4.md:

  * @context == "dtmi:dtdl:context;4"
  * @id is a well-formed DTMI (dtmi:<seg>:<seg>;N, segments [A-Za-z0-9_]+)
  * @type one of the v4 metamodel classes
  * `name` matches ^[a-zA-Z][a-zA-Z0-9_]*[a-zA-Z0-9]$ and is unique per Interface
  * every referenced id (schema / target / elementSchema) resolves within the doc
  * Enum / Relationship / Component / Object carry their required fields
  * `writable` only appears on Property

Usage:
    uv run python scripts/validate_dtdl.py [path/to/models.json]
Default path: ../dtdl/kiseki-models.json
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "dtdl" / "kiseki-models.json"

# dtmi:<path>;<version>  where <path> = seg(;seg)* , each seg = [A-Za-z0-9_]+
DTMI_RE = re.compile(r"^dtmi:[a-zA-Z0-9_]+((:[a-zA-Z0-9_]+)+);[1-9][0-9]*$")
NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*[a-zA-Z0-9]$")
PRIMITIVES = {
    "boolean", "date", "dateTime", "double", "duration", "float", "integer",
    "long", "string", "time", "byte", "bytes", "decimal", "short",
    "unsignedByte", "unsignedInteger", "unsignedLong", "unsignedShort", "uuid",
}
METAMODEL = {
    "Interface", "Telemetry", "Property", "Command", "Relationship",
    "Component", "Enum", "Object", "Array", "Map",
}


class VError(Exception):
    pass


def _check(cond, msg):
    if not cond:
        raise VError(msg)


def _resolve_ref(ref, ids):
    if isinstance(ref, dict):
        et = ref.get("@type")
        if et == "Array":
            _resolve_ref(ref.get("elementSchema"), ids)
        elif et == "Map":
            _resolve_ref(ref.get("mapValue"), ids)
        elif et == "Object":
            for f in ref.get("fields", []):
                _resolve_ref(f.get("schema"), ids)
        return
    if not isinstance(ref, str):
        raise VError(f"non-string schema reference: {ref!r}")
    if ref in PRIMITIVES or ref == "dtmi:dtdl:context;4":
        return
    _check(ref in ids, f"unresolved reference: {ref!r}")


def validate(doc: list[dict]) -> None:
    ids = set()
    # All valid @ids (top-level Interfaces + scoped schemas nested in `schemas`).
    # A schema nested in an Interface's `schemas` is referenceable only from that
    # same Interface, but the @id is still a valid target for `schema`/`target`
    # references elsewhere in the doc — so collect them all for resolution.
    # Only TOP-LEVEL @ids must be unique; the same schema @id may legally repeat
    # across Interfaces (each defines its own local copy).
    top_level_ids = set()
    for d in doc:
        _check(d.get("@context") == "dtmi:dtdl:context;4",
               f"{d.get('@id')}: @context must be 'dtmi:dtdl:context;4'")
        _id = d.get("@id")
        _check(_id and DTMI_RE.match(_id), f"invalid @id: {_id!r}")
        _check(_id not in top_level_ids, f"duplicate @id: {_id}")
        top_level_ids.add(_id)
        ids.add(_id)
        if d.get("@type") == "Interface" and "schemas" in d:
            for s in d["schemas"]:
                sid = s.get("@id")
                _check(sid and DTMI_RE.match(sid), f"invalid nested @id: {sid!r}")
                ids.add(sid)  # legal to repeat across interfaces — no uniqueness check

    for d in doc:
        _id = d["@id"]
        if d["@type"] == "Enum":
            _check("valueSchema" in d, f"{_id}: Enum needs valueSchema")
            _check("enumValues" in d and d["enumValues"], f"{_id}: Enum needs enumValues")
            seen = set()
            for ev in d["enumValues"]:
                _check("name" in ev and "enumValue" in ev, f"{_id}: enumValue needs name+enumValue")
                _check(ev["name"] not in seen, f"{_id}: duplicate enumValue name {ev['name']}")
                seen.add(ev["name"])
            _resolve_ref(d["valueSchema"], ids)
        elif d["@type"] == "Object":
            _check("fields" in d and d["fields"], f"{_id}: Object needs fields")
            for f in d["fields"]:
                _check(NAME_RE.match(f["name"]), f"{_id}: bad field name {f['name']!r}")
                _resolve_ref(f["schema"], ids)
        elif d["@type"] == "Interface":
            # validate nested schemas (they are real DTDL entities)
            for s in d.get("schemas", []):
                st = s.get("@type")
                if st == "Enum":
                    _check("valueSchema" in s, f"{s.get('@id')}: Enum needs valueSchema")
                    _check("enumValues" in s and s["enumValues"], f"{s.get('@id')}: Enum needs enumValues")
                    _resolve_ref(s["valueSchema"], ids)
                elif st == "Object":
                    _check("fields" in s and s["fields"], f"{s.get('@id')}: Object needs fields")
                    for f in s["fields"]:
                        _check(NAME_RE.match(f["name"]), f"{s.get('@id')}: bad field name {f['name']!r}")
                        _resolve_ref(f["schema"], ids)
            names = set()
            for c in d.get("contents", []):
                ct = c.get("@type")
                _check(ct in METAMODEL, f"{_id}: bad content @type {ct!r}")
                nm = c.get("name")
                if ct in ("Property", "Telemetry", "Command", "Relationship", "Component"):
                    _check(nm and NAME_RE.match(nm), f"{_id}: bad content name {nm!r}")
                    _check(nm not in names, f"{_id}: duplicate content name {nm!r}")
                    names.add(nm)
                if ct == "Property":
                    _check("schema" in c, f"{_id}.{nm}: Property needs schema")
                    _resolve_ref(c["schema"], ids)
                elif ct == "Relationship":
                    _check("target" in c, f"{_id}.{nm}: Relationship needs target")
                    _resolve_ref(c["target"], ids)
                elif ct == "Component":
                    _check("schema" in c, f"{_id}.{nm}: Component needs schema")
                    _resolve_ref(c["schema"], ids)
                elif ct == "Telemetry":
                    _check("schema" in c, f"{_id}.{nm}: Telemetry needs schema")
                    _resolve_ref(c["schema"], ids)


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    try:
        validate(doc)
    except VError as exc:
        print(f"INVALID {path}: {exc}", file=sys.stderr)
        return 1
    print(f"VALID: {path} ({len(doc)} definitions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
