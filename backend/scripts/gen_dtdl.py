#!/usr/bin/env python3
"""Generate DTDL v4 models for Kiseki from the authoritative Pydantic models.

Single source of truth = ``app/models.py``. This script introspects the Pydantic
models and emits DTDL v4 (``dtmi:dtdl:context;4``) model definitions. The graph
design layer (which models become *twins* vs *inline value objects*, which fields
are enum/relationship targets, relationship names) lives in the small declarative
config blocks below, so the generator stays bidirectional-safe: Python stays the
source until proven otherwise (see docs/spec.md §12 "DTDL model evolution").

Graph design (see the issue / spec §5-§6):
  * ENTITY models  -> separate digital twins, referenced from a parent via a
                      RELATIONSHIP edge (one-to-many). This is what makes the
                      trip a *graph*, not a nested document.
  * VALUE-OBJECT   -> inline DTDL Object/Array schema on the owning twin (no
                      separate node). Used for pure data (links, stats, theme...).
  * ENUMS          -> Literal fields map to a DTDL Enum (coarse vocabulary).

Run:
    uv run python scripts/gen_dtdl.py            # writes ../dtdl/kiseki-models.json
    uv run python scripts/gen_dtdl.py --check    # assert byte-stable output (CI)
"""

from __future__ import annotations

import argparse
import json
import sys
import typing
from pathlib import Path

# Make ``app`` importable when run from backend/ or backend/scripts/
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import models as M  # noqa: E402

# ---------------------------------------------------------------------------
# DTDL namespace + version
# ---------------------------------------------------------------------------
ROOT_DTMI = "dtmi:kiseki:travel:"
VERSION = "1"


def mid(name: str) -> str:
    """Build a well-formed DTMI for a model name."""
    return f"{ROOT_DTMI}{name};{VERSION}"


# ---------------------------------------------------------------------------
# Graph design layer (the part a generator can't infer)
# ---------------------------------------------------------------------------
# Models that become *twins* (separate digital twins, referenced via a
# Relationship edge). Everything else is an inline value object.
ENTITY_MODELS = {
    "Trip",
    "Day",
    "Block",
    "Location",
    "Person",
    "Feature",
    "TripSection",
}

# Inline value objects (no twin of their own).
OBJECT_MODELS = {
    "Link",
    "TodoItem",
    "MetaItem",
    "Stat",
    "FeatureCard",
    "Contact",
    "Theme",
    "Practical",
    "BlockItem",
}

# Enum-backed Literal fields -> (enum model name, valueSchema)
ENUMS = {
    "BlockKind": "string",
    "Stage": "string",
    "BlockStatus": "string",
    "Role": "string",
}

# Relationship name to use for a parent->child entity collection field.
REL_NAME = {
    "days": "hasDay",
    "locations": "atLocation",
    "features": "hasFeature",
    "crew": "hasCrew",
    "sections": "hasSection",
    "blocks": "hasBlock",
}

# Extra relationships that the converter synthesizes but which aren't a
# collection field in the model (e.g. a Block references a Location by name).
EXTRA_RELATIONSHIPS = {
    "Block": [("atLocation", "Location")],
}

# P2+ models that are not yet in app/models.py but belong in the graph design
# (see docs/spec.md §5 / §6). Declared literally here so the model set is
# complete for the foundation; backend code lands when P2 starts.
P2_INTERFACES = {
    "User": {
        "displayName": "User",
        "description": "A real (logged-in) user. Crew Person nodes are matched/replaced by these on login (P2).",
        "contents": [
            {"@type": "Property", "name": "email", "schema": "string", "writable": True},
            {"@type": "Property", "name": "displayName", "schema": "string", "writable": True},
            {"@type": "Property", "name": "authProvider", "schema": "string", "writable": True},
        ],
    },
    "Integration": {
        "displayName": "Integration",
        "description": "P2 external integration (photos|strava|timeline|steps). Token lives in app secrets, never in the graph (spec §5).",
        "contents": [
            {"@type": "Property", "name": "kind", "schema": "string", "writable": True},
            {"@type": "Property", "name": "status", "schema": "string", "writable": True},
            {"@type": "Property", "name": "tokenRef", "schema": "string", "writable": True},
        ],
    },
    "FeedEntry": {
        "displayName": "FeedEntry",
        "description": "P2 per-trip live feed entry (type, payload, visibility).",
        "contents": [
            {"@type": "Property", "name": "type", "schema": "string", "writable": True},
            {"@type": "Property", "name": "payload", "schema": "string", "writable": True},
            {"@type": "Property", "name": "visibility", "schema": "string", "writable": True},
        ],
    },
}


# ---- type resolution helpers -------------------------------------------------

_PRIMITIVES = {
    str: "string",
    int: "integer",
    float: "double",
    bool: "boolean",
}


def _unwrap(ann):
    """Return (inner_type, required, is_list)."""
    origin = typing.get_origin(ann)
    if origin is typing.Union:  # Optional[X] = Union[X, None]
        args = [a for a in typing.get_args(ann) if a is not type(None)]
        inner, _, _ = _unwrap(args[0])
        return inner, False, False
    if origin in (list, typing.List):
        (elem,) = typing.get_args(ann)
        inner, _, _ = _unwrap(elem)
        return inner, True, True
    return ann, True, False


def _enum_for_literal(ann):
    """If ``ann`` is a Literal[...] whose values match an ENUMS decl, return name."""
    if typing.get_origin(ann) is typing.Literal:
        vals = set(typing.get_args(ann))
        for name, _ in ENUMS.items():
            lit = getattr(M, name, None)
            if lit is not None and set(typing.get_args(lit)) == vals:
                return name
    return None


# Registry of schemas to inline into the *host* Interface's `schemas` block.
# DTDL: a schema is only referenceable from the same Interface that defines it, so
# every enum referenced by an entity Interface must be co-located in that Interface's
# `schemas`. Shared value-objects are instead inlined directly into the property
# schema (no @id) so they never need cross-interface resolution.
class _SchemaRegistry:
    def __init__(self):
        self._by_name: dict[str, dict] = {}

    def need_enum(self, name: str):
        if name not in self._by_name:
            self._by_name[name] = build_enum(name)

    def as_list(self) -> list[dict]:
        return [self._by_name[k] for k in sorted(self._by_name)]


def _schema_for_scalar(inner, ann, reg: _SchemaRegistry | None = None):
    # enum Literal -> named schema in the host interface's `schemas`
    enum_name = _enum_for_literal(ann)
    if enum_name:
        if reg is not None:
            reg.need_enum(enum_name)
        return mid(enum_name)
    # primitive
    if inner in _PRIMITIVES:
        return _PRIMITIVES[inner]
    # pydantic value-object -> INLINE Object schema (no @id; a value object may be
    # reused by several interfaces, and DTDL forbids cross-interface references)
    if isinstance(inner, type) and issubclass(inner, M.BaseModel) and inner.__name__ in OBJECT_MODELS:
        return build_inline_object(inner)
    # entity (shouldn't happen on a scalar path, but be safe)
    if isinstance(inner, type) and issubclass(inner, M.BaseModel) and inner.__name__ in ENTITY_MODELS:
        return mid(inner.__name__)
    # Any / unknown -> permissive string (Block.items fallback)
    return "string"


# ---- builders ----------------------------------------------------------------\

def build_enum(name: str) -> dict:
    """A reusable enum schema, inlined into the host Interface's `schemas`."""
    lit = getattr(M, name)
    values = typing.get_args(lit)
    enum_values = [{"name": str(v).capitalize(), "enumValue": v} for v in values]
    return {
        "@id": mid(name),
        "@type": "Enum",
        "valueSchema": ENUMS[name],
        "enumValues": enum_values,
    }


def build_inline_object(model_cls) -> dict:
    """A value object as an inline DTDL Object schema (no @id).

    Value objects are inlined into the property schema that uses them, so they
    never require a cross-interface reference. Nested value objects are inlined
    recursively; enums referenced from inside are resolved to the host interface.
    """
    fields = []
    for fname, fld in model_cls.model_fields.items():
        inner, _, is_list = _unwrap(fld.annotation)
        schema = _schema_for_scalar(inner, fld.annotation)
        if is_list:
            schema = {"@type": "Array", "elementSchema": schema}
        fields.append({"name": fld.alias or fname, "schema": schema})
    return {"@type": "Object", "fields": fields}


def _block_item_schema() -> dict:
    return {
        "@type": "Object",
        "fields": [
            {"name": "label", "schema": "string"},
            {"name": "done", "schema": "boolean"},
            {"name": "url", "schema": "string"},
        ],
    }


def build_interface(model_cls) -> dict:
    reg = _SchemaRegistry()
    contents = []
    for fname, fld in model_cls.model_fields.items():
        inner, required, is_list = _unwrap(fld.annotation)
        name = fld.alias or fname
        # entity collection -> Relationship edge
        if isinstance(inner, type) and issubclass(inner, M.BaseModel) and inner.__name__ in ENTITY_MODELS:
            contents.append({
                "@type": "Relationship",
                "name": REL_NAME.get(fname, fname),
                "target": mid(inner.__name__),
            })
            continue
        # plain property (primitive / enum / inline value object)
        schema = _schema_for_scalar(inner, fld.annotation, reg)
        # Block.items is list[Any] -> normalize to Array of inline BlockItem
        if model_cls is M.Block and fname == "items":
            schema = {"@type": "Array", "elementSchema": _block_item_schema()}
        elif is_list:
            schema = {"@type": "Array", "elementSchema": schema}
        prop = {"@type": "Property", "name": name, "schema": schema, "writable": True}
        contents.append(prop)
    # extra synthesized relationships (e.g. Block -> Location)
    for rel_name, target in EXTRA_RELATIONSHIPS.get(model_cls.__name__, []):
        contents.append({
            "@type": "Relationship",
            "name": rel_name,
            "target": mid(target),
        })
    iface: dict = {
        "@context": "dtmi:dtdl:context;4",
        "@id": mid(model_cls.__name__),
        "@type": "Interface",
        "displayName": model_cls.__name__,
        "contents": contents,
    }
    if reg._by_name:
        iface["schemas"] = reg.as_list()
    return iface


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="assert byte-stable output")
    args = ap.parse_args()

    out: list[dict] = []

    # 1) entities (twins) — Interfaces. Each inlines the Enum/Object schemas it
    #    references in its own `schemas` block (DTDL: a schema is only referenceable
    #    from the same Interface that defines it).
    for cls in (M.Trip, M.Day, M.Block, M.Location, M.Person, M.Feature, M.TripSection):
        out.append(build_interface(cls))

    # 3) P2 stubs
    for name, spec in P2_INTERFACES.items():
        out.append({
            "@context": "dtmi:dtdl:context;4",
            "@id": mid(name),
            "@type": "Interface",
            "displayName": spec["displayName"],
            "description": spec["description"],
            "contents": spec["contents"],
        })

    out.sort(key=lambda d: d["@id"])
    text = json.dumps(out, indent=2, ensure_ascii=False) + "\n"

    dtdl_dir = ROOT / "dtdl"
    dtdl_dir.mkdir(exist_ok=True)
    path = dtdl_dir / "kiseki-models.json"

    if args.check:
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        if existing != text:
            print("DTDL changed — re-run `uv run python scripts/gen_dtdl.py`", file=sys.stderr)
            return 1
        print(f"DTDL stable: {path}")
        return 0

    path.write_text(text, encoding="utf-8")
    print(f"Wrote {len(out)} DTDL definitions -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
