#!/usr/bin/env python3
"""Generate `docs/write-api.md` from the code that enforces it (issue #255).

The cost this removes: an agent building a trip used to rediscover the write
schema by trial — GET other trips for shape examples, read the models, guess, and
then take a 422 in the middle of a 43-block run. This generator is the answer to
"it should understand the full schema (should be fully documented)": every table
below is read out of the FastAPI app and the write models, and every example is
run through the same `validate_plan` a real `fill` runs, so the document cannot
describe a schema that has moved on.

    uv run python scripts/gen_write_api_docs.py            # write the file
    uv run python scripts/gen_write_api_docs.py --check    # CI: fail on drift

`backend/tests/test_write_api_docs.py` calls the same `render()` as `--check`, so
a schema change without a regenerated doc fails the build.

Deliberate scope: the **trip-content** write surface (`/api/trips/{trip_id}/…`).
The other write routes (chat, uploads, follows, account) are the app's own
business, not the content agent's, and including them would bury the 20 routes
that matter in 41.
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import re
import sys
import typing
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
DOC_PATH = REPO / "docs" / "write-api.md"

#: Routes of the trip-content surface. Everything under one trip resource —
#: the prefix the content agent writes through.
TRIP_PREFIX = "/api/trips/{trip_id}"

#: Routes on that prefix that exist for the app, not for trip authoring.
APP_ONLY_SUFFIXES = (
    "/photos/propose",
    "/photos/confirm",
    "/follow",
    "/join-link",
    "/follow-link",
    "/booklet.pdf",
    "/tricount",
)
APP_ONLY_MARKERS = ("/tricount/",)


def _load_api_write():
    """Import the sibling client script (stdlib-only, so always safe)."""
    path = BACKEND / "scripts" / "api_write.py"
    spec = importlib.util.spec_from_file_location("_api_write_for_docs", path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit(f"error: cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _type_name(annotation: object) -> str:
    """A short, readable rendering of a pydantic field annotation."""
    if annotation is None or annotation is inspect.Parameter.empty:
        return "any"
    if isinstance(annotation, str):
        return annotation
    # Optional[...] / Union[...] -> "A | B"
    origin = typing.get_origin(annotation)
    if origin is typing.Union:
        parts = [_type_name(arg) for arg in typing.get_args(annotation)]
        # Optional[X] is Union[X, None] — keep it explicit, it is the point.
        return " | ".join(parts)
    if origin in (list, tuple, set, frozenset, dict):
        args = typing.get_args(annotation)
        if not args:
            return {list: "array", tuple: "array", set: "array", frozenset: "array", dict: "object"}[origin]
        inner = ", ".join(_type_name(arg) for arg in args)
        return f"{'array' if origin in (list, tuple, set, frozenset) else 'object'}[{inner}]"
    if origin is typing.Literal:
        return " | ".join(json.dumps(arg) for arg in typing.get_args(annotation))
    if hasattr(annotation, "__name__"):
        return str(annotation.__name__)
    return re.sub(r"\b(typing|builtins)\.", "", str(annotation))


def _default(value: object) -> str:
    from pydantic_core import PydanticUndefined

    if value is PydanticUndefined:
        return "—"
    if value is None:
        return "`null`"
    if callable(value) and not isinstance(value, (str, bytes)):
        # default_factory — enough to say "empty" without importing its guts.
        return "`[]`" if type(value).__name__ in ("list", "List") else "*(factory)*"
    return f"`{json.dumps(value)}`" if not isinstance(value, str) else f"`{value}`"


def _model_summary(model: type) -> str:
    """The model's OWN docstring (not the base's), first paragraph, one line."""
    own = model.__dict__.get("__doc__") or ""
    text = re.sub(r"\s+", " ", own.strip().split("\n\n", 1)[0]).strip()
    return re.split(r"(?<=\.)\s", text, maxsplit=1)[0].strip()


def _model_rows(model: type) -> list[tuple[str, str, str, str]]:
    rows = []
    for name, field in model.model_fields.items():
        label = field.alias or name
        if field.alias and field.alias != name:
            label = f"{field.alias} *({name})*"
        rows.append(
            (
                label,
                _type_name(field.annotation),
                "yes" if field.is_required() else "no",
                _default(field.default),
            )
        )
    return rows


def _model_config_note(model: type) -> str:
    extra = (model.model_config or {}).get("extra")
    return "extra=forbid — an unknown field is a 422" if extra == "forbid" else ""


def _route_purpose(endpoint: object) -> str:
    """The endpoint's own first paragraph, on one line — its summary."""
    doc = inspect.getdoc(endpoint) or ""
    paragraph = doc.strip().split("\n\n", 1)[0]
    text = re.sub(r"\s+", " ", paragraph).strip()
    sentence = re.split(r"(?<=\.)\s", text, maxsplit=1)[0].strip()
    if len(sentence) > 150:
        sentence = sentence[:147].rstrip() + "…"
    return sentence or "—"


def _write_routes(app) -> list[tuple[str, str, str, str]]:
    """(method, path, model name, purpose) for the trip-content WRITE surface."""
    from fastapi.routing import APIRoute

    rows: list[tuple[str, str, str, str]] = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith(TRIP_PREFIX):
            continue
        if route.path.endswith(APP_ONLY_SUFFIXES) or any(
            marker in route.path for marker in APP_ONLY_MARKERS
        ):
            continue
        methods = sorted(set(route.methods) - {"HEAD", "OPTIONS", "GET"})
        if not methods:  # reads are documented by the app, not here
            continue
        body_params = list(getattr(route.dependant, "body_params", []) or [])
        model = "—"
        if body_params:
            annotation = body_params[0].field_info.annotation
            model = getattr(annotation, "__name__", _type_name(annotation))
        rows.append((methods[0], route.path, model, _route_purpose(route.endpoint)))
    return rows


#: Every block-kind rule the server enforces, with the message it returns. Kept
#: next to the code that mirrors them client-side so the two are edited together.
KIND_RULES = """\
The write model for a block is deliberately coarse — one flat `BlockFields` for
every kind — and the *kind* rules are enforced on top of it in
`app/write.py::_validate_block_kind_fields`. It keys on **presence**
(`model_fields_set`), not truthiness, which is the trap:

| Field(s) | Valid kind(s) | Error when given to another kind |
| --- | --- | --- |
| `distance`, `duration`, `route`, `via`, `from`, `to`, `mode` | `transport` | `Field(s) [...] are only valid on transport blocks` |
| `html` | `custom` | `Field 'html' is only valid on custom blocks` |
| `items` | `todo`, `gallery` | `Field 'items' is only valid on todo/gallery blocks` |

`"items": []` is therefore *not* a harmless empty array — it is a 422 that stops
a 43-block pass at block 1. So is `"distance": null` on a meal. Both arrive on
their own the moment a plan is built by round-tripping a `GET`, because a GET
returns every key with its default filled in.

`api_write.py fill` removes both client-side before the first call
(`normalize_plan`), and rejects only the class that is a genuine authoring
mistake — a *non-empty* value for another kind's field.
"""


def _render_examples(api_write) -> tuple[str, list[str]]:
    """The canonical payloads, validated as they are rendered.

    Returns ``(markdown, problems)``. `render()` turns a non-empty `problems`
    into a hard failure, so a stale example cannot ship: these payloads are
    asserted against the same `validate_plan` a real `fill` runs.
    """
    problems: list[str] = []
    plan = {
        "scalars": {"title": "Example: three days in Kyushu", "stage": "planned"},
        "locations": [
            {"name": "Fukuoka", "kind": "city"},
            {"name": "Ohori Park", "kind": "venue"},
        ],
        "days": [
            {
                "date": "2027-04-02",
                "title": "Arrival",
                "notes": "Nothing booked yet — decide on the hill.",
                "blocks": [
                    {"kind": "transport", "time": "09:40", "title": "AMS → FUK",
                     "from": "Amsterdam", "to": "Fukuoka", "mode": "flight",
                     "distance": 9200, "duration": "13h05"},
                    {"kind": "lodging", "title": "Hotel Okura Fukuoka",
                     "location": "Fukuoka", "placeId": "ChIJ_example_place_id",
                     "bookingCode": "OK-4417", "cost": 210, "currency": "EUR"},
                ],
            },
            {
                "date": "2027-04-03",
                "title": "City day",
                "blocks": [
                    {"kind": "activity", "time": "10:00", "title": "Ohori Park",
                     "location": "Ohori Park", "description": "Loop the pond, then coffee."},
                    {"kind": "meal", "time": "13:00", "title": "Yatai lunch",
                     "location": "Fukuoka", "cost": 18, "currency": "EUR"},
                    {"kind": "todo", "title": "Before we go",
                     "items": [{"label": "Book the yatai tour", "done": False}]},
                ],
            },
        ],
    }
    try:
        errors, _warnings = api_write.validate_plan(plan, None)
        if errors:
            problems.append("the day/plan example no longer validates: " + "; ".join(errors))
        normalized, _notes = api_write.normalize_plan(plan)
        leftovers = [
            f"days[{i}].blocks[{j}].{k}"
            for i, day in enumerate(normalized.get("days") or [])
            for j, block in enumerate(day.get("blocks") or [])
            for k in block
            if k in api_write.KIND_ONLY_FIELDS
            and block.get("kind") not in api_write.KIND_ONLY_FIELDS[k]
        ]
        if leftovers:
            problems.append(f"normalize_plan left kind-only fields behind: {leftovers}")
    except Exception as exc:  # noqa: BLE001 — a broken example is the failure
        problems.append(f"the day/plan example blew up: {exc!r}")

    blocks = [
        ("transport", {"kind": "transport", "time": "08:15", "title": "Drive to Reno",
                       "from": "Sacramento", "to": "Reno", "mode": "car",
                       "distance": 220, "duration": "2h20", "via": "I-80"}),
        ("lodging", {"kind": "lodging", "title": "Hotel Presidente",
                     "location": "Hotel Presidente", "placeId": "ChIJ_example_hotel",
                     "bookingCode": "PR-2210"}),
        ("meal", {"kind": "meal", "time": "20:00", "title": "Dinner at the camp",
                  "location": "Black Rock City", "cost": 0, "currency": "USD"}),
        ("activity", {"kind": "activity", "time": "11:00", "title": "Bike the playa",
                      "location": "Black Rock City",
                      "links": [{"label": "Map", "url": "https://example.org/map"}]}),
        ("todo", {"kind": "todo", "title": "Packing",
                  "items": [{"label": "Goggles", "done": False},
                            {"label": "Bike lock", "done": True}]}),
        ("gallery", {"kind": "gallery", "title": "Day one",
                     "items": ["2026-08-30-1402.jpg", "2026-08-30-1500.jpg"]}),
        ("note", {"kind": "note", "title": "Water", "description": "Playa water is alkali."}),
        ("booking", {"kind": "booking", "title": "Camp pass",
                     "location": "Black Rock City", "bookingCode": "BRC-9931"}),
        ("custom", {"kind": "custom", "title": "Shade plan",
                    "html": "<p>Two tarps, one pole.</p>"}),
        ("transport", {"kind": "transport", "title": "Flight home", "mode": "flight"}),
    ]
    block_problems: list[str] = []
    for kind, body in blocks:
        block_plan = {"days": [{"date": "2027-04-02", "blocks": [dict(body)]}]}
        errors, _warnings = api_write.validate_plan(block_plan, None)
        if errors:
            block_problems.append(f"{kind}: {'; '.join(errors)}")
        normalized, _notes = api_write.normalize_plan(block_plan)
        sent = normalized["days"][0]["blocks"][0]
        if set(body) - set(sent):
            block_problems.append(
                f"{kind}: normalize_plan dropped {sorted(set(body) - set(sent))} from an example"
            )
    problems.extend(block_problems)

    lines = [
        "### A `fill` plan",
        "",
        "A plan is a partial trip document: every key is optional, every write is a",
        "merge, and absent means *leave it alone*. Top-level keys are exactly",
        f"{', '.join('`' + k + '`' for k in sorted(api_write.PLAN_KEYS))}.",
        "A `day` that matches an existing date is updated in place; a new one is",
        "created (and then patched with its `notes`/`map`/`meta`, which `POST /days`",
        "does not accept — see below). A `block` is matched on",
        "(container, kind, title), which is what makes a re-run update instead of",
        "stacking a second copy of the itinerary.",
        "",
        "```json",
        json.dumps(plan, indent=2, ensure_ascii=False),
        "```",
        "",
        "```bash",
        "api_write.py fill <trip_id> --file plan.json --dry-run   # what will be sent",
        "api_write.py fill <trip_id> --file plan.json             # one ordered run",
        "```",
        "",
        "`fill` then reports what only the server can know: days without blocks,",
        "blocks that name no venue, and locations that resolved outside the trip's",
        "own area.",
        "",
        "### One body per block kind",
        "",
        f"All kinds: {', '.join('`' + k + '`' for k in sorted(api_write.BLOCK_KINDS))}.",
        "Statuses a block may carry:",
        f"{', '.join('`' + s + '`' for s in sorted(api_write.BLOCK_STATUS))}.",
        "",
    ]
    for kind, body in blocks:
        label = kind if body.get("title") else f"{kind} (bare — a stub is fine)"
        lines += [f"**{label}**", "", "```json", json.dumps(body, ensure_ascii=False), "```", ""]
    return "\n".join(lines), problems


def render() -> tuple[str, list[str]]:
    """Return ``(markdown, problems)`` — problems are fatal for `--check`."""
    from app.main import app

    api_write = _load_api_write()
    problems: list[str] = []

    routes = _write_routes(app)
    if len(routes) < 15:
        problems.append(
            f"only {len(routes)} trip write route(s) found — the app's route table changed shape"
        )

    out: list[str] = []
    add = out.append
    add("<!-- GENERATED by backend/scripts/gen_write_api_docs.py — do not edit by hand.")
    add("     Run `uv run python scripts/gen_write_api_docs.py` after ANY change to")
    add("     app/write.py, app/models.py or a write route; CI fails otherwise (#255). -->")
    add("")
    add("# Trip write API — schema reference")
    add("")
    add("Everything an agent needs to write a trip without discovering the schema by")
    add("trial: the routes, the exact body of each one, the block-kind rules, and")
    add("payloads that are validated by this file's own generator. It is **generated")
    add("from the code**, so it cannot describe a schema that has moved on.")
    add("")
    add("Companion pieces:")
    add("")
    add("- `backend/scripts/api_write.py` — the client, and the only thing that should")
    add("  write trip content from an agent (it validates a plan before the first call,")
    add("  normalizes what the server would 422 on, and resolves venues in the right")
    add("  order). `--help` is the CLI recipe.")
    add("- The content-agent skill (`kiseki-trip-content`) — the *how-to* for a trip")
    add("  build: roadbook → days → blocks → photos → polish.")
    add("")
    add("## Authentication and shape of a call")
    add("")
    add("- Credentials ride in the `Authorization` header; the client reads the")
    add("  access token from `KISEKI_TOKEN`.")
    add("- Every write answers with the **canonical trip document** — reread it rather")
    add("  than assuming what landed.")
    add("- IDs are UUIDs; dates are ISO `YYYY-MM-DD`; money is a number plus a")
    add(f"  separate `currency`.")
    add("- `extra=forbid` is the norm: an unknown field is a 422, not a warning.")
    add("")
    add("## The write surface")
    add("")
    add("| Method | Path | Body | Purpose |")
    add("| --- | --- | --- | --- |")
    for method, path, model, purpose in routes:
        add(f"| `{method}` | `{path}` | `{model}` | {purpose} |")
    add("")

    models_seen: list[str] = []
    for _method, _path, model, _purpose in routes:
        if model != "—" and model not in models_seen:
            models_seen.append(model)

    add("## Body models")
    add("")
    for name in models_seen:
        model = getattr(app_module(), name, None)
        if model is None:
            problems.append(f"route references model {name!r} that is not importable")
            continue
        note = _model_config_note(model)
        doc = _model_summary(model)
        add(f"### `{name}`")
        add("")
        if doc:
            add(f"{doc}")
            add("")
        if note:
            add(f"*{note}*")
            add("")
        add("| Field | Type | Required | Default |")
        add("| --- | --- | --- | --- |")
        for label, type_name, required, default in _model_rows(model):
            add(f"| `{label}` | {type_name} | {required} | {default} |")
        add("")

    add("## Block-kind rules")
    add("")
    add(KIND_RULES)
    add("")
    add("### `DayCreate` vs `DayPatch` — a new day takes two calls")
    add("")
    add("`POST /days` takes "
        + ", ".join(f"`{f}`" for f in sorted(api_write.DAY_CREATE_FIELDS))
        + " **only**. `notes`, `map` and `meta` are `DayPatch` fields, so a day the")
    add("plan creates gets them in a second call, once it has an id —")
    add("`api_write.py fill` does that itself (`day_create_extras`) and prints it in")
    add("`--dry-run`. Splitting a plan by hand was a whole throwaway script in #255.")
    add("")
    add("## Venue resolution")
    add("")
    add("A venue key (`placeId`) is what turns a block's Maps pill from a city search")
    add("into the actual place. `api_write.py fill` resolves them at the end of the")
    add("run, and `resolve-places <trip_id>` re-runs just that pass:")
    add("")
    add("1. A registry location without a `placeId` is resolved **by name**, biased")
    add("   toward the trip's own coordinates (`GET /api/places/search?q=&lat=&lng=&radius=`).")
    add("   The bias matters: \"Hotel Presidente\" is a Madrid hotel as well as a San")
    add("   José one, and an unbiased search can place a venue on another continent")
    add("   without anything in the response saying so. A hit still far from the trip")
    add("   is reported in `locations_off_trip`, never written quietly.")
    add("2. A **venue block** (`activity`, `lodging`, `meal`, `booking`) copies the")
    add("   `placeId` of the registry entry its `location` points at. There is")
    add("   deliberately no free-text venue field on a block (#220) — free text is")
    add("   what let a venue look resolved while its `placeId` stayed empty.")
    add("")
    add("So: put the venue in the `locations` registry, then point the block's")
    add("`location` at that entry's name. `blocks_without_venue` in the run summary")
    add("is the list of blocks that still name no venue.")
    add("")

    add("## Examples")
    add("")
    examples, example_problems = _render_examples(api_write)
    problems.extend(example_problems)
    add(examples)
    add("")
    add("## Common 422s, and what they mean")
    add("")
    add("| Error | Cause | Fix |")
    add("| --- | --- | --- |")
    add("| `Field(s) ['mode', 'to'] are only valid on transport blocks` | transport-only "
        "field on another kind — including an explicit `null`/`[]` from a GET round-trip | "
        "`normalize_plan` drops it in `fill`; drop it from the plan otherwise |")
    add("| `Field 'items' is only valid on todo/gallery blocks` | `\"items\": []` on any "
        "other kind | same — presence is the trigger, not truthiness |")
    add("| `Extra inputs are not permitted` | unknown field on an `extra=forbid` body | "
        "check the body table above; the field does not exist |")
    add("| `Field 'html' is only valid on custom blocks` | `html` on a non-`custom` block | "
        "use `description`, or make the block `custom` |")
    add("| `cost must be a NUMBER` | `\"€40\"` instead of `40` + `currency` | number in "
        "`cost`, ISO code in `currency` |")
    add("| `days[N] repeats date ...` | the same date twice in one plan | `POST /days` "
        "does not dedupe by date — it creates a second day |")
    add("| `Field(s) ['notes'] are not permitted` on `POST /days` | `DayCreate` is "
        "`extra=forbid` | let `fill` do it (see above) — the `notes` go in a follow-up "
        "`PUT /days/<id>` |")
    add("")
    add("## Keeping this honest")
    add("")
    add("`backend/tests/test_write_api_docs.py` re-renders the file and fails if it")
    add("differs from what is committed, so a model or route change without a")
    add("regenerated doc breaks the build instead of the next agent's run.")
    add("")
    return "\n".join(out) + "\n", problems


def app_module():
    """The module the route table's models come from (`app.main`'s namespace)."""
    import app.main as main

    return main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="verify, do not write")
    parser.add_argument("--out", default=str(DOC_PATH), help="output path")
    args = parser.parse_args()

    markdown, problems = render()
    if problems:
        print("error: the generated doc would be wrong:", file=sys.stderr)
        for problem in problems:
            print(f"  ✗ {problem}", file=sys.stderr)
        return 1

    out = Path(args.out)
    if args.check:
        current = out.read_text(encoding="utf-8") if out.exists() else ""
        if current != markdown:
            print(
                f"error: {out.relative_to(REPO)} is out of date — "
                "run `uv run python scripts/gen_write_api_docs.py`",
                file=sys.stderr,
            )
            return 1
        print(f"ok: {out.relative_to(REPO)} matches the code")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(markdown, encoding="utf-8")
    print(f"wrote {out.relative_to(REPO)} ({len(markdown.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
