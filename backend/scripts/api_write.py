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
visibility and NOTHING else — locations, sections, stats, days and blocks
all live behind their own nested endpoints. Build a trip in this order:

1. create-trip --title "…" [--subtitle "…"]      POST /api/trips (201)
2. PUT /api/trips/<trip_id>                      scalars via --json/--file
3. PUT /api/trips/<trip_id>/locations            full-array replace
   (or PATCH …/locations for named upserts)
4. POST /api/trips/<trip_id>/sections            (+ PUT …/sections/<id>
   to set/move the day range; inclusive [first, last], no overlap)
5. POST /api/trips/<trip_id>/days                insert/append days
6. POST /api/trips/<trip_id>/blocks              `order` is server-managed
   (container: {"type": "day"|"section", "id": …}) — never send it

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
import json
import os
import sys
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("method", choices=["get", "put", "post", "patch", "delete", "create-trip"])
    ap.add_argument("path", nargs="?", default=None,
                    help="API path, e.g. /api/trips/<trip_id>/blocks (omit for create-trip)")
    ap.add_argument("--json", help="JSON body inline")
    ap.add_argument("--file", help="JSON body from file ('-' = stdin)")
    ap.add_argument("--title", help="Trip title (create-trip only)")
    ap.add_argument("--subtitle", help="Trip subtitle (create-trip only)")
    ap.add_argument("--token", help="Bearer token (default: $KISEKI_TOKEN)")
    ap.add_argument("--base", default=BASE_URL, help=f"API base (default: {BASE_URL})")
    args = ap.parse_args()

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
