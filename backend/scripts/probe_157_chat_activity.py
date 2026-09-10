#!/usr/bin/env python3
"""Issue #157 UI probe — activity feed + single thinking row, in a REAL browser.

Serves the WORKTREE build, mounts the landing chat in `?kiseki_e2e=1` mode
(Auth0 stubbed signed-in), patches `window.fetch` so POST /api/chat returns a
DELAYED SSE stream (deterministic phases — no upstream dependency), and
asserts the RENDERED result at each phase of the turn:

  A. submitted, nothing yet       → exactly ONE "Agent is thinking"
  B. activity part opened         → the labeled row spins, thinking row GONE
  C. activity part completed      → the row shows ✓ (spinner gone)
  D. turn finished                → answer text present, no residue

The OLD-wire mode (`--old-wire`) replays the pre-#157 synthetic tool-lifecycle
chunks for the authentic baseline: old UI + old wire must reproduce the bug
(doubled thinking, zero activity rows).

Run (worktree):  cd backend && uv run -p 3.13 python scripts/probe_157_chat_activity.py [--old-wire] [--base URL]
"""
from __future__ import annotations

import argparse
import glob
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8000"
CHROME_GLOB = (
    "/opt/hermes/.playwright/*/chrome-headless-shell-linux64/chrome-headless-shell"
)

TURN_ID = "probe157turn"
PART = "data-kiseki-activity"
LABEL = "Running a command…"


def _data_chunk(c: dict) -> str:
    return "data: " + json.dumps(c) + "\n\n"


def _done_chunk(call_id: str, label: str) -> dict:
    return {"type": PART, "id": call_id, "data": {"label": label, "done": True}}


def _start_chunk(call_id: str, label: str) -> dict:
    return {"type": PART, "id": call_id, "data": {"label": label, "done": False}}


def stream_phases(old_wire: bool) -> list[tuple[int, list[str]]]:
    """(delay_ms, [sse strings]) — the timed turn wire.

    New wire (issue #157): activity opens as a data part (spinner), deltas
    stream, the part completes with done=true, terminal.
    Old wire (pre-#157 baseline): synthetic tool-lifecycle chunks under the
    undeclared `kiseki-activity` tool.
    """
    call_id = f"{TURN_ID}-tool-1"
    if old_wire:
        return [
            (700, [_data_chunk({"type": "text-start", "id": TURN_ID})]),
            (700, [
                _data_chunk({
                    "type": "tool-input-start",
                    "toolCallId": call_id,
                    "toolName": "kiseki-activity",
                }),
                _data_chunk({
                    "type": "tool-input-available",
                    "toolCallId": call_id,
                    "toolName": "kiseki-activity",
                    "input": {"label": LABEL},
                }),
            ]),
            (700, [_data_chunk({"type": "text-delta", "id": TURN_ID, "delta": "Working on it"})]),
            (700, [
                _data_chunk({
                    "type": "tool-output-available",
                    "toolCallId": call_id,
                    "output": {"done": True},
                }),
            ]),
            (500, [
                _data_chunk({"type": "text-delta", "id": TURN_ID, "delta": " — done."}),
                _data_chunk({"type": "text-end", "id": TURN_ID}),
                _data_chunk({"type": "finish", "finishReason": "stop"}),
                "data: [DONE]\n\n",
            ]),
        ]
    return [
        (700, [_data_chunk({"type": "text-start", "id": TURN_ID})]),
        (700, [_data_chunk(_start_chunk(call_id, LABEL))]),
        (700, [_data_chunk({"type": "text-delta", "id": TURN_ID, "delta": "Working on it"})]),
        (700, [_data_chunk(_done_chunk(call_id, LABEL))]),
        (500, [
            _data_chunk({"type": "text-delta", "id": TURN_ID, "delta": " — done."}),
            _data_chunk({"type": "text-end", "id": TURN_ID}),
            _data_chunk({"type": "finish", "finishReason": "stop"}),
            "data: [DONE]\n\n",
        ]),
    ]


FETCH_PATCH_TEMPLATE = """
(() => {
  const realFetch = window.fetch.bind(window);
  const enc = new TextEncoder();
  const PHASES = __PHASES__;  // [[delayMs, ["data: ...\\n\\n", ...]], ...]
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.includes("/api/chat")) return realFetch(input, init);
    const stream = new ReadableStream({
      async start(controller) {
        for (const [delayMs, frames] of PHASES) {
          await new Promise((r) => setTimeout(r, delayMs));
          for (const f of frames) controller.enqueue(enc.encode(f));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    });
  };
})();
"""

TRIPS_BODY = json.dumps({
    "trips": [
        {
            "dtId": "0f2f6bc9-probe-trip-4f0d-9d8f-157probe000001",
            "slug": "probe-157",
            "title": "Probe trip",
            "subtitle": "",
            "stage": "idea",
            "visibility": "private",
            "cover": None,
            "startDate": "2027-01-10",
            "endDate": "2027-01-14",
            "role": "owner",
        }
    ]
})


def console_errors(page) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    page.on(
        "console",
        lambda msg: errors.append(f"console.error: {msg.text}")
        if msg.type == "error"
        else None,
    )
    return errors


# --- mid-turn measurement helpers (all read the RENDERED dialog) ----------

MEASURE = """() => {
  const dlg = document.querySelector('[role="dialog"]');
  const text = dlg ? dlg.innerText : "";
  const feed = dlg ? dlg.querySelector('[aria-label="Agent activity"]') : null;
  const rows = feed ? [...feed.children] : [];
  return {
    thinking: (text.match(/Agent is thinking/g) || []).length,
    rows: rows.length,
    rowLabels: rows.map((r) => r.innerText.trim()),
    spinnersInFeed: feed ? feed.querySelectorAll(".animate-spin").length : 0,
    busy: !!document.querySelector('[aria-label="Stop generating"]'),
    hasAnswer: text.includes("— done."),
    text,
  };
}"""


def wait_until(page, predicate, timeout_ms=6000, poll_ms=120):
    """Poll the MEASURE snapshot until predicate(m) holds; return last m."""
    waited = 0
    m = page.evaluate(MEASURE)
    while not predicate(m) and waited < timeout_ms:
        page.wait_for_timeout(poll_ms)
        waited += poll_ms
        m = page.evaluate(MEASURE)
    return m


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-wire", action="store_true",
                    help="replay the pre-#157 tool-lifecycle wire (baseline)")
    ap.add_argument("--base", default=BASE)
    args = ap.parse_args()
    base = args.base

    shells = sorted(glob.glob(CHROME_GLOB))
    with sync_playwright() as p:
        browser = (
            p.chromium.launch(executable_path=shells[-1], args=["--no-sandbox"])
            if shells
            else p.chromium.launch(args=["--no-sandbox"])
        )
        pg = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = console_errors(pg)

        def trips_ok(route):
            route.fulfill(
                status=200,
                headers={"content-type": "application/json"},
                body=TRIPS_BODY,
            )

        pg.route("**/api/trips**", trips_ok)

        phases = stream_phases(args.old_wire)
        pg.add_init_script(
            FETCH_PATCH_TEMPLATE.replace("__PHASES__", json.dumps(phases))
        )
        pg.add_init_script("window.__KISEKI_ACCESS_TOKEN__ = 'probe-token';")
        pg.goto(f"{base}/?kiseki_e2e=1", wait_until="domcontentloaded")
        pg.wait_for_timeout(2500)

        pg.get_by_role("button", name="Ask Kiseki").click()
        pg.wait_for_timeout(500)
        pg.get_by_role("textbox", name="Chat message").fill("do a tool call please")
        pg.get_by_role("button", name="Send message").click()

        timeline: dict[str, object] = {}

        # Phase A: submitted, no activity yet → exactly one thinking row
        mA = wait_until(pg, lambda m: m["busy"], timeout_ms=4000)
        timeline["A_submitted"] = mA
        pg.screenshot(path="/tmp/probe-157-A-submitted.png")

        # Phase B: activity row opened (label present in the feed)
        mB = wait_until(pg, lambda m: m["rows"] >= 1 or bool(m["hasAnswer"]), timeout_ms=5000)
        timeline["B_activity_open"] = mB
        pg.screenshot(path="/tmp/probe-157-B-activity-open.png")

        # Phase C: the row completed (spinner gone from the feed)
        mC = wait_until(pg, lambda m: (not m["spinnersInFeed"]) or m["hasAnswer"], timeout_ms=5000)
        timeline["C_activity_done"] = mC
        pg.screenshot(path="/tmp/probe-157-C-activity-done.png")

        # Phase D: turn settled (busy cleared)
        mD = wait_until(pg, lambda m: not m["busy"], timeout_ms=6000)
        timeline["D_settled"] = mD

        shot = "/tmp/probe-157-%s.png" % ("before-oldwire" if args.old_wire else "after")
        pg.screenshot(path=shot)
        browser.close()

    print(json.dumps({
        "mode": "before-oldwire" if args.old_wire else "after",
        "timeline": timeline,
        "console_errors": errors[:10],
        "screenshot": shot,
    }, indent=2))

    failures: list[str] = []
    if args.old_wire:
        # Baseline (informational): expect the BUG — rows never render and
        # thinking DOUBLES while the old chunks sit unprocessed.
        b = timeline["B_activity_open"]
        if b["rows"] != 0:
            print(f"baseline note: expected 0 rows on the old wire, got {b['rows']}", file=sys.stderr)
        if b["thinking"] < 2:
            print(f"baseline note: expected doubled thinking on the old wire, got {b['thinking']}", file=sys.stderr)
    else:
        a, b, c, d = (
            timeline["A_submitted"],
            timeline["B_activity_open"],
            timeline["C_activity_done"],
            timeline["D_settled"],
        )
        if a["busy"] and a["thinking"] != 1:
            failures.append(f"A: thinking must be exactly 1 while submitted, got {a['thinking']}")
        if b["rows"] < 1 or not any(LABEL in r for r in b["rowLabels"]):
            failures.append(f"B: labeled activity row missing; rows={b['rows']} labels={b['rowLabels']}")
        if b["thinking"] != 0:
            failures.append(f"B: thinking row must be GONE once activity shows, got {b['thinking']}")
        if b["spinnersInFeed"] < 1 and not b["hasAnswer"]:
            failures.append("B: open activity row must spin")
        if c["spinnersInFeed"] != 0:
            failures.append(f"C: completed activity row must show the check, spinner still present")
        if not d["hasAnswer"]:
            failures.append("D: answer text missing after the turn")
        if d["thinking"] > 0:
            failures.append(f"D: thinking residue after turn end: {d['thinking']}")
        if errors:
            failures.append(f"console errors: {errors[:3]}")

    if failures:
        print("PROBE_FAIL:")
        for f in failures:
            print("  -", f)
        return 1
    print("PROBE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
