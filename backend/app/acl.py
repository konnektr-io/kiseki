"""Per-trip access control (issue #64 + #65 — visibility + crew/follower ACL).

Single read path since #64:

    GET /api/trips/{trip_id}   where trip_id is the trip $dtId (dashed UUID)

Access is gated by Trip.visibility:

- visibility == "public"  → anyone (no auth). If an Authorization header is
  present and valid, the caller's crew role (if any) is returned as myRole;
  an invalid token on a public trip is ignored (public means public).
- visibility == "private" → requires valid Auth0 token (401) + crew role at
  or above follower (403). Follower is the lowest read role (issue #65);
  viewer/editor/owner also pass. Role is the User twin whose $dtId is the auth sub
  (established by claiming or following, never by name/email).

Role ladder (trip-relative, on the hasCrew edge):
    follower(1) < viewer(2) < editor(3) < owner(4)
Read access = follower+; write endpoints (future) = editor+; invites = owner.
"""

from __future__ import annotations

from fastapi import Header, HTTPException

from .auth import get_current_user
from .store import get_trip_by_id, get_trip_role_for_user

ROLE_RANK = {"follower": 1, "viewer": 2, "editor": 3, "owner": 4}


def _role_ok(role: str | None, min_role: str) -> bool:
    return role is not None and ROLE_RANK.get(role, 0) >= ROLE_RANK.get(min_role, 0)


def authorize_trip_path(
    trip_id: str,
    authorization: str | None = Header(default=None),
) -> str | None:
    """FastAPI dependency for GET /api/trips/{trip_id} (and booklet.pdf).

    Returns the caller's crew role (or None for anonymous on a public trip).
    Raises 401/403 for private trips without sufficient access, 404 if the
    trip does not exist (so callers don't have to re-check).
    """
    trip = get_trip_by_id(trip_id.lower())
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    # Public: anyone may read. If a token is present, try to resolve the
    # caller's role for myRole; invalid tokens are ignored (public access
    # does not require auth, so a stale header shouldn't break it).
    if trip.visibility == "public":
        if authorization and authorization.lower().startswith("bearer "):
            try:
                user = get_current_user(authorization)
                role = get_trip_role_for_user(trip_id.lower(), user["sub"])
                return role
            except HTTPException:
                return None
        return None

    # Private: valid token + follower+ required (follower is the lowest read role, #65).
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = get_current_user(authorization)  # validates; 401 on invalid
    role = get_trip_role_for_user(trip_id.lower(), user["sub"])
    if not _role_ok(role, "follower"):
        raise HTTPException(
            status_code=403,
            detail="You don't have access to this trip",
        )
    return role


def require_trip_role(min_role: str):
    """FastAPI dependency factory for owner/editor-only sub-resources.

    Usage on a route with a ``trip_id`` path parameter (dashed UUID), e.g. the
    join-link endpoint::

        @app.get("/api/trips/{trip_id}/join-link")
        def join_link(trip_id: str, _: None = Depends(require_trip_role("owner"))): ...

    Returns the validated actor ``{"sub": …, "role": …}`` (the role that
    passed the gate) so write routes can forward the caller's identity to the
    write service for ``x-user-id`` attribution and owner-only checks.
    """

    def dependency(
        trip_id: str,
        authorization: str | None = Header(default=None),
    ) -> dict:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(
                status_code=401,
                detail="Missing bearer token",
                headers={"WWW-Authenticate": "Bearer"},
            )
        user = get_current_user(authorization)  # validates; 401 on invalid
        role = get_trip_role_for_user(trip_id.lower(), user["sub"])
        if not _role_ok(role, min_role):
            raise HTTPException(
                status_code=403,
                detail=f"You need the '{min_role}' role for this trip",
            )
        return {"sub": user["sub"], "role": role}

    return dependency
