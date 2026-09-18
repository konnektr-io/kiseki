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

import hashlib
import hmac
import json
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import jwt
from fastapi import Header, HTTPException

from .config import AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_DOMAIN, KISEKI_API_KEYS

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
        """Verify signature/issuer/audience/expiry; return the payload."""
        if self._is_jwe(token):
            # JWE (encrypted) token — Auth0 issues these to SPA clients when NO
            # audience is requested. We cannot verify them (and this PyJWT
            # version has no JWE support — it would misread the ciphertext as a
            # payload and fail cryptically); the fix is an audience, not
            # decryption.
            raise AuthError(
                "Access token is encrypted (JWE) — Auth0 issues JWE tokens "
                "to SPA clients without an audience. Create an API in the "
                "Auth0 dashboard and set its identifier as the audience "
                "(AUTH0_AUDIENCE / VITE_AUTH0_AUDIENCE)."
            )
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

    @staticmethod
    def _is_jwe(token: str) -> bool:
        """Detect a JWE-encrypted token from its (unprotected) header segment.

        Parsed manually (plain base64) because this PyJWT version treats a
        5-segment JWE as a JWS and fails with a cryptic padding/payload error
        before any header inspection can happen.
        """
        try:
            import base64
            import json

            raw = token.split(".")[0]
            header = json.loads(
                base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
            )
        except Exception:
            return False
        return header.get("alg") == "dir" or bool(header.get("enc"))


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


def authenticate_user(
    authorization: str | None = None,
    x_api_key: str | None = None,
) -> dict[str, Any]:
    """Validate EITHER credential — bearer JWT first, admin API key second.

    The shared choke point (issue #324): ``get_current_user`` and the
    trip-path gates in ``acl`` (which hand-rolled the bearer-prefix check and
    so bypassed any credential added only to ``get_current_user``) all resolve
    here. Bearer present → JWT validation (401 with reason on failure);
    else a known ``X-API-Key`` → its synthetic service user; else 401.
    No config check — callers needing the 503 do it before calling.
    """
    token = _extract_bearer(authorization)
    if token is not None:
        try:
            return _validator.validate(token)
        except AuthError as exc:
            raise _unauthorized(str(exc)) from exc
    key_name = resolve_api_key(x_api_key)
    if key_name is not None:
        return api_key_user(key_name)
    raise _unauthorized("Missing bearer token")


# ---------------------------------------------------------------------------
# Admin API keys (issue #324)
#
# Quota-independent agent credentials: Auth0 is never consulted, so a spent
# M2M quota cannot block agents. Keys are minted offline (`secrets.token_*`,
# `ksk_` prefix); only `name:sha256hex` pairs live in KISEKI_API_KEYS.
# Presented as the `X-API-Key` header and validated with hmac.compare_digest.

API_KEY_PREFIX = "ksk_"


def parse_api_keys(raw: str | None) -> dict[str, str]:
    """`name → sha256hex` from the KISEKI_API_KEYS env shape.

    Malformed entries (no colon, empty name, non-hex/short digest) are
    SKIPPED, never half-accepted — a typo must disable one key, not open a
    hole or kill the whole table.
    """
    out: dict[str, str] = {}
    for entry in (raw or "").split(","):
        name, sep, digest = entry.strip().partition(":")
        name = name.strip()
        digest = digest.strip().lower()
        if not sep or not name:
            continue
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            continue
        out[name] = digest
    return out


def resolve_api_key(presented: str | None) -> str | None:
    """Key NAME for a presented API key, or None.

    Compares sha256(presented) against every configured digest in
    constant time. Returns None for missing/empty/unknown keys — callers
    answer 401 without saying which half failed.
    """
    if not presented or not presented.strip():
        return None
    want = hashlib.sha256(presented.strip().encode("utf-8")).hexdigest()
    for name, digest in parse_api_keys(KISEKI_API_KEYS).items():
        if hmac.compare_digest(want, digest):
            return name
    return None


def api_key_user(name: str) -> dict[str, Any]:
    """Synthetic user dict for a validated API key (issue #324).

    The `sub` is namespaced (`apikey:<name>@agents`) so it can never collide
    with a real Auth0 sub — and no twin is ever provisioned for it, because
    every provisioning route refuses service credentials (`require_user_token`
    covers API keys exactly like M2M). `api_key` marks the service credential:
    `acl` treats it exactly like the sanctioned M2M token (act-as-anyone via
    `X-Act-As-Sub`, refused on provisioning routes).
    """
    return {"sub": f"apikey:{name}@agents", "api_key": name}


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
    x_api_key: str | None = Header(default=None),
) -> AuthSession:
    """FastAPI dependency: validated token + access token + userinfo profile.

    Bearer first (unchanged); an `X-API-Key` admin key (issue #324) resolves
    to a service session with no userinfo profile and no access token.
    """
    if not AUTH0_DOMAIN or not AUTH0_CLIENT_ID:
        raise HTTPException(
            status_code=503,
            detail="Authentication is not configured on this server",
        )
    token = _extract_bearer(authorization)
    if token is not None:
        try:
            payload = _validator.validate(token)
        except AuthError as exc:
            raise _unauthorized(str(exc)) from exc
        return AuthSession(user=payload, access_token=token, profile=fetch_userinfo(token))
    key_name = resolve_api_key(x_api_key)
    if key_name is not None:
        return AuthSession(user=api_key_user(key_name), access_token="", profile={})
    raise _unauthorized("Missing bearer token")


def get_current_user(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any]:
    """FastAPI dependency: require a valid Auth0 access token or admin API key.

    Bearer first (unchanged); `X-API-Key` (issue #324) resolves to the key's
    synthetic service user. Either credential missing/invalid → 401.
    """
    if not AUTH0_DOMAIN or not AUTH0_CLIENT_ID:
        raise HTTPException(
            status_code=503,
            detail="Authentication is not configured on this server",
        )
    return authenticate_user(authorization, x_api_key)


# Module-level validator bound to the deployment config (env-overridable).
# Tests swap `_validator` via monkeypatch to point at a local JWKS.
_validator = Auth0JWTValidator(AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE or None)
