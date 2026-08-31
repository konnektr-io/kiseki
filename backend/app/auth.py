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
`get_current_session` additionally resolves the OIDC userinfo profile
(email/name/picture — NOT in the access token) so ACL matching and future
profile features can use it; the profile is cached per token.
"""

from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import jwt
from fastapi import Header, HTTPException

from .config import AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_DOMAIN

# userinfo profiles are cached per access token (stable for the token's
# lifetime; only needed for ACL matching).
_USERINFO_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_USERINFO_TTL_S = 15 * 60.0


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


@dataclass
class AuthSession:
    """A validated bearer token plus the data derived from it.

    ``user`` is the raw token payload (claims: ``sub`` always, profile claims
    only if the token carries them). ``access_token`` is the raw token, needed
    for the OIDC ``/userinfo`` call. ``profile`` is the cached userinfo result
    (``email`` / ``name`` / ``picture`` …) — empty dict when unavailable.
    """

    user: dict[str, Any]
    access_token: str
    profile: dict[str, Any] = field(default_factory=dict)


def fetch_userinfo(access_token: str, domain: str | None = None) -> dict[str, Any]:
    """Resolve the OIDC userinfo profile for an access token (cached).

    Auth0 access tokens carry ``sub`` but not email/name by default — those
    live in the ID token / userinfo. Returns {} on any failure (callers treat
    that as 'unknown profile', never as a hard error)."""
    domain = domain or AUTH0_DOMAIN
    if not domain or not access_token:
        return {}
    now = time.monotonic()
    cached = _USERINFO_CACHE.get(access_token)
    if cached and now - cached[0] < _USERINFO_TTL_S:
        return cached[1]
    try:
        req = urllib.request.Request(
            f"https://{domain}/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            profile: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}
    _USERINFO_CACHE[access_token] = (now, profile)
    return profile


def get_current_session(
    authorization: str | None = Header(default=None),
) -> AuthSession:
    """FastAPI dependency: validated token + access token + userinfo profile."""
    if not AUTH0_DOMAIN or not AUTH0_CLIENT_ID:
        raise HTTPException(
            status_code=503,
            detail="Authentication is not configured on this server",
        )
    token = _extract_bearer(authorization)
    if token is None:
        raise _unauthorized("Missing bearer token")
    try:
        payload = _validator.validate(token)
    except AuthError as exc:
        raise _unauthorized(str(exc)) from exc
    return AuthSession(user=payload, access_token=token, profile=fetch_userinfo(token))


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


# Module-level validator bound to the deployment config (env-overridable).
# Tests swap `_validator` via monkeypatch to point at a local JWKS.
_validator = Auth0JWTValidator(AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE or None)
