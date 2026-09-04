#!/usr/bin/env python3
"""Kiseki content write-path client (issue #46) — the agent's one-liner.

A thin, zero-dependency HTTP client over the role-gated write API so Hermes
(and a future end-user agent profile) edits trip content without the old
workarounds (direct graph SDK PATCHes, reseeds, kubectl cp). Every command
prints the API response — for writes that is the canonical trip document
(media URLs canonicalized, claimToken absent).

    export KISEKI_TOKEN=<access token>              # 1. USER token (dedicated/UI profile):
                                                    #    ACL + x-user-id follow its sub.
                                                    # 2. M2M client token on the home profile:
                                                    #    acts AS Niko (KISEKI_AGENT_ACT_AS),
                                                    #    no user token needed.
                                                    # 3. M2M alone: owner fallback (unattended).
    python scripts/api_write.py get /api/trips/<trip_id>
    python scripts/api_write.py put /api/trips/<trip_id> --json '{"stage": "booked"}'
    python scripts/api_write.py post /api/trips/<trip_id>/blocks \
        --json '{"kind": "lodging", "title": "Banff Inn", \
                 "container": {"type": "day", "id": "<day-id>"}}'
    python scripts/api_write.py post /api/trips/<trip_id>/practical/todos/0/toggle --json '{"done": true}'
    python scripts/api_write.py delete /api/trips/<trip_id>/blocks/<block_id>
    python scripts/api_write.py put /api/trips/<trip_id>/practical --file body.json

Endpoint reference: AGENTS.md → "Content update".

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
    ap.add_argument("method", choices=["get", "put", "post", "patch", "delete"])
    ap.add_argument("path", help="API path, e.g. /api/trips/<trip_id>/blocks")
    ap.add_argument("--json", help="JSON body inline")
    ap.add_argument("--file", help="JSON body from file ('-' = stdin)")
    ap.add_argument("--token", help="Bearer token (default: $KISEKI_TOKEN)")
    ap.add_argument("--base", default=BASE_URL, help=f"API base (default: {BASE_URL})")
    args = ap.parse_args()

    token = args.token or os.environ.get("KISEKI_TOKEN")
    if token is None:
        raise SystemExit("error: no token — pass --token or set KISEKI_TOKEN")

    body = _read_body(args)
    url = args.base.rstrip("/") + ("/" + args.path.lstrip("/") if args.path else "")
    req = urllib.request.Request(url, method=args.method.upper(), data=body)
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
