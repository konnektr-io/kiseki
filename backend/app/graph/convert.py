"""Rebuild a :class:`app.models.Trip` from an ADT-shaped graph dict (issue #4).

The graph dict is source-agnostic — identical shape whether produced by the
live ``konnektr-graph`` SDK (``client.GraphReadClient.fetch_graph``) or loaded
from a committed ``data/seed/<slug>.graph.json`` fixture. Both are the
``{twins, relationships}`` bundle produced by ``scripts/trip_to_graph.py``.

This is the inverse of ``scripts/trip_to_graph.py``:

    twins        -> Pydantic models (Trip/Day/Block/Location/Person/Feature/Section)
    relationships -> nested lists:
        Trip → days (hasDay) → blocks (hasBlock)
        Trip → sections (hasSection) → days (hasDay) + blocks (hasBlock) + locations (atLocation)
        Trip → crew (hasCrew, role rides the edge) / locations (atLocation) /
               features (hasFeature)
        Block → location name (atLocation edge, resolved back to the place name)

The outcome is byte-faithful to the original ``trip.json`` (verified by the
round-trip tests), so the P0 API contract is preserved.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from app import models as M

_MODEL_RE = re.compile(r"dtmi:kiseki:travel:([A-Za-z0-9_]+);\d+$")


def _kind(dtmi: str) -> str:
    m = _MODEL_RE.search(dtmi or "")
    return m.group(1) if m else ""


def _collapse_day_range(indices: list[int]) -> list[int]:
    """Canonical ``TripSection.days`` form: inclusive ``[first, last]`` range.

    The forward path (``scripts/trip_to_graph.py``) expands a section's day
    range into one hasDay edge per day. Reconstructing from those edges yields a
    full index list; the model documents ``days`` as the compact ``[first,
    last]`` inclusive range, so collapse a single contiguous run back to it.
    Non-contiguous (explicit) day lists are preserved as-is.
    """
    if not indices:
        return []
    s = sorted(set(indices))
    # A contiguous run collapses to the inclusive [first, last] range — this
    # also covers a single day (e.g. [9] -> [9, 9]), the documented form.
    if s == list(range(s[0], s[0] + len(s))):
        return [s[0], s[-1]]
    return s


def _bydict(twin: dict) -> dict:
    """Strip ADT framing ($dtId/$metadata/$etag) -> plain props + id."""
    d = {k: v for k, v in twin.items() if k not in ("$dtId", "$metadata", "$etag")}
    d["id"] = twin["$dtId"]
    return d


def graph_to_trip(graph: dict) -> M.Trip:
    twins = graph.get("twins", [])
    rels = graph.get("relationships", [])
    by_id = {t["$dtId"]: t for t in twins}
    rels_by_src: dict[Optional[str], list[dict]] = {}
    for r in rels:
        rels_by_src.setdefault(r.get("$sourceId"), []).append(r)

    def targets(src: Optional[str], name: str, sort_index: bool = True) -> list[str]:
        if not src:
            return []
        rs = [r for r in rels_by_src.get(src, []) if r.get("$relationshipName") == name]
        if sort_index and any("index" in r for r in rs):
            rs.sort(key=lambda r: r.get("index", 0))
        return [str(r.get("$targetId")) for r in rs]

    def twin_of(dtid: str) -> Optional[dict]:
        return by_id.get(dtid)

    def block_from(dtid: str, loc_name_by_id: dict[str, str]) -> M.Block:
        t = twin_of(dtid)
        d = _bydict(t) if t else {"id": dtid}
        # The block twin already carries `location` as a property (a place
        # name/alias, e.g. "Hillcrest" — an alias of Revelstoke). Only fall back
        # to the `atLocation` edge when the property is absent, so we never
        # overwrite the user's own label with a resolved canonical name.
        if not d.get("location"):
            for r in rels_by_src.get(dtid, []):
                if r.get("$relationshipName") == "atLocation":
                    loc_id = r.get("$targetId")
                    if loc_id in loc_name_by_id:
                        d["location"] = loc_name_by_id[loc_id]
                    break
        return M.Block.model_validate(d)

    # ---- root Trip twin ---------------------------------------------------
    root_id = graph.get("$dtId")
    trip_twin = by_id.get(root_id) or next(
        (t for t in twins if _kind(t.get("$metadata", {}).get("$model", "")) == "Trip"),
        None,
    )
    if trip_twin is None:
        raise ValueError("graph has no Trip twin")
    base = _bydict(trip_twin)

    # ---- locations (shared registry) -------------------------------------
    loc_ids = targets(root_id, "atLocation")
    locations: list[M.Location] = []
    loc_name_by_id: dict[str, str] = {}
    for lid in loc_ids:
        t = twin_of(lid)
        if not t:
            continue
        loc = M.Location.model_validate(_bydict(t))
        locations.append(loc)
        loc_name_by_id[lid] = loc.name

    # ---- crew (role/note ride the hasCrew edge) --------------------------
    crew: list[M.Person] = []
    for r in rels_by_src.get(root_id, []):
        if r.get("$relationshipName") != "hasCrew":
            continue
        t = twin_of(r.get("$targetId", ""))
        if not t:
            continue
        d = _bydict(t)
        d["role"] = r.get("role", "viewer")
        # Trip-relative note lives on the edge (the Person/User node is shared
        # across trips after claim); missing on old edges -> None.
        d["note"] = r.get("note")
        crew.append(M.Person.model_validate(d))

    # ---- days + their blocks ---------------------------------------------
    day_ids = targets(root_id, "hasDay")
    days: list[M.Day] = []
    for did in day_ids:
        t = twin_of(did)
        if not t:
            continue
        d = _bydict(t)
        d["blocks"] = [block_from(bid, loc_name_by_id) for bid in targets(did, "hasBlock")]
        days.append(M.Day.model_validate(d))

    # ---- features ---------------------------------------------------------
    features: list[M.Feature] = []
    for fid in targets(root_id, "hasFeature"):
        t = twin_of(fid)
        if t:
            features.append(M.Feature.model_validate(_bydict(t)))

    # ---- sections (grouping + ideation blocks) --------------------------
    sections: list[M.TripSection] = []
    for sid in targets(root_id, "hasSection"):
        t = twin_of(sid)
        if not t:
            continue
        d = _bydict(t)
        # section → Day edges resolve to day indices in trip.days order
        sec_day_ids = set(targets(sid, "hasDay"))
        d["days"] = _collapse_day_range(
            [i for i, did in enumerate(day_ids) if did in sec_day_ids]
        )
        # section → Location edges → location names (locationRefs)
        d["locationRefs"] = [
            loc_name_by_id[r["$targetId"]]
            for r in rels_by_src.get(sid, [])
            if r.get("$relationshipName") == "atLocation" and r.get("$targetId") in loc_name_by_id
        ]
        # section-owned unscheduled blocks (ideation)
        d["blocks"] = [block_from(bid, loc_name_by_id) for bid in targets(sid, "hasBlock")]
        sections.append(M.TripSection.model_validate(d))

    # ---- assemble ---------------------------------------------------------
    return M.Trip.model_validate(
        {
            "id": base["id"],
            "slug": base.get("slug", ""),
            "title": base.get("title", ""),
            "subtitle": base.get("subtitle", ""),
            "stage": base.get("stage", "idea"),
            "startDate": base.get("startDate"),
            "endDate": base.get("endDate"),
            "timezone": base.get("timezone"),
            "visibility": base.get("visibility", "private"),
            "claimToken": base.get("claimToken") or None,
            "cover": base.get("cover"),
            "coverCredit": base.get("coverCredit"),
            "map": base.get("map"),
            "summary": base.get("summary"),
            "theme": base.get("theme", {}),
            "coverStats": base.get("coverStats", []),
            "locations": locations,
            "stats": base.get("stats", []),
            "features": features,
            "sections": sections,
            "crew": crew,
            "practical": base.get("practical", {}),
            "days": days,
            "updated": base.get("updated"),
        }
    )
