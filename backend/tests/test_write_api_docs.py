"""`docs/write-api.md` is generated from the code that enforces it (#255).

The whole point of the doc is that an agent can trust it without re-deriving the
schema from 422s. A hand-written doc drifts the first time a field changes, so
this test regenerates it and compares: update the doc with

    python scripts/gen_write_api_docs.py

and this test says so when you forget.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
GENERATOR = BACKEND / "scripts" / "gen_write_api_docs.py"
DOC = BACKEND.parent / "docs" / "write-api.md"


@pytest.fixture(scope="module")
def generator():
    spec = importlib.util.spec_from_file_location("gen_write_api_docs", GENERATOR)
    assert spec and spec.loader, f"cannot load {GENERATOR}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_doc_is_current(generator):
    """The committed doc is exactly what the code generates today."""
    rendered, problems = generator.render()

    assert not problems, "the generated doc reports problems of its own:\n  " + "\n  ".join(problems)
    assert DOC.exists(), f"{DOC} is missing — run: python scripts/gen_write_api_docs.py"
    assert DOC.read_text(encoding="utf-8") == rendered, (
        f"{DOC} is stale — run: python scripts/gen_write_api_docs.py"
    )


def test_the_example_gate_has_teeth(generator):
    """A doc example the write models reject must fail the generator, not ship.

    The gate is `_render_examples`, which runs the canonical payloads through the
    same `validate_plan` a real `fill` runs. Here it is handed a validator that
    rejects everything: if the gate stopped reporting, this would go green and a
    bad example could reach the doc.
    """
    sys.path.insert(0, str(BACKEND / "scripts"))
    import types

    import api_write  # noqa: PLC0415 — the generator imports it the same way

    # the real module with one method swapped: everything the renderer reads
    # (PLAN_KEYS, BLOCK_KINDS, KIND_ONLY_FIELDS, normalize_plan …) stays genuine,
    # so this test fails for exactly one reason — the gate stopped reporting.
    ns = {k: v for k, v in vars(api_write).items() if not k.startswith("__")}
    ns["validate_plan"] = lambda plan, existing=None, *a, **kw: (
        ["days[0].blocks[0]: extra_forbidden body.mode"],
        [],
    )
    rejecting = types.SimpleNamespace(**ns)

    _, problems = generator._render_examples(rejecting)

    assert any("example no longer validates" in p for p in problems)


def test_no_example_problem_of_any_kind(generator):
    """The payloads in the doc are asserted against the write models, not illustrated."""
    _, problems = generator.render()

    assert problems == []


def test_the_schema_covers_the_write_models_the_agent_needs(generator):
    """The four models behind every trip build are in the doc, not just the routes."""
    rendered, _ = generator.render()

    for model in ("DayCreate", "DayPatch", "BlockCreate", "BlockFields"):
        assert f"### `{model}`" in rendered, f"{model} is missing from {DOC.name}"
    # the two traps that cost the #255 run a script each
    assert "`DayCreate`" in rendered and "extra" in rendered.lower()
    assert "transport" in rendered and "distance" in rendered


def test_every_json_example_in_the_doc_parses(generator):
    """A fenced example with an ellipsis in it is a copy-paste trap, not documentation."""
    rendered, _ = generator.render()

    fence: list[str] = []
    inside = False
    examples = 0
    for line in rendered.splitlines():
        if line.startswith("```"):
            if inside and fence and fence[0].strip().startswith(("{", "[")):
                json.loads("\n".join(fence))
                examples += 1
            fence, inside = [], not inside
            continue
        if inside:
            fence.append(line)

    assert examples, "no JSON example in the doc parsed at all"
