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

ROLES = {"owner", "editor", "viewer", "follower"}


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
    edge = _find_crew_edge(graph, trip_dtid, person_id)
    if edge is None:
        raise ClaimError(409, "This crew member is already linked to an account")
    if _find_crew_edge(graph, trip_dtid, user_dtid) is not None:
        raise ClaimError(409, "You are already on this trip's crew")

    role = edge.get("role") or "viewer"
    if role not in ROLES:
        role = "viewer"
    index = edge.get("index")
    index = index if isinstance(index, int) else 0
    # Trip-relative note rides the edge too — carry it over to the User edge
    # so claiming never drops it.
    note = edge.get("note")
    note = note if isinstance(note, str) else None
    # The crew's OWN name rides the edge too (#196) — carry it over so a
    # claim never renames the crew member to the account's name.
    display_name = edge.get("displayName")
    display_name = display_name if isinstance(display_name, str) and display_name else None

    if not client.create_user_twin(user_dtid, profile):
        raise ClaimError(503, "Could not create your user identity")
    if not client.claim_crew_person(trip_dtid, user_dtid, person_id, role, index, note, display_name):
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
