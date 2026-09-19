"""Crew identity claiming (#6) + follower via claimToken (#65).

A user claims a placeholder Person on a trip by presenting the trip's CLAIM
token — a secret separate from the read token, i.e. the 'join link'. The
server:

  1. resolves the trip by claim token,
  2. checks the person is an unclaimed placeholder crew member of that trip,
  3. checks the user does not already have a role on the trip,
  4. creates the User twin (``$dtId`` = the auth ``sub``) with the OIDC profile,
  5. transfers the ``hasCrew`` edge (same role + index) to the User twin,
  6. DELETES the placeholder (retired once claimed).

No name/email matching is involved: the user picks the person explicitly, so
self-asserted profile values never grant access — possession of the claim
token (the invite) is the authorization.

#65 adds a second path: a non-crew user can **follow** a trip via the same
claimToken (invite-only on private trips, optional on public). This creates a
hasCrew edge with role=follower (no placeholder involved).
"""

from __future__ import annotations

from typing import Any

from .graph.convert import GraphNotFound, graph_to_trip
from .graph.client import PERSON_MODEL, USER_MODEL
from .models import Trip
from .store import get_graph_client


class ClaimError(Exception):
    """Raised for expected claim failures; carries the HTTP status."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _find_person(graph: dict, person_id: str) -> dict | None:
    for twin in graph.get("twins", []):
        if twin.get("$dtId") == person_id:
            model = (twin.get("$metadata") or {}).get("$model")
            if model == PERSON_MODEL:
                return twin
            return None  # right id, wrong kind (e.g. already a User) → not claimable
    return None


def _find_crew_edge(graph: dict, trip_dtid: str, target_id: str) -> dict | None:
    for rel in graph.get("relationships", []):
        if (
            rel.get("$sourceId") == trip_dtid
            and rel.get("$relationshipName") == "hasCrew"
            and rel.get("$targetId") == target_id
        ):
            return rel
    return None


def _find_person_edges(client, person_id: str) -> list[dict]:
    """Every ``hasCrew`` edge pointing at ``person_id``, across ALL trips (#322).

    The placeholder being claimed may be crew on more than one trip, so the
    edge list — not the one trip the join link names — is the unit of work.
    Falls back to an empty list when the graph client cannot answer; the
    caller then refuses the claim rather than half-performing it.
    """
    getter = getattr(client, "crew_edges_for_person", None)
    if not callable(getter):
        return []
    edges = getter(person_id)
    return [e for e in edges if isinstance(e, dict)] if isinstance(edges, list) else []


def trip_by_claim_token(claim_token: str) -> Trip | None:
    """Resolve a trip from its claim token (join-link read, anonymous)."""
    client = get_graph_client()
    if client is None:
        return None
    trip_dtid = client.find_trip_dtid_by_claim_token(claim_token)
    if not trip_dtid:
        return None
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        return None
    try:
        return graph_to_trip(graph)
    except GraphNotFound:  # deleted between the token lookup and the fetch (#171)
        return None


def claim_identity(
    claim_token: str,
    person_id: str,
    user_dtid: str,
    profile: dict[str, Any],
) -> Trip:
    """Claim ``person_id`` on the trip behind ``claim_token`` as ``user_dtid``.

    Raises ``ClaimError`` on every expected failure; returns the rebuilt Trip
    (with the user on the crew) on success.

    **The claim CASCADES across every trip the placeholder is crew on (#322).**
    A placeholder is a real twin, so one person added to three trips before
    signing in is ONE Person with three ``hasCrew`` edges, not three orphan
    twins. Claiming through any one trip's join link therefore transfers all
    three edges onto the account and retires the placeholder once — one join
    link, all linked trips. Each trip keeps its own role / index / note, so a
    placeholder who is an editor on one trip and a viewer on another keeps both.
    """
    client = get_graph_client()
    if client is None:
        raise ClaimError(503, "Graph not configured")
    trip_dtid = client.find_trip_dtid_by_claim_token(claim_token)
    if not trip_dtid:
        raise ClaimError(404, "Unknown join link")
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        raise ClaimError(404, "Trip not found")

    person = _find_person(graph, person_id)
    if person is None:
        raise ClaimError(404, "Crew member not found")
    # The invite authorizes claiming a person ON THIS TRIP. The cascade below
    # then follows that person to their other trips — never the other way
    # round, or a link for one trip could claim a stranger from another.
    if _find_crew_edge(graph, trip_dtid, person_id) is None:
        raise ClaimError(409, "This crew member is already linked to an account")
    if _find_crew_edge(graph, trip_dtid, user_dtid) is not None:
        raise ClaimError(409, "You are already on this trip's crew")

    # Every trip this placeholder is crew on — the trip behind the join link
    # plus any sibling trip the same placeholder was added to (#322).
    edges = _find_person_edges(client, person_id)
    if not edges:
        raise ClaimError(503, "Could not read this crew member's trips")

    if not client.create_user_twin(user_dtid, profile):
        raise ClaimError(503, "Could not create your user identity")
    result = client.claim_crew_person_cascade(user_dtid, person_id, edges)
    if result is None:
        raise ClaimError(503, "Could not transfer your crew role")

    rebuilt = client.fetch_graph(trip_dtid)
    if not rebuilt:
        raise ClaimError(503, "Trip could not be re-read after claim")
    try:
        return graph_to_trip(rebuilt)
    except GraphNotFound as exc:  # vanished mid-claim (#171)
        raise ClaimError(503, "Trip could not be re-read after claim") from exc


def follow_via_claim(
    claim_token: str,
    user_dtid: str,
    profile: dict[str, Any],
) -> Trip:
    """Follow a trip via its claimToken (#65).

    Creates a hasCrew edge with role=follower for a non-crew user.
    Private trips require this invite; public trips can be followed
    optionally. Idempotent: if already on the crew, returns the trip
    without creating a duplicate edge.
    """
    client = get_graph_client()
    if client is None:
        raise ClaimError(503, "Graph not configured")
    trip_dtid = client.find_trip_dtid_by_claim_token(claim_token)
    if not trip_dtid:
        raise ClaimError(404, "Unknown join link")
    # Already on crew → idempotent success
    if client.role_for_user_on_trip(trip_dtid, user_dtid) is not None:
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            raise ClaimError(404, "Trip not found")
        try:
            return graph_to_trip(graph)
        except GraphNotFound:
            raise ClaimError(404, "Trip not found")  # deleted mid-check (#171)
    if not client.follow_trip(trip_dtid, user_dtid, profile):
        raise ClaimError(503, "Could not follow trip")
    rebuilt = client.fetch_graph(trip_dtid)
    if not rebuilt:
        raise ClaimError(503, "Trip could not be re-read after follow")
    try:
        return graph_to_trip(rebuilt)
    except GraphNotFound as exc:  # vanished mid-follow (#171)
        raise ClaimError(503, "Trip could not be re-read after follow") from exc


# ----------------------------------------------------------- follow model #197
def trip_by_follow_token(follow_token: str) -> Trip | None:
    """Resolve a trip from its FOLLOW token (#197) — the follow-link read.

    Same trip document as the claim link, but the credential that got the
    caller here can never claim a crew identity, so callers rendering this
    must not offer "This is me" (see ``main.trip_by_follow``).
    """
    client = get_graph_client()
    if client is None:
        return None
    trip_dtid = client.find_trip_dtid_by_follow_token(follow_token)
    if not trip_dtid:
        return None
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        return None
    try:
        return graph_to_trip(graph)
    except GraphNotFound:  # deleted between the token lookup and the fetch (#171)
        return None


def _follow(client, trip_dtid: str, user_dtid: str, profile: dict[str, Any]) -> Trip:
    """Shared tail of every follow path: idempotent edge, rebuilt Trip (#197).

    Idempotent on purpose — following a trip you already follow (or that you
    are crew on) returns the trip and never duplicates the edge or downgrades
    an existing role.
    """
    if client.role_for_user_on_trip(trip_dtid, user_dtid) is not None:
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            raise ClaimError(404, "Trip not found")
        try:
            return graph_to_trip(graph)
        except GraphNotFound:
            raise ClaimError(404, "Trip not found")  # deleted mid-check (#171)
    if not client.follow_trip(trip_dtid, user_dtid, profile):
        raise ClaimError(503, "Could not follow trip")
    rebuilt = client.fetch_graph(trip_dtid)
    if not rebuilt:
        raise ClaimError(503, "Trip could not be re-read after follow")
    try:
        return graph_to_trip(rebuilt)
    except GraphNotFound as exc:  # vanished mid-follow (#171)
        raise ClaimError(503, "Trip could not be re-read after follow") from exc


def follow_trip_by_id(trip_dtid: str, user_dtid: str, profile: dict[str, Any]) -> Trip:
    """Follow a PUBLIC trip with no invite at all (#197).

    ``visibility: public`` IS the invitation on this path. A private trip
    stays invite-only: following it by id is a 403 telling the caller to get
    a link, never a silent no-op and never an accidental grant. The role
    granted is ``follower`` — read + follow, no crew powers.
    """
    client = get_graph_client()
    if client is None:
        raise ClaimError(503, "Graph not configured")
    graph = client.fetch_graph(trip_dtid)
    if not graph:
        raise ClaimError(404, "Trip not found")
    try:
        trip = graph_to_trip(graph)
    except GraphNotFound as exc:  # vanished under us (#171)
        raise ClaimError(404, "Trip not found") from exc
    if trip.visibility != "public":
        raise ClaimError(403, "A private trip can only be followed with an invite link")
    return _follow(client, trip_dtid, user_dtid, profile)


def follow_via_follow_token(
    follow_token: str,
    user_dtid: str,
    profile: dict[str, Any],
) -> Trip:
    """Follow a private trip via its FOLLOW link (#197).

    Structurally incapable of claiming: the token resolves through
    ``followToken`` and ``claim_identity`` reads ``claimToken`` only — the
    two secrets are never interchangeable (a follow link presented as a claim
    credential is just an unknown join link).
    """
    client = get_graph_client()
    if client is None:
        raise ClaimError(503, "Graph not configured")
    trip_dtid = client.find_trip_dtid_by_follow_token(follow_token)
    if not trip_dtid:
        raise ClaimError(404, "Unknown follow link")
    return _follow(client, trip_dtid, user_dtid, profile)
