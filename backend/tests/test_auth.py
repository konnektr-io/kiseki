"""Auth0 JWT validation tests (issue #5 — identity layer).

The validator fetches the tenant JWKS over HTTP, so these tests spin a local
JWKS server backed by a generated RSA keypair: the full fetch → verify path is
exercised with no mocked signing step.
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
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app import auth as auth_module
from app.auth import Auth0JWTValidator
from app.main import app

TENANT = "dev-test.eu.auth0.com"
CLIENT_ID = "test-client-123"
KID = "test-kid-1"


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


@pytest.fixture
def validator(jwks_url: str) -> Auth0JWTValidator:
    return Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url)


# ---------------------------------------------------------------- validator


def test_valid_token_returns_payload(rsa_keypair, validator: Auth0JWTValidator) -> None:
    token = _sign(rsa_keypair, _claims())
    payload = validator.validate(token)
    assert payload["sub"] == "google-oauth2|1234567890"
    assert payload["aud"] == CLIENT_ID


def test_expired_token_rejected(rsa_keypair, validator: Auth0JWTValidator) -> None:
    token = _sign(rsa_keypair, _claims(exp=int(time.time()) - 60))
    with pytest.raises(auth_module.AuthError, match="expired"):
        validator.validate(token)


def test_wrong_issuer_rejected(rsa_keypair, validator: Auth0JWTValidator) -> None:
    token = _sign(rsa_keypair, _claims(iss="https://evil.example/"))
    with pytest.raises(auth_module.AuthError, match="Invalid issuer"):
        validator.validate(token)


def test_wrong_audience_rejected(rsa_keypair, validator: Auth0JWTValidator) -> None:
    token = _sign(rsa_keypair, _claims(aud="https://some-other-api.example"))
    with pytest.raises(auth_module.AuthError, match="Audience"):
        validator.validate(token)


def test_malformed_token_rejected(validator: Auth0JWTValidator) -> None:
    with pytest.raises(auth_module.AuthError):
        validator.validate("not.a.jwt")


def test_unknown_signing_key_rejected(
    rsa_keypair, validator: Auth0JWTValidator
) -> None:
    # kid not in the JWKS → PyJWKClient re-fetches, still unknown → rejected
    token = _sign(rsa_keypair, _claims(), kid="some-other-kid")
    with pytest.raises(auth_module.AuthError):
        validator.validate(token)


def test_bad_signature_rejected(rsa_keypair, validator: Auth0JWTValidator) -> None:
    other_private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = pyjwt.encode(_claims(), other_private, algorithm="RS256", headers={"kid": KID})
    with pytest.raises(auth_module.AuthError):
        validator.validate(token)


def test_custom_audience_required(rsa_keypair, jwks_url: str) -> None:
    v = Auth0JWTValidator(
        domain=TENANT,
        client_id=CLIENT_ID,
        audience="https://kiseki.konnektr.io/api",
        jwks_uri=jwks_url,
    )
    with pytest.raises(auth_module.AuthError, match="Audience"):
        v.validate(_sign(rsa_keypair, _claims()))  # aud = client id, not the API
    token = _sign(rsa_keypair, _claims(aud="https://kiseki.konnektr.io/api"))
    assert v.validate(token)["sub"] == "google-oauth2|1234567890"


# ---------------------------------------------------------------- endpoint


@pytest.fixture
def client(rsa_keypair, jwks_url: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth_module, "AUTH0_DOMAIN", TENANT)
    monkeypatch.setattr(auth_module, "AUTH0_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(
        auth_module,
        "_validator",
        Auth0JWTValidator(domain=TENANT, client_id=CLIENT_ID, jwks_uri=jwks_url),
    )
    return TestClient(app)


def test_me_requires_token(client: TestClient) -> None:
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate") == "Bearer"


def test_me_rejects_garbage_token(client: TestClient) -> None:
    resp = client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"})
    assert resp.status_code == 401


def test_me_rejects_basic_auth_scheme(client: TestClient) -> None:
    resp = client.get("/api/auth/me", headers={"Authorization": "Basic abc"})
    assert resp.status_code == 401


def test_me_with_valid_token(client: TestClient, rsa_keypair) -> None:
    token = _sign(rsa_keypair, _claims())
    resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["sub"] == "google-oauth2|1234567890"


def test_me_with_profile_claims(client: TestClient, rsa_keypair) -> None:
    token = _sign(
        rsa_keypair,
        _claims(
            email="niko@example.com",
            name="Niko Raes",
            picture="https://example.com/avatar.png",
            email_verified=True,
        ),
    )
    resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["email"] == "niko@example.com"
    assert body["name"] == "Niko Raes"
    assert body["picture"] == "https://example.com/avatar.png"
    assert body["email_verified"] is True


def test_me_rejects_expired_token(client: TestClient, rsa_keypair) -> None:
    token = _sign(rsa_keypair, _claims(exp=int(time.time()) - 60))
    resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401
