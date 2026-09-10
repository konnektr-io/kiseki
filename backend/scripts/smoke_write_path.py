"""Live write-path smoke test — relationship writes included (issue #89).

Why this exists: the write-path unit tests run against ``FakeGraph``, which can
never prove the HTTP layer talks to the Konnektr Graph correctly. In #89 the
relationship-write layer WAS broken in production (deletes passed the trip as
the edge's source twin; the read path dropped ``$relationshipId``) while every
test stayed green, because no live smoke had ever exercised an edge write.

This script runs reversible relationship writes against a LIVE trip through
the public API and restores every mutation in ``finally`` (block create/move/
delete; section locationRefs add/remove; section day-range trim/restore). A
green run proves the graph honors edge writes under their real source twins.

Usage (after any write-path deploy):

    export KISEKI_TOKEN=<M2M or user token — must resolve to editor+ on the trip>
    python scripts/smoke_write_path.py --trip <trip_id>

Zero dependencies (stdlib urllib), mirrors api_write.py.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("KISEKI_BASE", "https://kiseki.konnektr.io")
FAILURES: list[str] = []


def _req(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    token = os.environ.get("KISEKI_TOKEN", "")
    headers = {"Authorization": f"Bearer {token}"}
    data = json.dumps(body).encode() if body is not None else None
    if data:
        headers["content-type"] = "application/json"
    r = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}

def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--trip", required=True, help="trip $dtId to exercise (editor+ role required)")
    args = ap.parse_args()
    tid = args.trip
    if not os.environ.get("KISEKI_TOKEN"):
        print("KISEKI_TOKEN is required (editor+ on the trip)")
        return 2

    st, trip = _req("GET", f"/api/trips/{tid}")
    check("GET trip", st == 200)
    if st != 200:
        return 1

    # --- 1. block create / move / delete (hasBlock edges under a day) ----
    day = trip["days"][0]
    st, doc = _req("POST", f"/api/trips/{tid}/blocks", {
        "kind": "note", "title": "smoke-write-path", "container": {"type": "day", "id": day["id"]},
    })
    new_block = next((b for d in doc.get("days", []) for b in d.get("blocks", [])
                      if b.get("title") == "smoke-write-path"), None)
    check("POST /blocks (create twin + hasBlock)", st == 201 and new_block is not None)
    if not new_block:
        print("  aborting — cannot continue without a created block")
        return 1
    block_id = new_block["id"]

    try:
        # move day -> a section (hasBlock delete under day + upsert under section)
        sec = doc["sections"][-1]
        st, doc2 = _req("POST", f"/api/trips/{tid}/blocks/{block_id}/move",
                        {"container": {"type": "section", "id": sec["id"]}})
        moved = next((b for s in doc2.get("sections", []) for b in s.get("blocks", [])
                      if b.get("id") == block_id), None)
        check("POST /blocks/{id}/move day->section (rel write)", st == 200 and moved is not None)

        # --- 2. section locationRefs add + remove (atLocation under a section) ---
        section = next((s for s in trip["sections"] if s.get("locationRefs")), None)
        other = None
        orig_refs: list[str] = []
        if section:
            orig_refs = list(section["locationRefs"])
            other = next((loc["name"] for loc in trip["locations"]
                          if loc["name"] not in orig_refs), None)
            if other:
                st, _ = _req("PUT", f"/api/trips/{tid}/sections/{section['id']}",
                             {"locationRefs": orig_refs + [other]})
                check("PUT /sections add locationRef", st == 200)
                st, _ = _req("PUT", f"/api/trips/{tid}/sections/{section['id']}",
                             {"locationRefs": orig_refs})
                check("PUT /sections remove locationRef", st == 200)
            else:
                print("  (skip) no second registry location to toggle a ref with")
        else:
            print("  (skip) no section with locationRefs to exercise")

        # --- 3. section day-range trim + restore (hasDay edges under a section) ---
        last_sec = trip["sections"][-1]
        if last_sec["days"][1] > last_sec["days"][0]:
            lo = last_sec["days"][0]
            st, _ = _req("PUT", f"/api/trips/{tid}/sections/{last_sec['id']}",
                         {"days": [lo, lo]})
            check("PUT /sections trim days (hasDay delete)", st == 200)
            st, _ = _req("PUT", f"/api/trips/{tid}/sections/{last_sec['id']}",
                         {"days": [lo, lo + 1]})
            check("PUT /sections extend days (hasDay upsert)", st == 200)
        else:
            print("  (skip) last section covers a single day — nothing to trim")

        # --- 4. editorial fields (#178): coverStats/stats via PUT trip, features ---
        orig_cover_stats = trip.get("coverStats") or []
        orig_stats = trip.get("stats") or []
        st, _ = _req("PUT", f"/api/trips/{tid}",
                     {"coverStats": ["SMOKE · probe line"], "stats": [{"label": "smoke", "value": "1"}]})
        check("PUT /trips set coverStats+stats", st == 200)
        st, _ = _req("PUT", f"/api/trips/{tid}",
                     {"coverStats": orig_cover_stats, "stats": orig_stats})
        check("PUT /trips restore coverStats+stats", st == 200)

        st, doc5 = _req("PUT", f"/api/trips/{tid}/features", {"features": [
            {"title": "smoke-write-path-card", "kicker": "SMOKE", "chips": ["probe"]},
        ] + [
            {"title": f["title"]} for f in trip.get("features", []) if f["title"] != "smoke-write-path-card"
        ]})
        probe = next((f for f in doc5.get("features", [])
                      if f.get("title") == "smoke-write-path-card"), None)
        check("PUT /features (Feature twin + hasFeature edge)", st == 200 and probe is not None)
        st, doc6 = _req("PATCH", f"/api/trips/{tid}/features", {"features": [
            {"id": probe["id"], "title": probe["title"], "description": "patched by smoke"} if probe else {}
        ]} if probe else None)
        patched = next((f for f in doc6.get("features", [])
                        if f.get("id") == (probe or {}).get("id")), None)
        check("PATCH /features (named upsert)", bool(st == 200 and patched
               and patched.get("description") == "patched by smoke"))
    finally:
        # --- always restore ---
        st, _ = _req("DELETE", f"/api/trips/{tid}/blocks/{block_id}")
        check("cleanup: DELETE /blocks/{id}", st == 200)
        if section and other:
            st, doc3 = _req("PUT", f"/api/trips/{tid}/sections/{section['id']}",
                            {"locationRefs": orig_refs})
            s = next((x for x in doc3.get("sections", []) if x["id"] == section["id"]), {})
            check("cleanup: section refs restored", st == 200 and s.get("locationRefs") == orig_refs)
        if last_sec["days"][1] > last_sec["days"][0]:
            st, doc4 = _req("PUT", f"/api/trips/{tid}/sections/{last_sec['id']}",
                            {"days": [last_sec["days"][0], last_sec["days"][1]]})
            s = next((x for x in doc4.get("sections", []) if x["id"] == last_sec["id"]), {})
            check("cleanup: section days restored", st == 200 and s.get("days") == last_sec["days"])
        st, doc7 = _req("PUT", f"/api/trips/{tid}/features",
                        {"features": [{"title": f["title"]} for f in trip.get("features", [])]})
        feats = [f["title"] for f in doc7.get("features", [])] if st == 200 else []
        check("cleanup: original features restored",
              st == 200 and feats == [f["title"] for f in trip.get("features", [])])

    print()
    if FAILURES:
        print(f"SMOKE FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("SMOKE PASS — relationship writes round-trip against the live graph")
    return 0


if __name__ == "__main__":
    sys.exit(main())
