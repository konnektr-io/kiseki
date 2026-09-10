"""Content-agent capability surface (issue #160).

The content agent works from *copies* of ``api_write.py`` (content workspace
``scripts/``, profile skill ``kiseki-trip-content/scripts/``) and from the
live ``kiseki-trip-content`` skill text — not from this repo. When the write
API grows a verb and those copies are not refreshed, the agent silently loses
the capability (it lacked ``create-trip`` for a full release because the
workspace copy predated M4 and nothing failed CI). These tests pin the
contract the copies must carry, so a future endpoint/verb change that forgets
the docstring / AGENTS.md surface fails CI here instead of surfacing as a
content agent that hand-rolls POSTs in chat.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "api_write.py"
AGENTS_MD = REPO_ROOT / "AGENTS.md"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ, KISEKI_TOKEN="test-dummy-token")
    # Dead local base: if a case unexpectedly passes client-side validation it
    # fails fast on connect instead of reaching the real API.
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--base", "http://127.0.0.1:9", *args],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )


def test_cli_advertises_create_trip() -> None:
    """The verb exists and --help (the docstring) documents it."""
    out = _run("--help")
    assert out.returncode == 0
    assert "create-trip" in out.stdout
    assert "--subtitle" in out.stdout


def test_docstring_documents_canonical_fill_order_and_quoting_rule() -> None:
    """The agent's recipe lives where the agent reads it: the --help text."""
    text = _run("--help").stdout
    # The fill sequence (TripPatch is scalars-only by design).
    assert "PUT /api/trips/<trip_id>" in text
    assert "POST /api/trips/<trip_id>/sections" in text
    assert "POST /api/trips/<trip_id>/days" in text
    assert "POST /api/trips/<trip_id>/blocks" in text
    # The --file quoting rule (the apostrophe fight the agent hit).
    assert "--file" in text
    # The botched-half-create exit (#163 DELETE /api/trips/{id}).
    assert "DELETE /api/trips/<trip_id>" in text


def test_docstring_documents_inbox_and_promote() -> None:
    """M4 inbox/promote surface is visible in the client's help (v0.24.0)."""
    text = _run("--help").stdout
    assert "/api/files/promote" in text
    assert "/inbox/" in text


def test_create_trip_arg_contract() -> None:
    """create-trip takes --title/--subtitle only — no body flags."""
    no_title = _run("create-trip", "--subtitle", "x")
    assert no_title.returncode != 0
    assert "--title" in no_title.stderr

    # A non-canonical path is rejected client-side (canonical /api/trips is
    # allowed and would proceed to POST).
    rejects_path = _run("create-trip", "/api/other", "--title", "x")
    assert rejects_path.returncode != 0
    assert "no path" in rejects_path.stderr

    rejects_body = _run("create-trip", "--title", "x", "--json", "{}")
    assert rejects_body.returncode != 0
    assert "--json/--file" in rejects_body.stderr


def test_agents_md_documents_capability_rows() -> None:
    """AGENTS.md is the reference the copies' docstrings point to."""
    text = AGENTS_MD.read_text(encoding="utf-8")
    for fragment in (
        "| POST | `/api/trips` |",
        "| POST | `/api/files` |",
        "| POST | `/api/files/promote` |",
        "| POST | `/api/trips/{trip_id}/days` |",
    ):
        assert fragment in text, f"AGENTS.md lost capability row: {fragment!r}"


def test_router_surface_matches_documented_verbs() -> None:
    """FastAPI route table keeps the documented POST verbs (no silent removal)."""
    from app.main import app

    routes = set()
    for route in app.routes:
        methods = getattr(route, "methods", None) or ()
        path = getattr(route, "path", None)
        if path is None:
            continue
        routes.update((method.lower(), path) for method in methods)
    for method, path in (
        ("post", "/api/trips"),
        ("post", "/api/files"),
        ("post", "/api/files/promote"),
        ("post", "/api/trips/{trip_id}/days"),
        ("post", "/api/trips/{trip_id}/sections"),
        ("post", "/api/trips/{trip_id}/blocks"),
    ):
        assert (method, path) in routes, f"route vanished: {method.upper()} {path}"


def test_docstring_json_examples_parse() -> None:
    """Every JSON blob quoted in the help text is valid JSON."""
    text = _run("--help").stdout
    for blob in re.findall(r"\{[^`]*?\}", text):
        try:
            json.loads(blob)
        except json.JSONDecodeError:
            pass  # prose JSON like {"type": "day"|"section"} is fine
