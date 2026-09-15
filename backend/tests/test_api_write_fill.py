"""`fill` verb — client-side plan validation + call planning (issue #160 spirit).

The bulk-fill verb exists because filling one trip through the per-object verbs
cost ~108 wrapper invocations and hit 8 client-fixable 422s (a top-level PUT
carrying `days`, an invented block `kind`, `cost` as a currency string,
days-after-sections). Those checks now live client-side, so they are unit
testable without a server: `validate_plan` and `plan_calls` are pure.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import urllib.parse
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


def test_practical_blocks_travel_in_the_practical_put():
    """#254: the roadbook recipe's titled practicalities reach the server in the
    practical PUT body — the same call that already carries todos and contacts.
    The headings are the roadbook's own, in order."""
    plan = _valid_plan()
    plan["practical"] = {
        "todos": [{"label": "Book the capsule hotel"}],
        "blocks": [
            {"title": "Driving times", "body": "San José → Tortuguero: 3 h 30 + 1 h 30 boat"},
            {"title": "Money & tipping", "body": "10 % service charge; cash at the SINAC gates"},
            {"title": "Water & health", "body": "Tap water is fine; repellent on the Caribbean coast"},
        ],
    }
    errors, warnings = aw.validate_plan(plan, EXISTING)
    assert errors == [] and warnings == []
    calls = aw.plan_calls(plan, TRIP_ID, EXISTING)
    body = next(b for m, p, b in calls if p == f"/api/trips/{TRIP_ID}/practical")
    assert [b["title"] for b in body["blocks"]] == ["Driving times", "Money & tipping", "Water & health"]


def test_unknown_practical_key_is_still_rejected():
    """Adding `blocks` must not open `practical` to arbitrary keys — a roadbook
    recipe that invents one gets told before any write happens."""
    plan = _valid_plan()
    plan["practical"] = {"blocks": [{"title": "x", "body": "y"}], "notesBlocks": []}
    errors, _ = aw.validate_plan(plan, EXISTING)
    assert any("`practical` keys not accepted" in e and "notesBlocks" in e for e in errors)


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


def test_bare_name_from_media_and_inbox_urls():
    """The value a media field stores — from either returned URL shape."""
    assert aw._bare_name("/media/abc-123/hash.jpg") == "hash.jpg"
    assert aw._bare_name("/inbox/hash.jpg") == "hash.jpg"
    assert aw._bare_name("/media/abc-123/hash.jpg/") == "hash.jpg"


def test_multipart_body_is_well_formed(tmp_path):
    """Stdlib multipart: fields, filename, guessed content type, closing boundary."""
    img = tmp_path / "cover.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0jpegbytes")
    payload, content_type = aw._multipart({"trip_id": "trip-1"}, "file", str(img))
    assert content_type.startswith("multipart/form-data; boundary=")
    assert b'name="trip_id"' in payload and b"trip-1" in payload
    assert b'name="file"; filename="cover.jpg"' in payload
    assert b"Content-Type: image/jpeg" in payload
    assert b"jpegbytes" in payload
    assert payload.endswith(b"--\r\n")


def test_cli_advertises_upload_and_promote():
    """The agent can only move an image if a verb can carry its minted token."""
    out = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, timeout=30
    ).stdout
    assert "upload <local-file>" in out or "upload" in out
    assert "promote" in out
    assert "--trip-id" in out


def test_every_planned_path_is_an_absolute_api_path():
    for method, path, _ in aw.plan_calls(_valid_plan(), TRIP_ID, EXISTING):
        assert path.startswith("/api/"), f"{method} {path} is not an absolute API path"


# --------------------------------------------- dry-run block pass (#242)

def test_block_intents_carry_the_pass_that_runs_after_the_re_get():
    """Blocks are planned apart from `plan_calls`: their container id only lands
    at the re-GET, so a plan's block step is invisible unless it is planned here."""
    plan = _valid_plan()
    plan["sections"].append({"title": "Ideation", "blocks": [{"kind": "note", "title": "Maybe"}]})
    intents = aw.block_intents(plan, EXISTING)
    # every block of every container, days first (plan_calls' order)
    assert [container for container, _, _ in intents] == ["day", "day", "day", "section"]
    containers = {label: body["container"] for _, label, body in intents}
    # a day that already exists is written into by its real id …
    assert containers["2027-09-20"] == {"type": "day", "id": "day-1"}
    assert containers["2027-09-21"] == {"type": "day", "id": "day-2"}
    # … a container this plan creates has none yet (the live run errors, dry-run prints `<new …>`)
    assert containers["Ideation"] == {"type": "section", "id": None}
    # the payload is the block itself — never a `blocks` array on the day body
    for _, _, body in intents:
        assert "blocks" not in body
        assert body["kind"] in aw.BLOCK_KINDS


def test_dry_run_lists_the_block_pass(monkeypatch, capsys, tmp_path):
    """#242: `--dry-run` printed only the pre-block calls, so a plan carrying
    blocks read as "my block step vanished" and cost a re-check."""
    plan = _valid_plan()
    plan["days"].append({"date": "2027-09-22", "title": "New day", "blocks": [{"kind": "activity", "title": "x"}]})
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")
    monkeypatch.setattr(aw, "_server_base", lambda *a, **k: EXISTING)
    monkeypatch.setattr(
        sys,
        "argv",
        ["api_write.py", "fill", TRIP_ID, "--file", str(plan_file), "--dry-run", "--token", "t"],
    )
    assert aw.main() == 0
    out = capsys.readouterr().out
    assert "4 block write(s)" in out  # 2 + 1 day blocks + 1 new day block
    assert "block pass — runs AFTER the re-GET" in out
    assert out.count(f"/api/trips/{TRIP_ID}/blocks") == 4
    # a day that does not exist yet is shown as intent, not hidden
    assert "<new day 2027-09-22>" in out
    # the venue pass that follows the writes is named too
    assert "venue-resolution pass" in out


def test_dry_run_is_honest_about_a_plan_without_blocks(monkeypatch, capsys, tmp_path):
    """No blocks → no empty heading, and the count still says what will run."""
    plan = _valid_plan()
    for day in plan["days"]:
        day.pop("blocks", None)
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")
    monkeypatch.setattr(aw, "_server_base", lambda *a, **k: EXISTING)
    monkeypatch.setattr(
        sys,
        "argv",
        ["api_write.py", "fill", TRIP_ID, "--file", str(plan_file), "--dry-run", "--no-resolve",
         "--token", "t"],
    )
    assert aw.main() == 0
    out = capsys.readouterr().out
    assert "0 block write(s)" in out
    assert "block pass" not in out
    assert "venue-resolution pass" not in out  # --no-resolve skips it


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


# ------------------------------------------------- media + venues (#187)

def _media_errors(plan: dict) -> list[str]:
    errors, _ = aw.validate_plan(plan, EXISTING)
    return [e for e in errors if "web URL" in e]


def test_plan_media_urls_are_rejected_client_side():
    """A hotlinked media value fails the plan (and therefore `--dry-run`)
    instead of reaching the server, which refuses it with a 422 (#187)."""
    plan = _valid_plan()
    plan["scalars"]["cover"] = "https://images.unsplash.com/photo-1503899036084?w=1280&q=80"
    plan["days"][0]["blocks"][0]["images"] = ["https://x.test/i.jpg"]

    errors = _media_errors(plan)
    assert any("plan.scalars.cover is a web URL" in e for e in errors)
    assert any(".images is a web URL" in e for e in errors)
    # the guidance names the verb that produces a usable value
    assert any("photo" in e for e in errors)


def test_plan_media_fields_accept_bare_filenames():
    plan = _valid_plan()
    plan["scalars"]["cover"] = "c383ce57deadbeef1234abcd.jpg"
    plan["days"][0]["blocks"][0]["images"] = ["0f1e2d3c4b5a69788796a5b4.jpg"]
    assert _media_errors(plan) == []


def test_plan_links_are_never_gated_as_media():
    """`links` carry real URLs — only the media fields are filenames."""
    plan = _valid_plan()
    plan["days"][0]["blocks"][0]["links"] = [{"label": "site", "url": "https://example.com/x"}]
    assert _media_errors(plan) == []


def test_plan_location_photo_url_is_not_gated():
    """`photo` is a documented external-URL field (#95) — the walker must leave
    it alone while still guarding the booklet media fields."""
    plan = _valid_plan()
    plan["locations"][0]["photo"] = "https://upload.wikimedia.org/x.jpg"
    assert _media_errors(plan) == []


def test_commons_candidates_keep_only_reusable_images(monkeypatch):
    """Licence + kind + size gate on the Commons search: NC/ND, non-images and
    thumbnails are skipped, and the artist HTML is flattened for the credit."""
    payload = {
        "query": {
            "pages": {
                "1": {"title": "File:Good.jpg", "imageinfo": [{
                    "mime": "image/jpeg", "width": 1600, "height": 900,
                    "thumburl": "https://upload/x.jpg",
                    "extmetadata": {
                        "LicenseShortName": {"value": "CC BY-SA 4.0"},
                        "Artist": {"value": "<a href='#'>Someone</a>"},
                    }}]},
                "2": {"title": "File:NonCommercial.jpg", "imageinfo": [{
                    "mime": "image/jpeg", "width": 1600, "height": 900,
                    "url": "https://upload/nc.jpg",
                    "extmetadata": {"LicenseShortName": {"value": "CC BY-NC 4.0"}}}]},
                "3": {"title": "File:Doc.pdf", "imageinfo": [{
                    "mime": "application/pdf", "width": 1600, "height": 900,
                    "url": "https://upload/p.pdf",
                    "extmetadata": {"LicenseShortName": {"value": "CC0"}}}]},
                "4": {"title": "File:Tiny.jpg", "imageinfo": [{
                    "mime": "image/jpeg", "width": 320, "height": 240,
                    "url": "https://upload/s.jpg",
                    "extmetadata": {"LicenseShortName": {"value": "Public domain"}}}]},
            }
        }
    }

    class _Resp:
        def read(self):
            return json.dumps(payload).encode()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(aw.urllib.request, "urlopen", lambda *a, **k: _Resp())
    out = aw._commons_candidates("shinjuku gyoen")
    assert [c["title"] for c in out] == ["Good.jpg"]
    assert out[0]["artist"] == "Someone"
    assert out[0]["license"] == "CC BY-SA 4.0"
    assert out[0]["sourceUrl"].startswith("https://commons.wikimedia.org/wiki/")


def test_photo_upload_with_a_local_file_prints_a_bare_name(monkeypatch, tmp_path, capsys):
    img = tmp_path / "mine.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0jpegbytes")
    seen = {}

    def fake_request(method, base, path, token, body=None, raw=None):
        assert path == "/api/files", path
        seen["raw"] = raw
        return 200, {"url": f"/media/{TRIP_ID}/abc123def456.jpg"}

    monkeypatch.setattr(aw, "_request", fake_request)
    args = argparse.Namespace(
        base="http://x", token="t", trip_id=TRIP_ID, file=str(img), path=None,
        index=0, license="CC0", credit="Someone", source_url="https://src/x",
    )
    assert aw.fetch_photo(args) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["field_value"] == "abc123def456.jpg"  # bare name, never the URL
    assert payload["credit"] == "Someone" and payload["license"] == "CC0"
    assert seen["raw"][1].startswith("multipart/form-data")


def test_resolve_trip_places_pins_locations_and_blocks(monkeypatch):
    """The resolution pass is what kills the generic city links: registry names
    get their place_id + coordinates, blocks copy or resolve a venue key, and
    anything without a venue is REPORTED rather than silently left generic."""
    trip = {
        "id": TRIP_ID,
        "title": "Urban Legends",
        "locations": [{"name": "Tokyo"}, {"name": "Shinjuku Gyoen"}],
        "days": [{
            "id": "day-1",
            "date": "2027-09-20",
            "blocks": [
                {"id": "blk-1", "kind": "activity", "title": "Garden stroll",
                 "location": "Shinjuku Gyoen"},
                {"id": "blk-2", "kind": "activity", "title": "Ramen", "location": "Tokyo"},
                {"id": "blk-3", "kind": "note", "title": "a note"},
                {"id": "blk-4", "kind": "activity", "title": "Mystery bar"},
            ],
        }],
        "sections": [],
    }
    state = {"patched": [], "blocks": [], "queries": []}

    def fake_request(method, base, path, token, body=None, raw=None):
        if method == "get" and path.startswith("/api/places/search"):
            params = urllib.parse.parse_qs(path.split("?", 1)[1])
            state["queries"].append(params)
            q = params["q"][0]
            return 200, {"available": True, "placeId": f"ChIJ-{q}", "lat": 35.0, "lng": 139.0,
                         "name": q, "address": f"{q}, Japan"}
        if method == "patch" and path.endswith("/locations"):
            state["patched"].append(body)
            for entry in body["locations"]:
                for loc in trip["locations"]:
                    if loc["name"] == entry["name"]:
                        loc.update(entry)
            return 200, trip
        if method == "put" and "/blocks/" in path:
            state["blocks"].append((path, body))
            return 200, trip
        raise AssertionError(f"unexpected {method} {path}")

    monkeypatch.setattr(aw, "_request", fake_request)
    monkeypatch.setattr(aw, "_server_base", lambda trip_id, base, token: trip)

    report = aw.resolve_trip_places(TRIP_ID, "http://x", "tok")

    assert {entry["name"] for entry in report["locations_resolved"]} == {"Tokyo", "Shinjuku Gyoen"}
    assert state["patched"][0]["locations"][0]["placeId"] == "ChIJ-Tokyo"
    # #255: the first lookup has nothing to bias toward; the second rides the
    # coordinates the first one just placed, so a namesake loses to the trip.
    assert "lat" not in state["queries"][0]
    assert float(state["queries"][1]["lat"][0]) == 35.0
    assert float(state["queries"][1]["lng"][0]) == 139.0
    assert state["queries"][1]["radius"] == ["200000"]
    # both resolve from the registry entry their `location` points at
    assert report["blocks_resolved"] == 2
    assert {path.rsplit("/", 1)[-1] for path, _ in state["blocks"]} == {"blk-1", "blk-2"}
    assert all(body["placeId"] for _, body in state["blocks"])
    # blk-4 names no venue at all — reported, not silently skipped
    assert [b["title"] for b in report["blocks_without_venue"]] == ["Mystery bar"]
    # a note block is not a venue and is never flagged
    assert "a note" not in [b["title"] for b in report["blocks_without_venue"]]


def test_resolve_places_verb_needs_a_trip_id():
    out = subprocess.run(
        [sys.executable, str(SCRIPT), "--base", "http://127.0.0.1:9", "resolve-places"],
        capture_output=True,
        text=True,
        timeout=30,
        env={"KISEKI_TOKEN": "test-dummy-token", "PATH": "/usr/bin:/bin"},
    )
    assert out.returncode != 0
    assert "trip id" in out.stderr


def test_photo_verb_needs_a_trip_id():
    out = subprocess.run(
        [sys.executable, str(SCRIPT), "--base", "http://127.0.0.1:9", "photo", "tokyo"],
        capture_output=True,
        text=True,
        timeout=30,
        env={"KISEKI_TOKEN": "test-dummy-token", "PATH": "/usr/bin:/bin"},
    )
    assert out.returncode != 0
    assert "--trip-id" in out.stderr


# ---------------------------------------------------------------------------
# #255 — cost per build. Each test here pins one thing that used to be a
# throwaway script written mid-run: strip_empty.py, split_days.py, fix_places.py.
# ---------------------------------------------------------------------------


def _get_shaped_block(**overrides) -> dict:
    """A block exactly as `GET /api/trips/<id>` hands it back: every key, defaults in."""
    block = {
        "kind": "meal",
        "title": "Yatai lunch",
        "time": "13:00",
        "location": "Fukuoka",
        "cost": 18.0,
        "currency": "EUR",
        "description": None,
        "links": [],
        "items": [],
        "images": [],
        "status": None,
        "bookingCode": None,
        "html": None,
        "distance": None,
        "duration": None,
        "route": None,
        "via": None,
        "from": None,
        "to": None,
        "mode": None,
        "placeId": None,
    }
    block.update(overrides)
    return block


def test_normalize_plan_strips_what_the_write_model_would_422_on():
    """A plan grown from a GET carries every BlockFields key with its default.

    The server validates on presence, so `items: []` on a meal and `mode: null`
    on a lunch are both 422s. That is what strip_empty.py was written for in the
    #255 run; the filler does it now, before the first call.
    """
    plan = {"days": [{"date": "2027-04-02", "blocks": [_get_shaped_block()]}]}

    normalized, notes = aw.normalize_plan(plan)

    assert normalized["days"][0]["blocks"][0] == {
        "kind": "meal",
        "title": "Yatai lunch",
        "time": "13:00",
        "location": "Fukuoka",
        "cost": 18.0,
        "currency": "EUR",
    }
    assert any("empty field(s)" in note for note in notes)
    # the caller's plan is not mutated — a dry run must not change the input
    assert plan["days"][0]["blocks"][0]["items"] == []


def test_normalize_plan_keeps_a_transport_block_intact():
    """The fields transport needs survive: only the *other* kind's keys are dropped."""
    plan = {
        "days": [
            {
                "date": "2027-04-02",
                "blocks": [
                    {
                        "kind": "transport",
                        "title": "AMS → FUK",
                        "from": "Amsterdam",
                        "to": "Fukuoka",
                        "mode": "flight",
                        "distance": "9,200 km",
                        "duration": "13 h",
                        "via": ["Helsinki"],
                        "items": [],  # ← still empty, still dropped
                    }
                ],
            }
        ]
    }

    normalized, _ = aw.normalize_plan(plan)

    assert normalized["days"][0]["blocks"][0] == {
        "kind": "transport",
        "title": "AMS → FUK",
        "from": "Amsterdam",
        "to": "Fukuoka",
        "mode": "flight",
        "distance": "9,200 km",
        "duration": "13 h",
        "via": ["Helsinki"],
    }


def test_nested_empty_values_are_dropped_too():
    """`{"links": [{"url": "", "label": "x"}]}` is a 422 on the inner key."""
    plan = {
        "days": [
            {
                "date": "2027-04-02",
                "notes": {"tips": [], "blurb": "Bring cash.", "tags": ["food"]},
                "blocks": [{"kind": "note", "title": "x", "links": [{"url": "", "label": "Menu"}]}],
            }
        ]
    }

    normalized, _ = aw.normalize_plan(plan)

    day = normalized["days"][0]
    assert day["notes"] == {"blurb": "Bring cash.", "tags": ["food"]}
    assert day["blocks"][0]["links"] == [{"label": "Menu"}]


def test_validate_still_refuses_a_real_transport_field_on_a_lunch():
    """Normalizing drops *empty* leftovers; a value the author typed is an error.

    `mode: "car"` on a meal is a mistake about the itinerary, not GET noise, so
    it stays a pre-flight failure (and names the block) instead of vanishing.
    """
    plan = {"days": [{"date": "2027-04-02", "blocks": [{"kind": "meal", "title": "Lunch", "mode": "car"}]}]}

    errors, _ = aw.validate_plan(plan, None)

    assert any("mode" in err and "days[0].blocks[0]" in err for err in errors)


def test_validate_names_an_unknown_day_field():
    """`day["summary"]` is not a DayFields key — said before the write, not by a 422."""
    plan = {"days": [{"date": "2027-04-02", "title": "Day", "summary": "a day"}]}

    errors, _ = aw.validate_plan(plan, None)

    assert any("summary" in err for err in errors)


def test_plan_calls_post_days_sends_only_what_daycreate_accepts():
    """POST /days takes index/date/title. `notes`/`map`/`meta` on it is a 422."""
    plan = {
        "days": [
            {
                "date": "2027-09-22",
                "title": "Playa",
                "notes": "Pack goggles.",
                "meta": {"sunset": "18:40"},
            }
        ]
    }

    calls = aw.plan_calls(plan, TRIP_ID, EXISTING)

    creates = [body for method, path, body in calls if method == "post" and path.endswith("/days")]
    assert creates == [{"date": "2027-09-22", "title": "Playa"}]


def test_day_extra_bodies_carry_what_the_create_could_not():
    """The follow-up PUT the filler owes a NEW day, and nothing for an existing one."""
    plan = {"days": [{"date": "2027-09-22", "title": "Playa", "notes": "Pack goggles."}]}

    new = aw.day_extra_bodies(plan, {"id": TRIP_ID, "days": []})
    assert new == [("2027-09-22", {"notes": "Pack goggles."})]

    # a day the plan matched to a live id gets its whole body in plan_calls
    existing_day = {"id": TRIP_ID, "days": [{"id": "day-1", "date": "2027-09-20"}]}
    plan_with_id = {"days": [{"id": "day-1", "date": "2027-09-20", "notes": "keep"}]}
    assert aw.day_extra_bodies(plan_with_id, existing_day) == []


def test_fill_lands_the_day_notes_after_the_create(monkeypatch, capsys, tmp_path):
    """End to end: the notes arrive in a second call, without the agent noticing."""
    plan = {"days": [{"date": "2027-09-22", "title": "Playa", "notes": "Pack goggles."}]}
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")

    calls: list[tuple[str, str, dict]] = []
    live: dict = {"id": TRIP_ID, "days": [], "sections": [], "locations": []}

    def fake_request(method, base, path, token, body=None, raw=None):
        calls.append((method, path, body or {}))
        if method == "post" and path.endswith("/days"):
            live["days"].append({"id": "day-new", "blocks": [], **(body or {})})
            return 200, live
        if method in ("put", "patch"):
            return 200, live
        raise AssertionError(f"unexpected {method} {path}")

    monkeypatch.setattr(aw, "_request", fake_request)
    monkeypatch.setattr(aw, "_server_base", lambda *a, **k: json.loads(json.dumps(live)))
    monkeypatch.setattr(
        sys,
        "argv",
        ["api_write.py", "fill", TRIP_ID, "--file", str(plan_file), "--no-resolve", "--token", "t"],
    )

    assert aw.main() == 0

    create_at = next(i for i, c in enumerate(calls) if c[0] == "post")
    assert calls[create_at][2] == {"date": "2027-09-22", "title": "Playa"}  # no notes
    follow = [c for c in calls if "/days/day-new" in c[1]]
    assert follow == [("put", f"/api/trips/{TRIP_ID}/days/day-new", {"notes": "Pack goggles."})]
    assert create_at < next(i for i, c in enumerate(calls) if "/days/day-new" in c[1])
    assert "notes/map/meta for 2027-09-22" in capsys.readouterr().err


def test_dry_run_lists_the_day_notes_pass(monkeypatch, capsys, tmp_path):
    """A dry run has to admit the extra call, or the plan reads as one call per day."""
    plan = {"days": [{"date": "2027-09-22", "title": "Playa", "notes": "Pack goggles."}]}
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")
    monkeypatch.setattr(aw, "_server_base", lambda *a, **k: EXISTING)
    monkeypatch.setattr(
        sys,
        "argv",
        ["api_write.py", "fill", TRIP_ID, "--file", str(plan_file), "--dry-run", "--no-resolve",
         "--token", "t"],
    )

    assert aw.main() == 0

    out = capsys.readouterr().out
    assert "1 day-notes patch(es)" in out
    assert "day-notes pass — POST /days takes index/date/title ONLY" in out
    assert "<new day 2027-09-22>" in out


def test_dry_run_rejects_the_plan_instead_of_writing_half_of_it(monkeypatch, capsys, tmp_path):
    """A plan error stops at nothing-written, with every error listed."""
    plan = {"days": [{"date": "2027-09-20", "blocks": [{"kind": "meal", "title": "Lunch", "mode": "car"}]}]}
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")
    monkeypatch.setattr(aw, "_server_base", lambda *a, **k: EXISTING)
    monkeypatch.setattr(
        sys,
        "argv",
        ["api_write.py", "fill", TRIP_ID, "--file", str(plan_file), "--token", "t"],
    )

    assert aw.main() == 2

    err = capsys.readouterr().err
    assert "plan rejected before any write:" in err
    assert "mode" in err


def test_resolve_places_biases_by_the_trip_and_reports_a_namesake(monkeypatch):
    """#255 → fix_places.py: the same venue name exists in several countries."""
    trip = {
        "id": TRIP_ID,
        "locations": [
            {"name": "San José", "placeId": "P-SJ-CITY", "lat": 9.93, "lng": -84.08},
            {"name": "Hotel Presidente"},   # Madrid's is 8,500 km away
            {"name": "Café Central"},       # only ever resolves to Vienna's
            {"name": "A remote island"},    # resolves to nothing at all
        ],
        "days": [],
        "sections": [],
    }
    seen: list[dict] = []

    def fake_request(method, base, path, token, body=None, raw=None):
        if method == "get" and path.startswith("/api/places/search"):
            params = urllib.parse.parse_qs(path.split("?", 1)[1])
            seen.append(params)
            q = params["q"][0]
            if q == "Hotel Presidente":
                if "lat" in params:  # biased → the Costa Rican one
                    return 200, {"available": True, "placeId": "P-SJ-HOTEL", "lat": 9.94, "lng": -84.09,
                                 "name": "Hotel Presidente", "address": "San José, Costa Rica"}
                return 200, {"available": True, "placeId": "P-MADRID", "lat": 40.42, "lng": -3.70,
                             "name": "Hotel Presidente", "address": "Madrid, Spain"}
            if q == "Café Central":
                return 200, {"available": True, "placeId": "P-VIENNA", "lat": 48.21, "lng": 16.37,
                             "name": "Café Central", "address": "Vienna, Austria"}
            return 200, {"available": False}
        if method == "patch" and path.endswith("/locations"):
            return 200, trip
        raise AssertionError(f"unexpected {method} {path}")

    monkeypatch.setattr(aw, "_request", fake_request)
    monkeypatch.setattr(aw, "_server_base", lambda *a, **k: trip)

    report = aw.resolve_trip_places(TRIP_ID, "http://x", "tok")

    # the trip's own coordinates are known before the first lookup, so no
    # namesake-prone lookup ever went out unbiased
    by_name: dict[str, list[dict]] = {}
    for params in seen:
        by_name.setdefault(params["q"][0], []).append(params)

    assert all("lat" in lookups[0] for lookups in by_name.values())
    assert by_name["Hotel Presidente"][0]["lat"] == ["9.93000"]
    assert by_name["Hotel Presidente"][0]["radius"] == ["200000"]
    # a look that comes back empty is retried once without the bias, so a venue
    # genuinely somewhere else still gets an answer — and is reported as off-trip
    assert by_name["A remote island"][-1] == {"q": ["A remote island"]}
    resolved = {entry["name"]: entry["placeId"] for entry in report["locations_resolved"]}
    assert resolved["Hotel Presidente"] == "P-SJ-HOTEL"  # not Madrid
    assert resolved["Café Central"] == "P-VIENNA"        # resolvable, but wrong country
    assert "San José" not in resolved                    # already pinned: untouched
    assert [entry["name"] for entry in report["locations_off_trip"]] == ["Café Central"]
    off = report["locations_off_trip"][0]
    assert off["km_from_trip"] > 5000
    # everything the CLI's "resolved OUTSIDE the trip's own area (a namesake?)"
    # warning needs — the resolution is reported, never silently pinned
    assert off["matched"] == "Café Central" and off["address"] == "Vienna, Austria"
    assert report["locations_unresolved"] == ["A remote island"]
