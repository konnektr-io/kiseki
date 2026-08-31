"""Auth0 JWT validation for the Kiseki API.

Stateless RS256 validation of Auth0 access tokens (Authorization Code + PKCE
SPA flow). Signing keys come from the tenant's JWKS endpoint, fetched on demand
and cached by PyJWKClient (re-fetched automatically when a `kid` is unknown —
i.e. on key rotation).

Tokens are issued for the SPA client itself (aud = client id) unless the tenant
exposes a custom API and `AUTH0_AUDIENCE` is set — the validator accepts either
by defaulting the audience to the client id.

This is the identity layer for #5: `get_current_user` gives endpoints a
validated user; ACL enforcement (per-trip roles) lands on top of it next.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import jwt
from fastapi import Header, HTTPException

from .config import AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_DOMAIN


class AuthError(Exception):
    """Raised when a bearer token fails validation."""


@dataclass
class Auth0JWTValidator:
    """Validates Auth0 access tokens against a tenant's JWKS."""

    domain: str
    client_id: str
    audience: str | None = None
    jwks_uri: str | None = None  # override for tests
    _jwks: Any = field(init=False, repr=False, default=None)

    def __post_init__(self) -> None:
        uri = self.jwks_uri or f"https://{self.domain}/.well-known/jwks.json"
        self._jwks = jwt.PyJWKClient(uri)

    @property
    def _audience(self) -> str:
        return self.audience or self.client_id

    def validate(self, token: str) -> dict[str, Any]:
        """Verify signature/issuer/audience/expiry; return the token payload."""
        try:
            key = self._jwks.get_signing_key_from_jwt(token).key
            return jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=f"https://{self.domain}/",
                audience=self._audience,
                options={"require": ["exp", "sub", "iss", "aud"]},
            )
        except jwt.PyJWTError as exc:
            # PyJWTError is the root of ALL pyjwt exceptions — InvalidTokenError
            # (signature/issuer/audience/expiry) and PyJWKClientError (unknown
            # signing key) alike.
            raise AuthError(str(exc)) from exc


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, rest = authorization.partition(" ")
    if scheme.lower() != "bearer" or not rest.strip():
        return None
    return rest.strip()


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """FastAPI dependency: require a valid Auth0 access token."""
    if not AUTH0_DOMAIN or not AUTH0_CLIENT_ID:
        raise HTTPException(
            status_code=503,
            detail="Authentication is not configured on this server",
        )
    token = _extract_bearer(authorization)
    if token is None:
        raise _unauthorized("Missing bearer token")
    try:
        return _validator.validate(token)
    except AuthError as exc:
        raise _unauthorized(str(exc)) from exc


def get_current_user_optional(
    authorization: str | None = Header(default=None),
) -> dict[str, Any] | None:
    """FastAPI dependency: current user when a bearer token is sent, else None.

    For endpoints that serve both anonymous (secret-link) and authenticated
    visitors — an *invalid* token is still rejected (401)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return get_current_user(authorization)


# Module-level validator bound to the deployment config (env-overridable).
# Tests swap `_validator` via monkeypatch to point at a local JWKS.
_validator = Auth0JWTValidator(AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE or None)
