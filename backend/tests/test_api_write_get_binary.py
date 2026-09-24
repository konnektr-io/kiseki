"""`get` is binary-safe — the booklet PDF (issue #281).

The content agent's only write-path client assumed every response was JSON text
(`resp.read().decode("utf-8")`), so `get /api/trips/<id>/booklet.pdf` died with
`UnicodeDecodeError: 'utf-8' codec can't decode byte 0xd3 in position 10` while
the endpoint answered with a perfectly good PDF. The one artifact a traveler
actually exports was therefore unverifiable by design: the agent has no token in
its shell (minting is the wrapper's job, per the headless rule), so there was no
sanctioned `curl` path either.

These tests run the real CLI as a subprocess against a real HTTP server, because
the defect lived exactly at the byte→text boundary: a mocked `urlopen` hands back
an object the caller already decoded, so it would have proved nothing about the
bytes that come off a socket. The fixture PDF carries a genuine `0xd3` (the byte
from the reported traceback) at the same offset.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "api_write.py"

TRIP_ID = "bc537361-8d0a-4832-a7a1-36087719c812"

# A real-enough PDF: the magic header, then the byte sequence that killed the
# client (`0xd3` at offset 10, followed by another non-continuation byte).
PDF_BYTES = (
    b"%PDF-1.4\n"
    b"%\xd3\xeb\xe9\xe1\n"
    b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    b"2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"
    b"trailer\n<< /Root 1 0 R /Size 3 >>\n%%EOF\n"
)
TRIP_JSON = {"id": TRIP_ID, "title": "Japow 2026", "days": [{"id": "d1", "blocks": []}]}


class _Handler(BaseHTTPRequestHandler):
    """Serves the two shapes the booklet verification meets: a PDF and a trip."""

    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 — http.server's signature
        pass

    def do_GET(self):  # noqa: N802 — http.server's spelling
        self.server.seen.append((self.path, self.headers.get("Authorization")))  # type: ignore[attr-defined]
        if self.path == f"/api/trips/{TRIP_ID}/booklet.pdf":
            self._send(200, "application/pdf", PDF_BYTES)
        elif self.path == f"/api/trips/{TRIP_ID}":
            self._send(200, "application/json", json.dumps(TRIP_JSON).encode("utf-8"))
        else:
            self._send(404, "application/json", b'{"detail": "Not Found"}')

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.seen = []  # type: ignore[attr-defined]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    httpd.base_url = f"http://127.0.0.1:{httpd.server_address[1]}"  # type: ignore[attr-defined]
    try:
        yield httpd
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def _run(server, *args: str) -> subprocess.CompletedProcess[str]:
    # Scrub an ambient KISEKI_API_KEY: _credential prefers the key over
    # KISEKI_TOKEN by design (#324), so a key in the developer's shell would
    # silently switch this test to the X-API-Key header and fail the Bearer
    # assertion below. The test pins KISEKI_TOKEN, so it must own the full
    # credential env.
    env = {k: v for k, v in os.environ.items() if k not in ("KISEKI_API_KEY", "KISEKI_ACT_AS_SUB")}
    env["KISEKI_TOKEN"] = "test-token"
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--base", server.base_url, *args],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )


def test_booklet_bytes_land_byte_identical_in_the_out_file(server, tmp_path):
    """The reported failure, end to end: a real PDF comes back as real bytes."""
    out = tmp_path / "booklet.pdf"

    result = _run(server, "get", f"/api/trips/{TRIP_ID}/booklet.pdf", "--out", str(out))

    assert result.returncode == 0, result.stderr
    assert "UnicodeDecodeError" not in result.stderr
    # Byte-identical, not "decoded then re-encoded" — a lossy round trip would
    # still produce a file that opens sometimes, which is worse than a crash.
    assert out.read_bytes() == PDF_BYTES
    assert out.read_bytes()[:4] == b"%PDF"  # what the agent asserts on
    # The one-line verdict instead of a 184 kB blob in the transcript.
    assert f"bytes={len(PDF_BYTES)} content-type=application/pdf" in result.stdout
    assert str(out) in result.stdout
    # The token still rides the request (this path is the sanctioned one).
    assert (f"/api/trips/{TRIP_ID}/booklet.pdf", "Bearer test-token") in server.seen


def test_a_binary_body_without_out_refuses_with_the_fix_not_a_traceback(server):
    """No `--out` → one actionable line naming `--out`, never a traceback."""
    result = _run(server, "get", f"/api/trips/{TRIP_ID}/booklet.pdf")

    assert result.returncode != 0
    assert "UnicodeDecodeError" not in result.stderr
    assert "Traceback" not in result.stderr
    assert "--out" in result.stderr and "booklet.pdf" in result.stderr


def test_json_responses_are_unchanged(server):
    """The JSON path is untouched — pretty-printed document, exit 0."""
    result = _run(server, "get", f"/api/trips/{TRIP_ID}")

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == TRIP_JSON


def test_out_also_sinks_a_json_body(server, tmp_path):
    """`--out` is a response sink, not a PDF special case."""
    out = tmp_path / "trip.json"

    result = _run(server, "get", f"/api/trips/{TRIP_ID}", "--out", str(out))

    assert result.returncode == 0, result.stderr
    assert json.loads(out.read_text(encoding="utf-8")) == TRIP_JSON
    assert f"bytes={len(json.dumps(TRIP_JSON).encode('utf-8'))} content-type=application/json" in result.stdout


def test_a_failed_fetch_never_leaves_a_stale_artifact(server, tmp_path):
    """A 404 clears the target: yesterday's booklet can't pass as today's.

    The whole point of the fetch is to verify a build that was just written, so
    a leftover file would be the most expensive kind of green.
    """
    out = tmp_path / "booklet.pdf"
    out.write_bytes(b"%PDF-1.4\nSTALE FROM A PREVIOUS RUN\n%%EOF\n")

    result = _run(server, "get", f"/api/trips/{TRIP_ID}/gone.pdf", "--out", str(out))

    # The client returns the HTTP status as its exit code (a shell can only see
    # the low byte: 404 → 148), so assert the failure + the message, not 404.
    assert result.returncode != 0
    assert "HTTP 404" in result.stderr
    assert not out.exists()


# ------------------------------------------------------------------ timeouts
#
# Issue #389: a booklet render is ~40s of Playwright + SwiftShader before the
# first byte, and the client waited a hard 30s — so the ONE artifact the agent
# exports could never be fetched, and the wait died as a raw
# `TimeoutError: The read operation timed out` traceback out of ssl.py. In an
# unattended round that costs the whole turn and yields no signal.


class _SlowHandler(_Handler):
    """Answers 5s late — longer than the timeout under test."""

    def do_GET(self):  # noqa: N802 — http.server's spelling
        time.sleep(5)
        super().do_GET()


@pytest.fixture()
def slow_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _SlowHandler)
    httpd.seen = []  # type: ignore[attr-defined]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    httpd.base_url = f"http://127.0.0.1:{httpd.server_address[1]}"  # type: ignore[attr-defined]
    try:
        yield httpd
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def _module():
    spec = importlib.util.spec_from_file_location("api_write_under_test", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_a_booklet_path_gets_a_render_sized_default_timeout():
    """The default is per call shape, not one global 30s that guarantees the
    booklet can never be fetched (issue #389)."""
    aw = _module()
    args = argparse.Namespace(timeout=None)

    assert aw._timeout_for(args, f"/api/trips/{TRIP_ID}/booklet.pdf") == aw.RENDER_TIMEOUT
    assert aw.RENDER_TIMEOUT > 40  # a render is ~40s before the first byte
    assert aw._timeout_for(args, f"/api/trips/{TRIP_ID}") == aw.TIMEOUT
    assert aw._timeout_for(args, "/api/trips") == aw.TIMEOUT


def test_an_explicit_timeout_overrides_both_defaults():
    aw = _module()

    assert aw._timeout_for(argparse.Namespace(timeout=5), f"/api/trips/{TRIP_ID}/booklet.pdf") == 5
    assert aw._timeout_for(argparse.Namespace(timeout=120), "/api/trips") == 120


def test_an_absurd_timeout_is_refused_client_side():
    """A typo must not hang an unattended round for hours."""
    aw = _module()

    for bad in (0, -1, 10_000):
        with pytest.raises(SystemExit, match="between 1 and 900"):
            aw._timeout_for(argparse.Namespace(timeout=bad), "/api/trips")


def test_a_timeout_reports_one_line_with_the_fix_not_a_traceback(slow_server, tmp_path):
    """The reported failure: a slow render used to surface as a traceback from
    deep inside ssl.py, saying nothing about what was waited on."""
    out = tmp_path / "booklet.pdf"
    out.write_bytes(b"%PDF-1.4\nSTALE FROM A PREVIOUS RUN\n%%EOF\n")

    result = _run(
        slow_server,
        "get",
        f"/api/trips/{TRIP_ID}/booklet.pdf",
        "--out",
        str(out),
        "--timeout",
        "1",
    )

    assert result.returncode != 0
    assert "Traceback" not in result.stderr
    assert "TimeoutError" not in result.stderr
    assert "timed out after 1s" in result.stderr
    assert "booklet.pdf" in result.stderr
    assert "--timeout" in result.stderr  # names the fix
    # A timed-out fetch leaves no artifact to be mistaken for a fresh one.
    assert not out.exists()


def test_a_timeout_on_a_plain_call_keeps_the_generic_hint(slow_server):
    """Only the render gets the booklet hint; a JSON call that times out says so
    without sending the caller chasing a Playwright render."""
    result = _run(slow_server, "get", "/api/trips/slow", "--timeout", "1")

    assert result.returncode != 0
    assert "Traceback" not in result.stderr
    assert "timed out after 1s" in result.stderr
    assert "booklet" not in result.stderr
