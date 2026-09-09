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
from .config import KISEKI_AGENT_ACT_AS, KISEKI_AGENT_CLIENT_ID
from .store import get_trip_by_id, get_trip_role_for_user

ROLE_RANK = {"follower": 1, "viewer": 2, "editor": 3, "owner": 4}


def _is_agent_token(user: dict) -> bool:
    """True iff the token is the sanctioned agent M2M client (azp + gty)."""
    if not KISEKI_AGENT_CLIENT_ID:
        return False
    return (
        user.get("azp") == KISEKI_AGENT_CLIENT_ID
        and user.get("gty") == "client-credentials"
    )


def resolve_agent_sub(user: dict) -> str | None:
    """The act-as sub for the sanctioned agent M2M client, else None (#142).

    Only the signature-validated client-credentials token whose azp is
    ``KISEKI_AGENT_CLIENT_ID`` matches, and only when
    ``KISEKI_AGENT_ACT_AS`` is configured (Niko's home profile only —
    deliberately never on the end-user profile). Shared by the per-trip ACL
    and the list route (``GET /api/trips``) so the agent's discovery and its
    per-trip access resolve the SAME identity.
    """
    if _is_agent_token(user) and KISEKI_AGENT_ACT_AS:
        return KISEKI_AGENT_ACT_AS
    return None


def _agent_actor(user: dict, trip_dtid: str) -> dict | None:
    """Actor {sub, role} for the sanctioned agent M2M client (#46).

    The agent NEVER appears in the graph — no User twin, no hasCrew edge.
    Only the signature-validated M2M token whose client id is sanctioned via
    ``KISEKI_AGENT_CLIENT_ID`` (azp + gty are issuer-asserted) reaches this.

    Two modes:
    - ``KISEKI_AGENT_ACT_AS`` set (Niko's home profile only — deliberately
      never configured on the dedicated end-user profile): the agent acts AS
      that user. Role = the user's REAL crew role on this trip (resolved via
      their hasCrew edge; never widened, None when the user has no access).
      Attribution (x-user-id) is the user's sub.
    - unset: owner-level service principal for unattended changes that cannot
      be linked to a user. Attribution = the M2M token's own sub.
    """
    if not _is_agent_token(user):
        return None
    act_as = resolve_agent_sub(user)
    if act_as:
        role = get_trip_role_for_user(trip_dtid, act_as)
        if not role:
            return None  # the mapped user has no access → the agent has none
        return {"sub": act_as, "role": role}
    return {"sub": user.get("sub"), "role": "owner"}


def _resolve_actor(user: dict, trip_dtid: str) -> dict | None:
    """The acting identity: the token's own user (crew role via hasCrew) or,
    for the sanctioned M2M client, the agent actor (act-as / owner fallback)."""
    role = get_trip_role_for_user(trip_dtid, user["sub"])
    if role:
        return {"sub": user["sub"], "role": role}
    return _agent_actor(user, trip_dtid)


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
                actor = _resolve_actor(user, trip_id.lower())
                return actor["role"] if actor else None
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
    actor = _resolve_actor(user, trip_id.lower())
    if not actor or not _role_ok(actor["role"], "follower"):
        raise HTTPException(
            status_code=403,
            detail="You don't have access to this trip",
        )
    return actor["role"]


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
        actor = _resolve_actor(user, trip_id.lower())
        if not actor or not _role_ok(actor["role"], min_role):
            raise HTTPException(
                status_code=403,
                detail=f"You need the '{min_role}' role for this trip",
            )
        # Actor carries the RESOLVED identity: the user's sub, the act-as
        # user's sub, or the M2M client's sub — writes attribute accordingly.
        return actor

    return dependency
