"""Shared auth test infrastructure (issue #5).

A local JWKS HTTP server backed by a generated RSA keypair lets the
``Auth0JWTValidator`` exercise its real fetch → verify path with no mocked
signing step. ``_sign`` / ``_claims`` mint realistic tokens.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.graph import client as graph_client_mod

TENANT = "dev-test.eu.auth0.com"
CLIENT_ID = "test-client-123"
KID = "test-kid-1"


@pytest.fixture(autouse=True)
def _clear_graph_cache():
    """The graph client caches reads module-wide (TTL) — keep tests isolated."""
    graph_client_mod._clear_graph_cache()
    yield
    graph_client_mod._clear_graph_cache()


def _b64u_int(n: int) -> str:
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@pytest.fixture(scope="session")
def rsa_keypair() -> tuple[rsa.RSAPrivateKey, dict]:
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    numbers = private.public_key().public_numbers()
    jwk = {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": KID,
        "n": _b64u_int(numbers.n),
        "e": _b64u_int(numbers.e),
    }
    return private, jwk


@pytest.fixture(scope="session")
def jwks_url(rsa_keypair) -> Iterator[str]:
    """Serves the JWKS over HTTP so PyJWKClient fetches it for real."""
    _, jwk = rsa_keypair
    body = json.dumps({"keys": [jwk]}).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/.well-known/jwks.json"
    server.shutdown()


def _sign(
    rsa_keypair: tuple[rsa.RSAPrivateKey, dict],
    claims: dict,
    kid: str = KID,
) -> str:
    private, _ = rsa_keypair
    return pyjwt.encode(claims, private, algorithm="RS256", headers={"kid": kid})


def _claims(**overrides: object) -> dict:
    now = int(time.time())
    base: dict = {
        "iss": f"https://{TENANT}/",
        "sub": "google-oauth2|1234567890",
        "aud": CLIENT_ID,
        "azp": CLIENT_ID,
        "iat": now,
        "exp": now + 3600,
        "scope": "openid profile email offline_access",
    }
    base.update(overrides)
    return base
