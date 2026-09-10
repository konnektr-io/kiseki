#!/usr/bin/env python3
"""Kiseki content write-path client (issue #46) — the agent's one-liner.

A thin, zero-dependency HTTP client over the role-gated write API so Hermes
(and a future end-user agent profile) edits trip content without the old
workarounds (direct graph SDK PATCHes, reseeds, kubectl cp). Every command
prints the API response — for writes that is the canonical trip document
(media URLs canonicalized, claimToken absent).

**Workspace copies drift — repo wins (issue #160).** This script ships
verbatim into agent workspaces (content workspace `scripts/`, profile skill
`kiseki-trip-content/scripts/`). The repo copy is the single source of
truth: after ANY change here, re-copy to BOTH workspaces (one-way) and
`cmp`-verify — a stale workspace copy silently hides new verbs (the content
agent lacked `create-trip` for a full release for exactly this reason). The
wrapper's "Install:" note and the content skill's "Deploying scripts"
section carry the same rule.

    export KISEKI_TOKEN=<access token>              # 1. USER token (dedicated/UI profile):
                                                    #    ACL + x-user-id follow its sub.
                                                    # 2. M2M client token on the home profile:
                                                    #    acts AS Niko (KISEKI_AGENT_ACT_AS),
                                                    #    no user token needed.
                                                    # 3. M2M alone: owner fallback (unattended).
    python scripts/api_write.py get /api/trips/<trip_id>
    python scripts/api_write.py create-trip --title "Japan 2028" --subtitle "Powder"
    python scripts/api_write.py put /api/trips/<trip_id> --json '{"stage": "booked"}'
    python scripts/api_write.py post /api/trips/<trip_id>/blocks \
        --json '{"kind": "lodging", "title": "Banff Inn", \
                 "container": {"type": "day", "id": "<day-id>"}}'
    # Sections: create a chapter or move its day range (issue #89). Days are an
    # inclusive [first, last] 0-based range; ranges must not overlap another
    # section. A chapter split = trim the old range, then add the closing one:
    python scripts/api_write.py put /api/trips/<trip_id>/sections/<sec_id> --json '{"days": [12, 14]}'
    python scripts/api_write.py post /api/trips/<trip_id>/sections --json '{"title": "The way home", "days": [15, 15]}'
    python scripts/api_write.py post /api/trips/<trip_id>/practical/todos/0/toggle --json '{"done": true}'
    python scripts/api_write.py delete /api/trips/<trip_id>/blocks/<block_id>
    python scripts/api_write.py put /api/trips/<trip_id>/practical --file body.json

    # Inbox (M4): stage a file with POST /api/files (multipart, no tripId)
    # → /inbox/<sha256[:32]><ext>; promote it into a trip once it exists:
    #   python scripts/api_write.py post /api/files/promote --file promote.json
    #   # promote.json: {"trip_id": "<trip_id>", "file_name": "<hash>.jpg"}
    #   (or pipe it: echo '{"trip_id": "...", "file_name": "..."}' |
    #    python scripts/api_write.py post /api/files/promote --file -)

Endpoint reference: AGENTS.md → "Content update".

Canonical trip fill order — the agent's recipe (issue #160). TripPatch is
scalars-only (`extra=forbid`): PUT /api/trips/<id> takes title/subtitle/
summary/stage/startDate/endDate/timezone/theme/cover/coverCredit/map/
visibility/coverStats/stats and NOTHING else — locations, features, sections,
days and blocks all live behind their own nested endpoints. Build a trip in
this order:

1. create-trip --title "…" [--subtitle "…"]      POST /api/trips (201)
2. PUT /api/trips/<trip_id>                      scalars via --json/--file
   (incl. coverStats lines + stats [{label,value}] rows, issue #178)
3. PUT /api/trips/<trip_id>/locations            full-array replace
   (or PATCH …/locations for named upserts)
4. PUT /api/trips/<trip_id>/features             editorial overview cards
   (or PATCH …/features for id/title upserts — issue #178)
5. POST /api/trips/<trip_id>/days                insert/append days FIRST
6. POST /api/trips/<trip_id>/sections            chapters; a `days` range
   (+ PUT …/sections/<id> to move it)            must be in-bounds, so days
                                                 must already exist — an
   out-of-range range is a 422 ("Section days [0, 1] out of range — trip has
   0 days"). Omit `days` for a pure ideation section. Verify with a GET
   after a rejected section POST: the section twin can persist anyway.
7. POST /api/trips/<trip_id>/blocks              `order` is server-managed
   (container: {"type": "day"|"section", "id": …}) — never send it

Bulk fill — one validated plan instead of ~100 single-object calls:

    python scripts/api_write.py fill <trip_id> --file plan.json
    python scripts/api_write.py fill <trip_id> --file plan.json --dry-run

The plan carries `scalars`, `locations`, `features`, `days` (with their
`blocks`), `sections`, `practical` and `crew`; `fill` validates everything
client-side first (TripPatch scalars only, real block kinds, `cost` as a
number, section ranges in bounds and non-overlapping, transport endpoints
matching a known place) and then issues the calls in the canonical order,
ending with a re-GET summary: counts plus which days still have NO blocks.
A plan that would 422 is rejected before the first write.

Images — the pipeline the agent can actually run (no token ever hits a shell):

    python scripts/api_write.py upload ./tokyo.jpg --trip-id <trip_id>
    python scripts/api_write.py upload ./tokyo.jpg            # → inbox, then promote
    python scripts/api_write.py promote <hash>.jpg --trip-id <trip_id>

`upload` posts multipart to POST /api/files (with `trip_id`: straight into the
trip's media namespace; without: the user's inbox) and prints both the returned
URL and `field_value` — the BARE filename you write into `cover`, a block's
`images`, a feature's `image`, or a place's `photo`. `promote` moves a staged
inbox file into the trip and prints the same pair. Never write an external URL
into a media field: a hotlink renders as a broken cover in the app and cannot
be embedded in the PDF booklet.

Also: never write an external URL into a media field. Source a rights-clean
image, stage it with POST /api/files (multipart → /inbox/<sha>), promote it
with POST /api/files/promote, and store the resulting BARE filename (the
`/media/<trip_id>/<file>` route and the PDF booklet expect that shape).

Botched a half-create? DELETE /api/trips/<trip_id> (owner-only) removes the
trip and everything scoped to it — `delete /api/trips/<id>`; expect 204,
then a 404 on the second call. Never leave a stray empty trip behind
(issue #163).

Bodies with quotes/apostrophes: write the JSON to a file and pass --file
(inline shell quoting of apostrophes is the classic failure).

**Identity model (#46)**: the agent has NO identity in the graph — no User
twin, no hasCrew edge is ever provisioned. Three modes:
1. User-initiated (dedicated profile / UI chat): present the acting user's
   access token; ACL + x-user-id follow its `sub`.
2. Home (Niko) profile daily work: the M2M client token + backend
   `KISEKI_AGENT_ACT_AS` resolve the actor AS Niko — his real crew role, his
   attribution, no user token needed. Deliberately never set on the dedicated
   end-user profile.
3. Unattended changes with no linkable user: the M2M client token alone
   (`KISEKI_AGENT_CLIENT_ID`) → owner-level service principal, last resort.
Audience: `https://kiseki.konnektr.io`.

Stdlib only (urllib) so it runs anywhere, no venv needed.
"""

from __future__ import annotations

import argparse
import io
import json
import mimetypes
import os
import sys
import uuid
import urllib.error
import urllib.request

BASE_URL = os.environ.get("KISEKI_BASE_URL", "https://kiseki.konnektr.io")
TIMEOUT = 30


def _read_body(args) -> bytes | None:
    if args.method in ("get", "delete") and args.json is None and args.file is None:
        return None
    if args.json is not None:
        # JSON body given inline; a trailing newline via shell is fine, and a
        # whole-document paste (curl-style) works too.
        try:
            json.loads(args.json)
            raw = args.json
        except json.JSONDecodeError:
            raise SystemExit(f"error: --json is not valid JSON: {args.json[:80]}…")
    elif args.file is not None:
        if args.file == "-":
            raw = sys.stdin.read()
        else:
            with open(args.file, encoding="utf-8") as fh:
                raw = fh.read()
        json.loads(raw)  # fail fast on malformed files
    else:
        return None
    return raw.encode("utf-8")


# --------------------------------------------------------------- bulk fill
#
# `fill` is the answer to a measured failure mode: filling one trip through
# the per-object verbs cost ~108 wrapper invocations and hit 8 client-fixable
# 422s (top-level PUT carrying `days`, an invented block `kind`, `cost` as a
# currency string, days-after-sections). One validated plan → one ordered run
# removes the round trips AND the whole 422 class, because everything a human
# would have learned from a 422 is checked before the first write.
#
#   python scripts/api_write.py fill <trip_id> --file plan.json [--dry-run]
#
# Plan shape (every key optional; unknown keys are REJECTED client-side):
#
#   {
#     "scalars":   {stage, startDate, endDate, summary, cover, theme, coverStats,
#                   stats, …}          # TripPatch scalars only (extra=forbid)
#     "locations": [{name, marker?, alias[], lat?, lng?, placeId?, address?,
#                    website?, summary?, …}],          # full-array replace
#     "features":  [{title, kicker?, description?, image?, cards[], chips[], …}],
#     "days":      [{date, title?, notes?, meta?, index?,
#                    blocks: [{kind, title, time?, description?, cost?,
#                              duration?, from?, to?, mode?, location?, …}]}],
#     "sections":  [{title, days?: [first,last], locationRefs?: [name],
#                    blocks?: [...]}],
#     "practical": {todos[], links[], notes, contacts[]},
#     "crew":      [{name, role?, note?, contact?}]
#   }
#
# Order is fixed and load-bearing (issue #160): scalars → locations → features
# → days → sections → blocks → practical → crew. Sections range over DAYS, so
# the days must exist first.
#
# The run ends with a re-GET summary (counts + which days still have no
# blocks) instead of dumping the whole document — the agent needs the verdict,
# not 40k tokens of trip.

#: TripPatch fields — anything else in `scalars` is a guaranteed 422.
TRIP_SCALARS = {
    "title", "subtitle", "summary", "stage", "startDate", "endDate", "timezone",
    "theme", "cover", "coverCredit", "map", "visibility", "coverStats", "stats",
}
BLOCK_KINDS = {
    "activity", "transport", "lodging", "meal", "todo", "note",
    "gallery", "link", "booking", "custom",
}
BLOCK_STATUS = {"planned", "booked", "done"}
STAGES = {"idea", "options", "shortlist", "planned", "booked", "live", "archive"}
CREW_ROLES = {"owner", "editor", "viewer", "follower"}
PLAN_KEYS = {"scalars", "locations", "features", "days", "sections", "practical", "crew"}
PRACTICAL_KEYS = {"todos", "links", "notes", "contacts"}
#: Block fields the API accepts (BlockFields + kind/container handled here).
BLOCK_FIELDS = {
    "kind", "title", "time", "description", "links", "cost", "currency",
    "status", "bookingCode", "items", "html", "distance", "duration", "route",
    "via", "from", "to", "mode", "location", "mapsQuery", "googlePlaceId",
    "images",
}


class PlanError(Exception):
    """A client-side plan problem, raised before any write happens."""


def _load_plan(path: str) -> dict:
    if path == "-":
        raw = sys.stdin.read()
    else:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    try:
        plan = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PlanError(f"plan is not valid JSON: {exc}") from exc
    if not isinstance(plan, dict):
        raise PlanError("plan must be a JSON object")
    return plan


def _location_keys(existing: dict | None, plan: dict) -> set[str]:
    """Every name/alias a transport endpoint or section ref may point at."""
    keys: set[str] = set()
    sources = []
    if existing:
        sources.append(existing)
    sources.append(plan)
    for doc in sources:
        for loc in (doc.get("locations") or []):
            if isinstance(loc, dict):
                if isinstance(loc.get("name"), str):
                    keys.add(loc["name"].strip().lower())
                for alias in (loc.get("alias") or []):
                    if isinstance(alias, str):
                        keys.add(alias.strip().lower())
    return keys


def validate_plan(plan: dict, existing: dict | None = None) -> tuple[list[str], list[str]]:
    """Check a fill plan client-side. Returns ``(errors, warnings)``.

    Errors block the run (they would 422 server-side); warnings are the
    silent-no-op class — a transport endpoint that matches no location just
    renders without a map pill, which is invisible until someone looks.
    """
    errors: list[str] = []
    warnings: list[str] = []

    unknown = set(plan) - PLAN_KEYS
    if unknown:
        errors.append(f"unknown plan keys {sorted(unknown)} — allowed: {sorted(PLAN_KEYS)}")

    scalars = plan.get("scalars") or {}
    if not isinstance(scalars, dict):
        errors.append("`scalars` must be an object")
        scalars = {}
    bad_scalars = set(scalars) - TRIP_SCALARS
    if bad_scalars:
        errors.append(
            f"`scalars` not accepted by PUT /api/trips/<id>: {sorted(bad_scalars)} "
            f"(TripPatch is extra=forbid; allowed: {sorted(TRIP_SCALARS)})"
        )
    if scalars.get("stage") and scalars["stage"] not in STAGES:
        errors.append(f"scalars.stage {scalars['stage']!r} not one of {sorted(STAGES)}")

    locations = plan.get("locations")
    if locations is not None:
        if not isinstance(locations, list):
            errors.append("`locations` must be an array (PUT /locations replaces the whole registry)")
        else:
            for i, loc in enumerate(locations):
                if not isinstance(loc, dict) or not str(loc.get("name") or "").strip():
                    errors.append(f"locations[{i}] needs a non-empty `name`")

    features = plan.get("features")
    if features is not None:
        if not isinstance(features, list):
            errors.append("`features` must be an array")
        else:
            for i, feat in enumerate(features):
                if not isinstance(feat, dict) or not str(feat.get("title") or "").strip():
                    errors.append(f"features[{i}] needs a `title` (PUT /features diffs by title)")

    days = plan.get("days") or []
    if not isinstance(days, list):
        errors.append("`days` must be an array")
        days = []
    seen_dates: dict[str, int] = {}
    for i, day in enumerate(days):
        if not isinstance(day, dict):
            errors.append(f"days[{i}] must be an object")
            continue
        if not str(day.get("date") or "").strip():
            errors.append(f"days[{i}] needs an ISO `date`")
        elif str(day["date"]).strip() in seen_dates:
            errors.append(
                f"days[{i}] repeats date {day['date']} (already at days[{seen_dates[str(day['date']).strip()]}]) "
                f"— POST /days does NOT dedupe by date, it creates a SECOND day"
            )
        else:
            seen_dates[str(day["date"]).strip()] = i
        for j, block in enumerate(day.get("blocks") or []):
            where = f"days[{i}].blocks[{j}]"
            if not isinstance(block, dict):
                errors.append(f"{where} must be an object")
                continue
            kind = block.get("kind")
            if kind not in BLOCK_KINDS:
                errors.append(
                    f"{where}.kind {kind!r} is not a block kind — allowed: {sorted(BLOCK_KINDS)}"
                )
            if "order" in block:
                errors.append(f"{where}.order is server-managed — never send it")
            if "container" in block:
                errors.append(f"{where}.container is derived from its day/section — drop it")
            cost = block.get("cost")
            if cost is not None and not isinstance(cost, (int, float)):
                errors.append(
                    f"{where}.cost must be a NUMBER (got {cost!r}) — keep the currency in "
                    f"`currency`, never a symbol in the number"
                )
            status = block.get("status")
            if status is not None and status not in BLOCK_STATUS:
                errors.append(f"{where}.status {status!r} not one of {sorted(BLOCK_STATUS)}")
            unknown_fields = set(block) - BLOCK_FIELDS
            if unknown_fields:
                errors.append(f"{where} has unknown block fields {sorted(unknown_fields)}")

    day_count = len(days) if days else len((existing or {}).get("days") or [])
    sections = plan.get("sections")
    if sections is not None:
        if not isinstance(sections, list):
            errors.append("`sections` must be an array")
        else:
            # Sections the plan does not mention already own their day ranges,
            # and the server enforces non-overlap across ALL of them — so a
            # re-run that re-POSTs its own section 422s. A section the plan
            # DOES mention will be updated by id, so it does not contend.
            plan_titles = {
                str(s.get("title") or "").strip().lower()
                for s in sections
                if isinstance(s, dict)
            }
            claimed: list[tuple[int, int, str]] = []
            for existing_sec in (existing or {}).get("sections") or []:
                title = str(existing_sec.get("title") or "").strip()
                if title.lower() in plan_titles:
                    continue
                rng = existing_sec.get("days")
                if (
                    isinstance(rng, list)
                    and len(rng) == 2
                    and all(isinstance(v, int) for v in rng)
                ):
                    claimed.append((rng[0], rng[1], f"existing section {title!r}"))
            for i, sec in enumerate(sections):
                if not isinstance(sec, dict) or not str(sec.get("title") or "").strip():
                    errors.append(f"sections[{i}] needs a `title`")
                    continue
                rng = sec.get("days")
                if rng is None:
                    continue  # ideation-only section: no range, no bounds problem
                if (
                    not isinstance(rng, list) or len(rng) != 2
                    or not all(isinstance(v, int) for v in rng)
                ):
                    errors.append(f"sections[{i}].days must be [first, last] 0-based integers")
                    continue
                first, last = rng
                if first > last:
                    errors.append(f"sections[{i}].days {rng} is inverted (first > last)")
                elif day_count and (first < 0 or last >= day_count):
                    errors.append(
                        f"sections[{i}].days {rng} out of range: the trip has {day_count} "
                        f"days (0..{day_count - 1}) — the days must exist first"
                    )
                else:
                    for other_first, other_last, other_title in claimed:
                        if first <= other_last and other_first <= last:
                            errors.append(
                                f"sections[{i}] {rng} overlaps {other_title!r} "
                                f"[{other_first},{other_last}] — a day belongs to exactly one section"
                            )
                    claimed.append((first, last, sec["title"]))
                for j, block in enumerate(sec.get("blocks") or []):
                    if not isinstance(block, dict) or block.get("kind") not in BLOCK_KINDS:
                        errors.append(f"sections[{i}].blocks[{j}] needs a valid `kind`")

    practical = plan.get("practical")
    if practical is not None:
        if not isinstance(practical, dict):
            errors.append("`practical` must be an object")
        else:
            bad = set(practical) - PRACTICAL_KEYS
            if bad:
                errors.append(f"`practical` keys not accepted: {sorted(bad)}")

    crew = plan.get("crew")
    if crew is not None:
        if not isinstance(crew, list):
            errors.append("`crew` must be an array")
        else:
            for i, person in enumerate(crew):
                if not isinstance(person, dict) or not str(person.get("name") or "").strip():
                    errors.append(f"crew[{i}] needs a `name`")
                elif person.get("role") and person["role"] not in CREW_ROLES:
                    errors.append(f"crew[{i}].role {person['role']!r} not one of {sorted(CREW_ROLES)}")

    # ---- warnings: the silent-no-op class -------------------------------
    known_places = _location_keys(existing, plan)
    for i, day in enumerate(days):
        if not (day.get("blocks") or []):
            warnings.append(
                f"days[{i}] {day.get('date')} has no blocks — a day with no activity "
                f"renders empty in the itinerary"
            )
        for j, block in enumerate(day.get("blocks") or []):
            if not isinstance(block, dict) or block.get("kind") != "transport":
                continue
            if not str(block.get("mode") or "").strip():
                warnings.append(
                    f"days[{i}].blocks[{j}] is a transport without `mode` "
                    f"(flight|drive|train|ferry) — the icon/leg is guessed otherwise"
                )
            for endpoint in ("from", "to"):
                value = str(block.get(endpoint) or "").strip()
                if value and value.lower() not in known_places:
                    warnings.append(
                        f"days[{i}].blocks[{j}].{endpoint} {value!r} matches no location "
                        f"name/alias — the map leg silently renders without an endpoint"
                    )
    for i, sec in enumerate(sections or []):
        if not isinstance(sec, dict):
            continue
        for ref in (sec.get("locationRefs") or []):
            if str(ref).strip().lower() not in known_places:
                warnings.append(
                    f"sections[{i}].locationRefs {ref!r} matches no location name/alias"
                )
    return errors, warnings


def plan_calls(plan: dict, trip_id: str, existing: dict | None = None) -> list[tuple[str, str, dict | None]]:
    """Expand a validated plan into ``(method, path, body)`` calls, in order."""
    calls: list[tuple[str, str, dict | None]] = []
    base = f"/api/trips/{trip_id}"

    scalars = plan.get("scalars") or {}
    if scalars:
        calls.append(("put", base, scalars))
    if plan.get("locations"):
        calls.append(("put", f"{base}/locations", {"locations": plan["locations"]}))
    if plan.get("features"):
        calls.append(("put", f"{base}/features", {"features": plan["features"]}))

    # days: match existing days by DATE so a re-run updates instead of duplicating
    by_date = {d.get("date"): d.get("id") for d in (existing or {}).get("days") or []}
    for day in plan.get("days") or []:
        body = {k: v for k, v in day.items() if k != "blocks"}
        body.pop("id", None)
        day_id = day.get("id") or by_date.get(day.get("date"))
        if day_id:
            body.pop("date", None)  # PUT /days/<id> patches; the date is the identity
            calls.append(("put", f"{base}/days/{day_id}", body))
        else:
            calls.append(("post", f"{base}/days", body))

    existing_sections = {
        str(s.get("title") or "").strip().lower(): s.get("id")
        for s in (existing or {}).get("sections") or []
        if s.get("id")
    }
    for sec in plan.get("sections") or []:
        body = {k: v for k, v in sec.items() if k != "blocks"}
        body.pop("id", None)
        sec_id = sec.get("id") or existing_sections.get(str(sec.get("title") or "").strip().lower())
        if sec_id:
            calls.append(("put", f"{base}/sections/{sec_id}", body))
        else:
            calls.append(("post", f"{base}/sections", body))

    if plan.get("practical"):
        calls.append(("put", f"{base}/practical", plan["practical"]))

    existing_crew = {
        str(c.get("name") or "").strip().lower()
        for c in (existing or {}).get("crew") or []
    }
    for person in plan.get("crew") or []:
        if str(person.get("name") or "").strip().lower() in existing_crew:
            continue  # POST /crew would add a second card for the same person
        calls.append(("post", f"{base}/crew", person))
    return calls


def _request(
    method: str,
    base: str,
    path: str,
    token: str,
    body: dict | None,
    raw: tuple[bytes, str] | None = None,
) -> tuple[int, object]:
    url = base.rstrip("/") + ("/" + path.lstrip("/") if path else "")
    if raw is not None:
        data, content_type = raw
    else:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        content_type = "application/json"
    req = urllib.request.Request(url, method=method.upper(), data=data)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = resp.read().decode("utf-8")
            status = resp.status
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("detail", "")
        except Exception:
            pass
        return exc.code, detail or exc.reason
    try:
        return status, json.loads(payload)
    except json.JSONDecodeError:
        return status, payload


def _multipart(fields: dict[str, str], file_field: str, path: str) -> tuple[bytes, str]:
    """Encode one file + plain fields as multipart/form-data (stdlib only)."""
    boundary = "----kiseki" + uuid.uuid4().hex
    buf = io.BytesIO()
    for key, value in fields.items():
        if value is None:
            continue
        buf.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        )
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    buf.write(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
        f'filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
    )
    with open(path, "rb") as fh:
        buf.write(fh.read())
    buf.write(f"\r\n--{boundary}--\r\n".encode())
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


def _bare_name(url: str) -> str:
    """The filename a media field stores, from any returned /media//inbox/ URL."""
    return url.rstrip("/").rsplit("/", 1)[-1]


def upload_file(args) -> int:
    """`upload <local-file> [--trip-id <id>]` — bytes into the trip (or the inbox)."""
    base = args.base
    token = args.token or os.environ.get("KISEKI_TOKEN")
    if token is None:
        raise SystemExit("error: no token — pass --token or set KISEKI_TOKEN")
    path = args.path
    if not path:
        raise SystemExit("error: upload needs a local file path: upload <file> [--trip-id <id>]")
    if not os.path.isfile(path):
        raise SystemExit(f"error: no such file: {path}")

    payload, content_type = _multipart({"trip_id": args.trip_id}, "file", path)
    status, body = _request(
        "post", base, "/api/files", token, None, raw=(payload, content_type)
    )
    if not 200 <= status < 300:
        detail = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        print(f"HTTP {status}: {str(detail)[:300]}", file=sys.stderr)
        return 1
    url = (body or {}).get("url", "")
    print(json.dumps({"url": url, "field_value": _bare_name(url)}, indent=2))
    if url.startswith("/inbox/"):
        print(
            "staged in the inbox — promote it into the trip before writing a field:\n"
            f"  api_write.py promote {_bare_name(url)} --trip-id <trip_id>",
            file=sys.stderr,
        )
    return 0


def promote_file(args) -> int:
    """`promote <file-name> --trip-id <id>` — inbox file → the trip's media namespace."""
    base = args.base
    token = args.token or os.environ.get("KISEKI_TOKEN")
    if token is None:
        raise SystemExit("error: no token — pass --token or set KISEKI_TOKEN")
    if not args.path:
        raise SystemExit("error: promote needs the file name: promote <file-name> --trip-id <id>")
    if not args.trip_id:
        raise SystemExit("error: promote needs --trip-id <trip_id>")
    status, body = _request(
        "post", base, "/api/files/promote", token, {"trip_id": args.trip_id, "file_name": args.path}
    )
    if not 200 <= status < 300:
        detail = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        print(f"HTTP {status}: {str(detail)[:300]}", file=sys.stderr)
        return 1
    url = (body or {}).get("url", "")
    print(json.dumps({"url": url, "field_value": _bare_name(url)}, indent=2))
    print("write THAT field value (the bare filename) into cover/images/photo — not the URL", file=sys.stderr)
    return 0


def _block_update_body(body: dict) -> dict:
    """Body for ``PUT /blocks/<id>`` — `kind` and `container` are not patchable.

    Found live: re-running a plan 422'd with
    ``extra_forbidden: body.kind, body.container`` on the update path, because
    the create body (which needs both) was reused verbatim.
    """
    return {k: v for k, v in body.items() if k not in ("kind", "container")}


def _server_base(trip_id: str, base: str, token: str) -> dict:
    status, doc = _request("get", base, f"/api/trips/{trip_id}", token, None)
    if status != 200 or not isinstance(doc, dict):
        raise PlanError(f"cannot read trip {trip_id} first (HTTP {status}: {doc})")
    return doc


def fill_trip(args) -> int:
    """`fill` — one validated plan, one ordered run, one summary."""
    base = args.base
    token = args.token or os.environ.get("KISEKI_TOKEN")
    if token is None:
        raise SystemExit("error: no token — pass --token or set KISEKI_TOKEN")
    if not args.path:
        raise SystemExit("error: fill needs a trip id: fill <trip_id> --file plan.json")

    try:
        plan = _load_plan(args.file if args.file is not None else "-")
        existing = _server_base(args.path, base, token)
        errors, warnings = validate_plan(plan, existing)
    except PlanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if errors:
        print("plan rejected before any write:", file=sys.stderr)
        for err in errors:
            print(f"  ✗ {err}", file=sys.stderr)
        return 2

    calls = plan_calls(plan, args.path, existing)
    if args.dry_run:
        print(f"dry run — {len(calls)} call(s), nothing written:")
        for method, path, body in calls:
            summary = json.dumps(body, ensure_ascii=False) if body else ""
            print(f"  {method.upper():6s} {path} {summary[:120]}")
        return 0

    for call_no, (method, path, body) in enumerate(calls, start=1):
        status, payload = _request(method, base, path, token, body)
        mark = "✓" if 200 <= status < 300 else "✗"
        print(f"{mark} {method.upper():6s} {path} → {status}", file=sys.stderr)
        if not 200 <= status < 300:
            detail = json.dumps(payload, ensure_ascii=False)[:400] if not isinstance(payload, str) else payload[:400]
            print(f"  {detail}", file=sys.stderr)
            print(
                f"stopped at call {call_no}/{len(calls)} — "
                f"re-GET the trip and re-run the plan to continue (day gets matched by date, "
                f"so a re-run updates instead of duplicating)",
                file=sys.stderr,
            )
            return 1

    # blocks need ids, so they come after a re-GET (days/sections now exist)
    trip = _server_base(args.path, base, token)
    day_by_date = {d.get("date"): d.get("id") for d in trip.get("days") or []}
    section_by_title = {s.get("title"): s.get("id") for s in trip.get("sections") or []}
    block_calls: list[tuple[str, str, dict]] = []
    for day in plan.get("days") or []:
        day_id = day.get("id") or day_by_date.get(day.get("date"))
        if not day_id:
            print(f"error: no day id for {day.get('date')} — day insert failed?", file=sys.stderr)
            return 1
        for block in day.get("blocks") or []:
            payload = dict(block)
            payload["container"] = {"type": "day", "id": day_id}
            block_calls.append(("post", f"/api/trips/{args.path}/blocks", payload))
    for sec in plan.get("sections") or []:
        sec_id = section_by_title.get(sec.get("title"))
        for block in sec.get("blocks") or []:
            if not sec_id:
                print(f"error: no section id for {sec.get('title')!r}", file=sys.stderr)
                return 1
            payload = dict(block)
            payload["container"] = {"type": "section", "id": sec_id}
            block_calls.append(("post", f"/api/trips/{args.path}/blocks", payload))

    # Blocks have no natural id in a plan, so match on (container, kind, title):
    # a re-run after a mid-plan failure UPDATES its blocks instead of stacking
    # a second copy of the itinerary on top of the first.
    existing_blocks: dict[tuple[str, str, str], str] = {}
    for container in (trip.get("days") or []) + (trip.get("sections") or []):
        for blk in container.get("blocks") or []:
            key = (
                str(container.get("id")),
                str(blk.get("kind")),
                str(blk.get("title") or "").strip().lower(),
            )
            if blk.get("id"):
                existing_blocks[key] = blk["id"]
    matched = 0
    for idx, (method, path, body) in enumerate(block_calls, start=1):
        key = (str(body["container"]["id"]), str(body.get("kind")), str(body.get("title") or "").strip().lower())
        block_id = existing_blocks.get(key)
        send = body
        if block_id:
            method, path = "put", f"/api/trips/{args.path}/blocks/{block_id}"
            send = _block_update_body(body)
            matched += 1
        status, payload = _request(method, base, path, token, send)
        mark = "✓" if 200 <= status < 300 else "✗"
        verb_note = " (existing)" if block_id else ""
        print(
            f"{mark} {method.upper():6s} {path} (block {body.get('kind')}){verb_note} → {status}",
            file=sys.stderr,
        )
        if not 200 <= status < 300:
            detail = json.dumps(payload, ensure_ascii=False)[:400] if not isinstance(payload, str) else payload[:400]
            print(f"  {detail}", file=sys.stderr)
            print(f"stopped at block {idx}/{len(block_calls)}", file=sys.stderr)
            return 1

    final = _server_base(args.path, base, token)
    days = final.get("days") or []
    empty = [d.get("date") for d in days if not (d.get("blocks") or [])]
    summary = {
        "trip": final.get("title"),
        "stage": final.get("stage"),
        "cover": final.get("cover"),
        "locations": len(final.get("locations") or []),
        "features": len(final.get("features") or []),
        "sections": len(final.get("sections") or []),
        "days": len(days),
        "blocks": sum(len(d.get("blocks") or []) for d in days),
        "days_without_blocks": empty,
        "blocks_updated_in_place": matched,
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    if empty:
        print(
            f"warning: {len(empty)} day(s) still have no blocks: {', '.join(empty)}",
            file=sys.stderr,
        )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("method",
                    choices=["get", "put", "post", "patch", "delete", "create-trip", "fill",
                             "upload", "promote"])
    ap.add_argument("path", nargs="?", default=None,
                    help="API path, e.g. /api/trips/<trip_id>/blocks (omit for create-trip)")
    ap.add_argument("--json", help="JSON body inline")
    ap.add_argument("--file", help="JSON body from file ('-' = stdin)")
    ap.add_argument("--title", help="Trip title (create-trip only)")
    ap.add_argument("--subtitle", help="Trip subtitle (create-trip only)")
    ap.add_argument("--token", help="Bearer token (default: $KISEKI_TOKEN)")
    ap.add_argument("--base", default=BASE_URL, help=f"API base (default: {BASE_URL})")
    ap.add_argument("--dry-run", action="store_true",
                    help="fill only: validate + print the calls, write nothing")
    ap.add_argument("--trip-id",
                    help="upload/promote: the trip the file belongs to (upload without it "
                         "stages into the inbox, then `promote` moves it)")
    args = ap.parse_args()

    if args.method == "fill":
        return fill_trip(args)
    if args.method == "upload":
        return upload_file(args)
    if args.method == "promote":
        return promote_file(args)

    token = args.token or os.environ.get("KISEKI_TOKEN")
    if token is None:
        raise SystemExit("error: no token — pass --token or set KISEKI_TOKEN")

    method = args.method
    path = args.path
    if method == "create-trip":
        # POST /api/trips — spawn an empty trip the agent then fills via the
        # write API (issue #9). Body is just the name; --json/--file would
        # only smuggle fields the endpoint ignores.
        if path not in (None, "/api/trips"):
            raise SystemExit("error: create-trip takes no path (it POSTs /api/trips)")
        if args.json is not None or args.file is not None:
            raise SystemExit("error: create-trip takes --title/--subtitle, not --json/--file")
        if not (args.title or "").strip():
            raise SystemExit("error: create-trip requires --title")
        doc = {"title": args.title.strip()}
        if (args.subtitle or "").strip():
            doc["subtitle"] = args.subtitle.strip()
        body = json.dumps(doc).encode("utf-8")
        method, path = "post", "/api/trips"
    else:
        body = _read_body(args)
    url = args.base.rstrip("/") + ("/" + path.lstrip("/") if path else "")
    req = urllib.request.Request(url, method=method.upper(), data=body)
    req.add_header("Authorization", f"Bearer {token}")
    if body is not None:
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("detail", "")
        except Exception:
            pass
        print(f"HTTP {exc.code}: {detail or exc.reason}", file=sys.stderr)
        return exc.code
    except urllib.error.URLError as exc:
        print(f"error: cannot reach {url}: {exc.reason}", file=sys.stderr)
        return 1

    try:
        print(json.dumps(json.loads(payload), indent=2, ensure_ascii=False))
    except json.JSONDecodeError:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
