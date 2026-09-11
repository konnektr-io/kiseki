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
# `User` extends `Person` (DTDL `extends`) — a real user IS a person.
ENTITY_MODELS = {
    "Trip",
    "Day",
    "Block",
    "Location",
    "Person",
    "User",
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
    "ThemeMapStyle",
    "Practical",
    "TricountConfig",
    "BlockItem",
    "SectionFold",
}

# Enum-backed Literal fields -> (enum model name, valueSchema)
ENUMS = {
    "BlockKind": "string",
    "Stage": "string",
    "BlockStatus": "string",
    "Role": "string",
    "Visibility": "string",
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

# Properties carried ON a relationship edge (trip-relative metadata that does not
# belong on the target node). ADT validates edge properties against the
# Relationship definition, so they must be declared here. e.g. `role` rides the
# `hasCrew` edge (the crew member's trip-relative role), not on Person/User.
REL_PROPERTIES = {
    "hasCrew": [
        {"@type": "Property", "name": "role", "schema": "string", "writable": True, "description": "Trip-relative role of the crew member (e.g. owner | planner | guest). Carried on the edge, not on the person."},
        {"@type": "Property", "name": "note", "schema": "string", "writable": True, "description": "Trip-relative note about the crew member on this trip (e.g. gear). Carried on the edge, not on the person — the Person/User node is shared across trips after claim."},
    ],
}

# Extra relationships that the converter synthesizes but which aren't a
# collection field in the model (e.g. a Block references a Location by name).
# TripSection also gets hasDay (from its inclusive [first,last] range) and
# atLocation (from locationRefs) — resolved by the converter, not a field.
EXTRA_RELATIONSHIPS = {
    "Block": [("atLocation", "Location")],
    "TripSection": [("hasDay", "Day"), ("atLocation", "Location")],
}

# P2+ models that are not yet in app/models.py but belong in the graph design
# (see docs/spec.md §5 / §6). Declared literally here so the model set is
# complete for the foundation; backend code lands when P2 starts.
# (User is now a real model in app/models.py — it EXTENDS Person.)
P2_INTERFACES = {
    "Integration": {
        "displayName": "Integration",
        "description": "P2 external integration (photos|strava|timeline|steps). Token lives in app secrets, never in the graph (spec §5).",
        "contents": [
            {"@type": "Property", "name": "kind", "schema": "string", "writable": True, "description": "Integration kind: photos | strava | timeline | steps."},
            {"@type": "Property", "name": "status", "schema": "string", "writable": True, "description": "Connection status (e.g. active | paused | error)."},
            {"@type": "Property", "name": "tokenRef", "schema": "string", "writable": True, "description": "Reference to the OAuth token in the app secret store (never stored in the graph)."},
        ],
    },
    "FeedEntry": {
        "displayName": "FeedEntry",
        "description": "P2 per-trip live feed entry (type, payload, visibility).",
        "contents": [
            {"@type": "Property", "name": "type", "schema": "string", "writable": True, "description": "Entry type, e.g. 'photo' | 'note' | 'activity'."},
            {"@type": "Property", "name": "payload", "schema": "string", "writable": True, "description": "Entry payload (serialized JSON or markdown)."},
            {"@type": "Property", "name": "visibility", "schema": "string", "writable": True, "description": "Who can see it: public | crew | followers | private."},
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
        inner, _, is_list = _unwrap(args[0])
        return inner, False, is_list
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


def _schema_for_scalar(inner, ann):
    # enum Literal -> INLINE Enum schema on the property (DTDL v4 embedded form,
    # Tutorial06). The live pg-age create_models resolver handles embedded schemas
    # but NOT nested-schema *references* (resolution gap at model-upload time), so
    # we inline. Each enum is still defined only within its host interface — not a
    # separate top-level model.
    enum_name = _enum_for_literal(ann)
    if enum_name:
        lit = getattr(M, enum_name)
        values = typing.get_args(lit)
        enum_values = [{"name": str(v).capitalize(), "enumValue": v} for v in values]
        return {"@type": "Enum", "valueSchema": ENUMS[enum_name], "enumValues": enum_values}
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
    contents = []
    cls_doc = (model_cls.__doc__ or "").strip().split("\n")[0]
    # For a derived model (User extends Person), only emit the fields declared
    # on THIS class — inherited fields come from `extends`. ADT rejects a field
    # name that appears both on the base and the derived interface.
    if issubclass(model_cls, M.Person) and model_cls is not M.Person:
        own_field_names = set(model_cls.model_fields) - set(M.Person.model_fields)
    else:
        own_field_names = set(model_cls.model_fields.keys())
    for fname, fld in model_cls.model_fields.items():
        if fname not in own_field_names:
            continue  # inherited from a base interface -> skip (provided by `extends`)
        desc = fld.description
        inner, required, is_list = _unwrap(fld.annotation)
        name = fld.alias or fname
        # `id` is the content key that maps to $dtId — not a graph property.
        if name == "id":
            continue
        # entity collection -> Relationship edge
        if isinstance(inner, type) and issubclass(inner, M.BaseModel) and inner.__name__ in ENTITY_MODELS:
            rel_name = REL_NAME.get(fname, fname)
            edge = {
                "@type": "Relationship",
                "name": rel_name,
                "target": mid(inner.__name__),
                "description": f"Links this {model_cls.__name__} to its {inner.__name__} twin(s) (from `{fname}`).",
            }
            if rel_name in REL_PROPERTIES:
                edge["properties"] = REL_PROPERTIES[rel_name]
            contents.append(edge)
            continue
        # Person.role/note are trip-relative -> carried on the hasCrew edge, not on the node.
        # `claimed` is read-only metadata derived from the twin's model kind,
        # never a graph property. Strip all three from Person and User.
        if issubclass(model_cls, M.Person) and name in ("role", "note", "claimed"):
            continue
        # plain property (primitive / enum / inline value object)
        schema = _schema_for_scalar(inner, fld.annotation)
        # Block.items is list[Any] -> normalize to Array of inline BlockItem
        if model_cls is M.Block and fname == "items":
            schema = {"@type": "Array", "elementSchema": _block_item_schema()}
        elif is_list:
            schema = {"@type": "Array", "elementSchema": schema}
        prop = {"@type": "Property", "name": name, "schema": schema, "writable": True}
        if desc:
            prop["description"] = desc
        contents.append(prop)
    # extra synthesized relationships (e.g. Block -> Location, TripSection -> Day/Location)
    for rel_name, target in EXTRA_RELATIONSHIPS.get(model_cls.__name__, []):
        contents.append({
            "@type": "Relationship",
            "name": rel_name,
            "target": mid(target),
            "description": f"Synthesized by the converter (not a model field) — links this {model_cls.__name__} to its {target} twin(s).",
        })
    iface: dict = {
        "@context": "dtmi:dtdl:context;4",
        "@id": mid(model_cls.__name__),
        "@type": "Interface",
        "displayName": model_cls.__name__,
        "contents": contents,
    }
    if cls_doc:
        iface["description"] = cls_doc
    # User EXTENDS Person (DTDL `extends`) — a real user IS a person.
    if issubclass(model_cls, M.Person) and model_cls is not M.Person:
        iface["extends"] = mid("Person")
    # Enums are now embedded inline in each property (DTDL v4 embedded form) — no
    # `schemas` block needed, since pg-age's create_models resolver doesn't
    # resolve nested-schema *references* at model-upload time.
    return iface


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="assert byte-stable output")
    args = ap.parse_args()

    out: list[dict] = []

    # 1) entities (twins) — Interfaces. Each inlines the Enum/Object schemas it
    #    references in its own `schemas` block (DTDL: a schema is only referenceable
    #    from the same Interface that defines it).
    for cls in (M.Trip, M.Day, M.Block, M.Location, M.Person, M.User, M.Feature, M.TripSection):
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
