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
    """True when the token is the sanctioned agent M2M client.

    Only the signature-validated M2M token whose client id is sanctioned via
    ``KISEKI_AGENT_CLIENT_ID`` (azp + gty are issuer-asserted) reaches this.
    """
    if not KISEKI_AGENT_CLIENT_ID:
        return False
    if user.get("azp") != KISEKI_AGENT_CLIENT_ID:
        return False
    return user.get("gty") == "client-credentials"


def _is_agent_credential(user: dict) -> bool:
    """Either service credential: the sanctioned agent M2M token OR an admin
    API key (issue #324). Both authenticate a service identity that never
    appears in the graph and both resolve per-request identity the same way
    (act-as header, then the static pin, then 401) with the same prohibitions.
    """
    return _is_agent_token(user) or bool(user.get("api_key"))


def resolve_actor_sub(user: dict) -> str:
    """The effective user sub for USER-SCOPED routes (my trips, /auth/me).

    When the sanctioned agent M2M client acts AS a user (KISEKI_AGENT_ACT_AS,
    the single-user interim pin), everything scoped by identity follows the
    mapped user — never the client's own ``sub`` (``<client>@clients``).
    Any other token keeps its own sub. Unattended agent mode (no act-as)
    keeps the client sub: a service principal has no crew edges, so its
    listings are empty by design; per-trip writes still work via
    ``_agent_actor``'s owner fallback.
    """
    if _is_agent_credential(user) and KISEKI_AGENT_ACT_AS:
        return KISEKI_AGENT_ACT_AS
    return user["sub"]


def require_user_token(user: dict) -> None:
    """Claims/follow PROVISION graph identity (User twin + hasCrew edge) —
    only a real end-user token may do that.

    Service credentials are refused (403): an M2M client-credentials token
    AND an admin API key (issue #324) alike. The agent never gains a graph
    identity, and act-as must never be used to claim/follow on behalf of the
    mapped user — identity provisioning happens with the user's own token
    (mode 1), or not at all.
    """
    if user.get("gty") == "client-credentials" or user.get("api_key"):
        raise HTTPException(
            status_code=403,
            detail="Service principals cannot claim or follow trips",
        )


def resolve_request_actor_sub(
    user: dict,
    x_act_as_sub: str | None = None,
) -> str:
    """Per-request actor sub for chat/agent routes (issue #9, mode 1 + 2).

    Rule (Niko, 2026-09-09): ALWAYS check the bearer token first; its sub is
    the actor UNLESS the credential is a full-access service credential
    (sanctioned agent M2M token or admin API key, issue #324) — then the
    act-as sub comes from the request (``X-Act-As-Sub`` header), falling back
    to the static ``KISEKI_AGENT_ACT_AS`` pin only when the request names no
    sub (single-user interim, deprecated).

    Mode 1 (UI): the end user's own Auth0 token → actor = token sub.
    Mode 2 (agent backend): service credential + request-scoped act-as sub
    (header) → actor = that sub. This is the per-request identity model that
    replaces the static env pin once the chat UI ships (#9).
    """
    if not _is_agent_credential(user):
        return user["sub"]
    # Service credential: act-as is REQUIRED for user-scoped work.
    if x_act_as_sub and x_act_as_sub.strip():
        return x_act_as_sub.strip()
    if KISEKI_AGENT_ACT_AS:
        return KISEKI_AGENT_ACT_AS
    raise HTTPException(
        status_code=401,
        detail=(
            "Agent token requires an act-as sub (X-Act-As-Sub header) "
            "for user-scoped routes"
        ),
    )



def _agent_actor(user: dict, trip_dtid: str) -> dict | None:
    """Actor {sub, role} for a service credential (#46, extended #324).

    The agent NEVER appears in the graph — no User twin, no hasCrew edge.

    Two modes:
    - ``KISEKI_AGENT_ACT_AS`` set (Niko's home profile only — deliberately
      never configured on the dedicated end-user profile): the agent acts AS
      that user. Role = the user's REAL crew role on this trip (resolved via
      their hasCrew edge; never widened, None when the user has no access).
      Attribution (x-user-id) is the user's sub.
    - unset: owner-level service principal for unattended changes that cannot
      be linked to a user. Attribution = the credential's own sub.
    """
    if not _is_agent_credential(user):
        return None
    if KISEKI_AGENT_ACT_AS:
        role = get_trip_role_for_user(trip_dtid, KISEKI_AGENT_ACT_AS)
        if not role:
            return None  # the mapped user has no access → the agent has none
        return {"sub": KISEKI_AGENT_ACT_AS, "role": role}
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


def require_trip_owner(trip_id: str, authorization: str | None = Header(default=None)) -> dict:
    """The DELETE /api/trips/{trip_id} gate (issue #163) — existence FIRST.

    Unlike ``require_trip_role`` (which gates on the crew role alone and lets
    the write service 404 later), a trip-level delete must 404 BEFORE any
    role verdict: the caller (user or content agent) needs "this trip is
    gone" on the SECOND delete (the cleanup loop's termination condition) —
    a role-shaped 403 there would read as "still exists, just denied". Order
    here: 401 (no/bad token) → 404 (trip gone — for anyone, any identity) →
    403 (exists, caller is not the owner). The write service re-checks the
    owner role (belt and braces) and does the graph work.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = get_current_user(authorization)  # validates; 401 on invalid
    if get_trip_by_id(trip_id.lower()) is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    actor = _resolve_actor(user, trip_id.lower())
    if not actor or actor["role"] != "owner":
        raise HTTPException(
            status_code=403,
            detail="You need the 'owner' role for this trip",
        )
    return actor
