"""Per-trip access control (issue #5 — ACL enforcement).

The API has two read paths that share one URL space, distinguished by the
path parameter's SHAPE (a dashed UUID is a trip ``$dtId``; anything else is a
secret share token — tokens are 32-hex, never dashed):

    GET /api/trips/<dashed-uuid>   → PROTECTED: valid Auth0 token + crew role
    GET /api/trips/<token>         → public-by-link (the share link), no auth

(The ``:uuid`` Starlette path converter can't be used to separate the routes —
it accepts compact dashless UUIDs, which are indistinguishable from share
tokens — so one route branches in ``authorize_trip_path``.)

Role ladder (trip-relative, carried on the ``hasCrew`` edge):
    follower(1) < viewer(2) < editor(3) < owner(4)
Read access = viewer+; write endpoints (future) = editor+; invites = owner.
"""

from __future__ import annotations

import re

from fastapi import Header, HTTPException

from .auth import get_current_session
from .store import get_trip_role_for_user

ROLE_RANK = {"follower": 1, "viewer": 2, "editor": 3, "owner": 4}

# Trip $dtIds are opaque dashed UUIDs; share tokens are NOT dashed (32-hex).
_DASHED_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def is_trip_id(param: str) -> bool:
    """True when the path param is a trip ``$dtId`` (dashed UUID) — i.e. the
    protected path — rather than a secret share token."""
    return bool(_DASHED_UUID_RE.match(param))


def _role_ok(role: str | None, min_role: str) -> bool:
    return role is not None and ROLE_RANK.get(role, 0) >= ROLE_RANK.get(min_role, 0)


def authorize_trip_path(
    trip_param: str,
    authorization: str | None = Header(default=None),
) -> None:
    """FastAPI dependency for ``GET /api/trips/{trip_param}``.

    - share token (non-dashed) → anonymous allowed (public-by-link); the
      Authorization header is ignored entirely (the endpoint is public)
    - dashed UUID ($dtId)      → require a valid token (401) AND a crew role
      at or above ``viewer`` (403 otherwise)
    """

    if not is_trip_id(trip_param):
        return  # secret share link — public by design
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    session = get_current_session(authorization)  # validates; 401 on invalid
    role = get_trip_role_for_user(
        trip_param.lower(),
        session.user["sub"],
        session.profile.get("email"),
        session.profile.get("name"),
    )
    if not _role_ok(role, "viewer"):
        raise HTTPException(
            status_code=403,
            detail="You don't have access to this trip",
        )
