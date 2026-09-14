#!/usr/bin/env python3
"""#220 P2 — migrate trip content onto `placeId`, retiring `mapsQuery`.

Why this runs in two steps
--------------------------
`mapsQuery` held free-text venue text ("Banff Inn Banff Alberta") and, for the
blocks that used it, it was the ONLY place that information existed — the field
is being deleted, so the text has to be resolved into a real Google `place_id`
*while it can still be read*. The app API only exposes `mapsQuery` before the
new image ships, and the twin patch needs the new DTDL registered (so `placeId`
is a modeled property). Hence:

  1. ``--plan``   (run on the OLD image) walk every trip, resolve each venue
                  block's venue text to a place id, and record a plan.
  2. ``--apply``  (run AFTER the new image is deployed + DTDL reloaded) turn
                  each plan entry into JSON-Patch ops on the block twin:
                  ``add /placeId``, ``remove /googlePlaceId``, ``remove /mapsQuery``.

Both steps are dry-run by default; pass ``--commit`` to write. ``--plan`` is
read-only apart from the Places lookups it needs.

Venue resolution uses ``mapsQuery`` ONLY — text that was deliberately written as
a venue ("Banff Inn Banff Alberta") and, for those blocks, the only place that
information exists. It is deliberately NOT resolved from ``location``: a block
already falls back to its ``location``'s registry entry for a place id
(``b.placeId ?? resolvedPlace.placeId``), so copying that same value onto the
block would make ``placeId`` mean "somewhere near here" instead of "THE venue".
The block **title is never used** either — resolving titles produces confident
nonsense ("Power, water and waste plan" -> "Brico Plan-it Ghent"). Blocks left
without a place id are reported for a content pass instead of being pinned to a
wrong place.

Env: ``--plan`` needs the M2M creds ``kiseki_m2m`` already uses; ``--apply``
needs ``KISEKI_GRAPH_URL`` (+ optional ``KISEKI_GRAPH_TOKEN``), exactly like
``reload_dtdl_models.py``.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Kinds that name a real-world venue and therefore deserve a place id.
VENUE_KINDS = {"lodging", "meal", "activity", "booking"}

PREFIX = "[place-migrate]"


def _blocks(node: Any, out: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Collect every block dict from a served trip document (days + sections)."""
    if out is None:
        out = []
    if isinstance(node, dict):
        if node.get("kind") and node.get("id"):
            out.append(node)
        for value in node.values():
            _blocks(value, out)
    elif isinstance(node, list):
        for value in node:
            _blocks(value, out)
    return out


def _search_place(text: str) -> dict[str, Any]:
    """Resolve venue text via the app's own Places proxy. Never raises for a
    miss — an unavailable/empty result comes back as an empty dict."""
    import kiseki_m2m as m  # noqa: PLC0415

    try:
        hit = m.api("GET", "/api/places/search?q=" + urllib.parse.quote(text))
    except Exception as exc:  # noqa: BLE001 — a miss is data, not a crash
        return {"_error": str(exc)}
    return hit if isinstance(hit, dict) else {}


def _ops(place_id: str | None, has_legacy_id: bool, has_maps_query: bool) -> list[dict[str, Any]]:
    """RFC 6902 ops for one block twin."""
    ops: list[dict[str, Any]] = []
    if place_id:
        # `add` replaces an existing member per RFC 6902 — safe either way.
        ops.append({"op": "add", "path": "/placeId", "value": place_id})
    if has_legacy_id:
        ops.append({"op": "remove", "path": "/googlePlaceId"})
    if has_maps_query:
        ops.append({"op": "remove", "path": "/mapsQuery"})
    return ops


def build_plan() -> dict[str, Any]:
    """Step 1 — read the live trips and resolve every venue that has none."""
    import kiseki_m2m as m  # noqa: PLC0415

    listing = m.api("GET", "/api/trips")
    trips = listing.get("trips") if isinstance(listing, dict) else listing
    plan: dict[str, Any] = {"trips": []}

    for trip in trips or []:
        # The trip listing keys trips by `dtId`; the served trip document uses `id`.
        trip_id = trip.get("dtId") or trip.get("id") or trip.get("$dtId")
        doc = m.api("GET", f"/api/trips/{trip_id}")
        entries: list[dict[str, Any]] = []
        for block in _blocks(doc):
            if block.get("kind") not in VENUE_KINDS or not block.get("id"):
                continue
            legacy_id = block.get("googlePlaceId")
            maps_query = block.get("mapsQuery")
            existing = block.get("placeId") or legacy_id
            entry: dict[str, Any] = {
                "blockId": block["id"],
                "kind": block.get("kind"),
                "title": block.get("title"),
                "location": block.get("location"),
                "placeId": existing,
                "venueSource": "existing" if existing else None,
                "venueText": None,
                "resolvedName": None,
                "unresolved": False,
            }
            if not existing and maps_query and str(maps_query).strip():
                entry["venueSource"] = "mapsQuery"
                entry["venueText"] = str(maps_query).strip()
                hit = _search_place(entry["venueText"])
                entry["placeId"] = hit.get("placeId")
                entry["resolvedName"] = hit.get("name")
                if hit.get("_error"):
                    entry["error"] = hit["_error"]
            entry["unresolved"] = not entry["placeId"]
            entry["ops"] = _ops(entry["placeId"], bool(legacy_id), bool(maps_query))
            entries.append(entry)

        if entries:
            plan["trips"].append(
                {"tripId": trip_id, "title": trip.get("title"), "entries": entries}
            )
    return plan


def summarise(plan: dict[str, Any]) -> None:
    resolved = renamed = stripped = 0
    missing: list[str] = []
    for trip in plan["trips"]:
        for entry in trip["entries"]:
            if entry["placeId"]:
                resolved += 1
            if any(op["path"] == "/googlePlaceId" for op in entry.get("ops", [])):
                renamed += 1
            if any(op["path"] == "/mapsQuery" for op in entry.get("ops", [])):
                stripped += 1
            if entry["unresolved"]:
                missing.append(f"{str(trip.get('title'))[:22]} / {str(entry['title'])[:44]}")
    blocks = sum(len(t["entries"]) for t in plan["trips"])
    print(f"{PREFIX} trips={len(plan['trips'])} venue blocks={blocks}")
    print(f"{PREFIX}   with a place id after migration : {resolved}")
    print(f"{PREFIX}   googlePlaceId -> placeId moved   : {renamed}")
    print(f"{PREFIX}   mapsQuery removed                : {stripped}")
    print(f"{PREFIX}   left with NO place id (report)   : {len(missing)}")
    for label in missing:
        print(f"{PREFIX}       - {label}")


def apply_plan(path: str, commit: bool) -> int:
    """Step 2 — patch the twins from a recorded plan."""
    plan = json.loads(Path(path).read_text(encoding="utf-8"))
    from app.graph.client import GraphWriteClient  # noqa: PLC0415

    client = GraphWriteClient()
    if not client.is_enabled():
        raise SystemExit(f"{PREFIX} set KISEKI_GRAPH_URL (see reload_dtdl_models.py)")
    written = 0
    for trip in plan["trips"]:
        for entry in trip["entries"]:
            ops = entry.get("ops") or []
            if not ops:
                continue
            detail = ", ".join(
                f"{op['op']} {op['path']}" + (f"={op['value']}" if "value" in op else "")
                for op in ops
            )
            if not commit:
                print(f"{PREFIX} would patch {entry['blockId']}: {detail}")
                continue
            client.update_twin_props(trip["tripId"], entry["blockId"], ops)
            print(f"{PREFIX} patched {entry['blockId']}: {detail}")
            written += 1
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", metavar="OUT.json", help="step 1: write the migration plan")
    ap.add_argument("--apply", metavar="IN.json", help="step 2: apply a recorded plan")
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry-run)")
    args = ap.parse_args()

    if args.plan:
        plan = build_plan()
        Path(args.plan).write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        summarise(plan)
        print(f"{PREFIX} wrote {args.plan}")
        return
    if args.apply:
        written = apply_plan(args.apply, args.commit)
        verb = "patched" if args.commit else "would patch"
        print(f"{PREFIX} {verb} {written} twin(s)" + ("" if args.commit else " (dry-run — pass --commit)"))
        return
    ap.error("pass --plan OUT.json (step 1) or --apply IN.json (step 2)")


if __name__ == "__main__":
    main()
