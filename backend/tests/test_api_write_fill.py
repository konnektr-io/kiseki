"""`fill` verb — client-side plan validation + call planning (issue #160 spirit).

The bulk-fill verb exists because filling one trip through the per-object verbs
cost ~108 wrapper invocations and hit 8 client-fixable 422s (a top-level PUT
carrying `days`, an invented block `kind`, `cost` as a currency string,
days-after-sections). Those checks now live client-side, so they are unit
testable without a server: `validate_plan` and `plan_calls` are pure.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "api_write.py"


def _module():
    spec = importlib.util.spec_from_file_location("api_write_under_test", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


aw = _module()

TRIP_ID = "11111111-1111-4111-8111-111111111111"

EXISTING = {
    "id": TRIP_ID,
    "title": "Urban Legends",
    "days": [
        {"id": "day-1", "date": "2027-09-20", "blocks": []},
        {"id": "day-2", "date": "2027-09-21", "blocks": []},
    ],
    "locations": [{"name": "Tokyo", "alias": ["Tōkyō"]}],
    "sections": [],
}


def _valid_plan() -> dict:
    return {
        "scalars": {"stage": "planned", "summary": "Neon, ghosts, tunnels.", "coverStats": ["10 days"]},
        "locations": [{"name": "Tokyo", "alias": ["Tōkyō"], "lat": 35.6762, "lng": 139.6503}],
        "features": [{"title": "Neon Tokyo", "kicker": "centerpiece", "description": "…"}],
        "days": [
            {
                "date": "2027-09-20",
                "title": "Arrival",
                "blocks": [
                    {"kind": "activity", "title": "Late ramen", "time": "22:30", "cost": 1500, "currency": "JPY"},
                    {"kind": "transport", "title": "Narita → Tokyo", "from": "Tokyo", "to": "Tokyo", "mode": "train"},
                ],
            },
            {"date": "2027-09-21", "title": "Shinjuku", "blocks": [{"kind": "activity", "title": "Golden Gai"}]},
        ],
        "sections": [{"title": "Neon Tokyo", "days": [0, 1], "locationRefs": ["Tokyo"]}],
        "practical": {"todos": [{"label": "Book the capsule hotel"}]},
        "crew": [{"name": "Niko", "role": "owner"}],
    }


def test_valid_plan_has_no_errors():
    errors, warnings = aw.validate_plan(_valid_plan(), EXISTING)
    assert errors == []
    assert warnings == []


def test_unknown_top_level_key_is_rejected():
    plan = _valid_plan() | {"dayz": []}
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("unknown plan keys" in e for e in errors)


def test_scalars_outside_trippatch_are_rejected_before_any_write():
    """The exact 422 the live run hit: `days` (and friends) in the trip PUT."""
    plan = _valid_plan()
    plan["scalars"] = {"stage": "planned", "days": [{"date": "2027-09-20"}]}
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("not accepted by PUT /api/trips" in e and "days" in e for e in errors)


def test_invented_block_kind_is_rejected():
    plan = _valid_plan()
    plan["days"][0]["blocks"] = [{"kind": "markdown", "content": "# hi"}]
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("not a block kind" in e for e in errors)


def test_cost_as_currency_string_is_rejected():
    plan = _valid_plan()
    plan["days"][0]["blocks"] = [{"kind": "activity", "title": "Ramen", "cost": "¥1,500"}]
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("cost must be a NUMBER" in e for e in errors)


def test_server_managed_fields_are_rejected():
    plan = _valid_plan()
    plan["days"][0]["blocks"] = [
        {"kind": "activity", "title": "x", "order": 3, "container": {"type": "day", "id": "day-1"}}
    ]
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("order is server-managed" in e for e in errors)
    assert any("container is derived" in e for e in errors)


def test_section_range_out_of_bounds_is_rejected():
    plan = _valid_plan()
    plan["sections"] = [{"title": "Too far", "days": [0, 9]}]
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("out of range" in e for e in errors)


def test_overlapping_sections_are_rejected():
    plan = _valid_plan()
    plan["sections"] = [
        {"title": "A", "days": [0, 1]},
        {"title": "B", "days": [1, 1]},
    ]
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("overlaps" in e for e in errors)


def test_ideation_section_needs_no_range():
    plan = _valid_plan()
    plan["sections"] = [{"title": "Ideas", "locationRefs": []}]
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert not any("days" in e for e in errors)


def test_inverted_section_range_is_rejected():
    plan = _valid_plan()
    plan["sections"] = [{"title": "Backwards", "days": [3, 1]}]
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("inverted" in e for e in errors)


def test_transport_warnings_catch_the_silent_no_op_class():
    plan = _valid_plan()
    plan["days"][0]["blocks"] = [
        {"kind": "transport", "title": "Flight", "from": "Narita", "to": "Tōkyō"}
    ]
    errors, warnings = aw.validate_plan(plan, EXISTING)
    assert errors == []
    assert any("without `mode`" in w for w in warnings)
    assert any("'Narita' matches no location" in w for w in warnings)
    # Tōkyō is an ALIAS of Tokyo, so that endpoint resolves
    assert not any("'Tōkyō' matches no location" in w for w in warnings)


def test_day_without_blocks_is_warned():
    plan = _valid_plan()
    plan["days"].append({"date": "2027-09-22", "title": "Empty day"})
    _, warnings = aw.validate_plan(plan, EXISTING)
    assert any("has no blocks" in w for w in warnings)


def test_plan_calls_run_in_the_canonical_order():
    plan = _valid_plan()
    plan["days"].append({"date": "2027-09-22", "title": "New day", "blocks": [{"kind": "activity", "title": "x"}]})
    calls = aw.plan_calls(plan, TRIP_ID, EXISTING)
    paths = [f"{m.upper()} {p}" for m, p, _ in calls]
    assert paths[0] == f"PUT /api/trips/{TRIP_ID}"
    assert paths[1] == f"PUT /api/trips/{TRIP_ID}/locations"
    assert paths[2] == f"PUT /api/trips/{TRIP_ID}/features"
    assert f"PUT /api/trips/{TRIP_ID}/days/day-1" in paths  # matched by date → update
    assert f"POST /api/trips/{TRIP_ID}/days" in paths  # 2027-09-22 is new → insert
    assert f"POST /api/trips/{TRIP_ID}/sections" in paths
    assert f"PUT /api/trips/{TRIP_ID}/practical" in paths
    assert f"POST /api/trips/{TRIP_ID}/crew" in paths
    # days BEFORE sections (a section's range must be in bounds)
    assert paths.index(f"POST /api/trips/{TRIP_ID}/days") < paths.index(
        f"POST /api/trips/{TRIP_ID}/sections"
    )
    # blocks NEVER ride the day body — they are POSTed separately (server-managed order)
    day_body = next(body for m, p, body in calls if p == f"/api/trips/{TRIP_ID}/days")
    assert "blocks" not in day_body


def test_cli_advertises_fill_and_dry_run():
    out = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, timeout=30
    )
    assert out.returncode == 0
    assert "fill" in out.stdout
    assert "--dry-run" in out.stdout
    # the plan contract + the media rule live in the help the agent reads
    assert "scalars" in out.stdout and "locations" in out.stdout
    assert "blocks" in out.stdout
    assert "POST /api/files/promote" in out.stdout


def test_request_builds_base_plus_path(monkeypatch):
    """Regression: every call path is joined onto --base.

    A bare path handed to urlopen is not a URL at all — the live smoke crashed
    with `unknown url type: '/api/trips/<id>'` because the fill loop passed
    paths straight through.
    """
    seen: dict[str, str] = {}

    class _Resp:
        status = 200

        def read(self) -> bytes:
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["method"] = req.get_method()
        return _Resp()

    monkeypatch.setattr(aw.urllib.request, "urlopen", fake_urlopen)
    status, _ = aw._request("put", "https://kiseki.example/", "/api/trips/x", "tok", {"a": 1})
    assert status == 200
    assert seen["url"] == "https://kiseki.example/api/trips/x"
    assert seen["method"] == "PUT"


def test_duplicate_day_dates_are_rejected():
    """POST /days does not dedupe by date — it creates a second day (proven live)."""
    plan = _valid_plan()
    plan["days"].append({"date": "2027-09-20", "title": "Same day again"})
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("repeats date" in e for e in errors)


def test_section_overlapping_an_existing_section_is_rejected():
    """The server enforces non-overlap across ALL sections, not just this plan."""
    existing = dict(EXISTING, sections=[{"id": "sec-1", "title": "Old block", "days": [0, 1]}])
    plan = _valid_plan()
    plan["sections"] = [{"title": "Neon Tokyo", "days": [1, 1]}]
    errors, _ = aw.validate_plan(plan, existing)
    assert any("existing section 'Old block'" in e for e in errors)


def test_section_with_the_same_title_does_not_contend_with_itself():
    existing = dict(EXISTING, sections=[{"id": "sec-1", "title": "Neon Tokyo", "days": [0, 1]}])
    errors, _ = aw.validate_plan(_valid_plan(), existing)
    assert errors == []


def test_existing_section_is_updated_not_created():
    """A re-run must PUT the section it already created — POST would 422 overlap."""
    existing = dict(EXISTING, sections=[{"id": "sec-1", "title": "Neon Tokyo", "days": [0, 1]}])
    calls = aw.plan_calls(_valid_plan(), TRIP_ID, existing)
    paths = [f"{m.upper()} {p}" for m, p, _ in calls]
    assert f"PUT /api/trips/{TRIP_ID}/sections/sec-1" in paths
    assert f"POST /api/trips/{TRIP_ID}/sections" not in paths


def test_crew_already_on_the_trip_is_not_re_added():
    existing = dict(EXISTING, crew=[{"id": "c1", "name": "niko", "role": "owner"}])
    calls = aw.plan_calls(_valid_plan(), TRIP_ID, existing)
    assert not [c for c in calls if c[1].endswith("/crew")]


def test_block_update_body_drops_immutable_fields():
    """PUT /blocks/<id> 422s on `kind`/`container` — stripped on the update path."""
    create_body = {
        "kind": "activity",
        "title": "Late ramen",
        "time": "22:30",
        "cost": 1500,
        "container": {"type": "day", "id": "day-1"},
    }
    update_body = aw._block_update_body(create_body)
    assert "kind" not in update_body and "container" not in update_body
    assert update_body["title"] == "Late ramen" and update_body["cost"] == 1500


def test_every_planned_path_is_an_absolute_api_path():
    for method, path, _ in aw.plan_calls(_valid_plan(), TRIP_ID, EXISTING):
        assert path.startswith("/api/"), f"{method} {path} is not an absolute API path"


def test_fill_requires_a_trip_id():
    out = subprocess.run(
        [sys.executable, str(SCRIPT), "--base", "http://127.0.0.1:9", "fill"],
        capture_output=True,
        text=True,
        timeout=30,
        env={"KISEKI_TOKEN": "test-dummy-token", "PATH": "/usr/bin:/bin"},
    )
    assert out.returncode != 0
    assert "trip id" in out.stderr
