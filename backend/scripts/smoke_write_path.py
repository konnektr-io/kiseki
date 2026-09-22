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

    export KISEKI_API_KEY=<admin key> KISEKI_ACT_AS_SUB=<acting user sub>
    python scripts/smoke_write_path.py --trip <trip_id>

Admin API-key calls MUST always impersonate a user; without
``KISEKI_ACT_AS_SUB`` the smoke refuses to run.

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


def _auth_headers() -> dict[str, str]:
    """Credential headers (issue #324): admin API key first, bearer fallback.

    An admin API key MUST always impersonate a user: ``KISEKI_ACT_AS_SUB``
    rides as ``X-Act-As-Sub`` and becomes the graph ``x-user-id``.
    """
    key = os.environ.get("KISEKI_API_KEY")
    if key:
        act_as = (os.environ.get("KISEKI_ACT_AS_SUB") or "").strip()
        if not act_as:
            print(
                "KISEKI_API_KEY requires KISEKI_ACT_AS_SUB "
                "(API-key calls must always impersonate a user)"
            )
            raise SystemExit(2)
        return {"X-API-Key": key, "X-Act-As-Sub": act_as}
    return {"Authorization": f"Bearer {os.environ.get('KISEKI_TOKEN', '')}"}


def _req(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    headers = dict(_auth_headers())
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
    if not (os.environ.get("KISEKI_API_KEY") or os.environ.get("KISEKI_TOKEN")):
        print("KISEKI_API_KEY (preferred, quota-free) or KISEKI_TOKEN is required (editor+)")
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
    target_sec: dict | None = None  # day-range section under test (try/finally shared)

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
            # (#378) the ORDER must be persisted: the chapter chip row and the
            # section map render `locationRefs` in list order, so a reversed
            # list has to read back reversed. Before #378 the write stored only
            # the edge SET and the live graph returned its own traversal order,
            # so a reorder was a silent no-op and a newly added ref read back
            # first. Runs on ≥2 refs, with or without a spare registry location.
            if len(orig_refs) >= 2:
                reversed_refs = list(reversed(orig_refs))
                st, doc_rev = _req("PUT", f"/api/trips/{tid}/sections/{section['id']}",
                                   {"locationRefs": reversed_refs})
                got = next((x.get("locationRefs") for x in doc_rev.get("sections", [])
                            if x["id"] == section["id"]), None)
                check("PUT /sections locationRefs order round-trip (#378)",
                      st == 200 and got == reversed_refs)
            else:
                print("  (skip) section has <2 refs — no order to reverse")
        else:
            print("  (skip) no section with locationRefs to exercise")

        # --- 3. section day-range trim + extend (hasDay edges under a section) ---
        # issue #341: the extend path 500'd live while every recorded smoke run
        # printed "(skip)" — the documented smoke trip's LAST section covers a
        # single day. Prefer the last multi-day section, fall back to the first
        # multi-day section anywhere; skip only when the trip has none.
        last_sec = trip["sections"][-1]
        multi = [s for s in trip["sections"]
                 if len(s.get("days") or []) == 2 and s["days"][1] > s["days"][0]]
        target_sec = last_sec if last_sec in multi else (multi[0] if multi else None)
        if target_sec is not None:
            lo = target_sec["days"][0]
            st, _ = _req("PUT", f"/api/trips/{tid}/sections/{target_sec['id']}",
                         {"days": [lo, lo]})
            check("PUT /sections trim days (hasDay delete)", st == 200)
            st, _ = _req("PUT", f"/api/trips/{tid}/sections/{target_sec['id']}",
                         {"days": [lo, lo + 1]})
            check("PUT /sections extend days (hasDay upsert)", st == 200)
        else:
            print("  (skip) no multi-day section to trim/extend")

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
        if target_sec is not None:
            st, doc4 = _req("PUT", f"/api/trips/{tid}/sections/{target_sec['id']}",
                            {"days": [target_sec["days"][0], target_sec["days"][1]]})
            s = next((x for x in doc4.get("sections", []) if x["id"] == target_sec["id"]), {})
            check("cleanup: section days restored", st == 200 and s.get("days") == target_sec["days"])
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
