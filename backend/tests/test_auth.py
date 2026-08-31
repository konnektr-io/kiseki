"""Auth0 JWT validation tests (issue #5 — identity layer).

The shared JWKS-server fixtures live in ``conftest.py`` — the validator
fetches the tenant JWKS over HTTP, so the full fetch → verify path is
exercised with no mocked signing step.
"""

from __future__ import annotations

import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app import auth as auth_module
from app.auth import Auth0JWTValidator
from app.main import app

from conftest import CLIENT_ID, KID, TENANT, _claims, _sign


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
