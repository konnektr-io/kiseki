"""Account erasure + portability export (#196 phase C, GDPR art. 17/20).

Erasure (``DELETE /api/me``) is the exact inverse of the claim flow
(``app/claims.py``): where a claim CREATES the ``User`` twin, TRANSFERS the
``hasCrew`` edges onto it and DELETES the placeholder, an erasure REVERTS each
``hasCrew`` edge onto a FRESH placeholder, removes the ``follows`` edges in
both directions, and DELETES the ``User`` twin last.

Ordering (the graph server does NOT cascade twin deletes — a twin with
incident edges refuses deletion, #89 — so every edge goes before its twin):

  1. owned-trip gate (409, nothing deleted),
  2. crew entries revert to placeholders (new Person twin + new edge first,
     old trip->User edge after),
  3. ``follows`` edges out + in (idempotent deletes),
  4. the ``User`` twin itself.

Partial failure is loud and retryable: the twin is deleted LAST, so a failure
part-way leaves the account (and its follows) intact rather than half-erased,
and a retry resumes where it stopped — an already-reverted edge no longer
points at the ``User`` twin, so it is not in the work list and no row is
reverted twice (pinned by the resumability test).

A trip the caller shared is never rewritten beyond the crew-row swap: the new
placeholder carries the SAME trip-relative name (the edge's ``displayName``),
role, index and note, so the trip renders identically for everyone else —
only the account behind the row is gone. An owner-less trip would be
unadministrable, so callers who still own a trip are refused (409) instead of
having their trips silently destroyed — a deliberate, overrule-able product
decision (flag it with the product owner before changing it).

What is deliberately dropped: the person's own contact details (phone/email —
``contact`` on the twin, ``email``): they are the subject's PII, not
crew-authored trip content, and #195's "avatar/notes dropped" is read as those
account-level bits. The trip-relative ``note`` on the edge DOES survive — it is
crew-authored content about the trip ("brings the stove") and the claim flow
carries it through; if the product owner wants it dropped too, the change is
``note=None`` in the ``revert_crew_person`` call below.

Export (``GET /api/me/export``) returns one complete JSON document with the
caller's own data only: their twin props, full documents of trips they own,
their crew rows on trips they do not own, and their social graph (public-ish
peer fields only — never another user's email or trip-relative note).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from .graph.convert import GraphNotFound, graph_to_trip
from .models import Trip
from .store import get_graph_client, get_trip_by_id

ROLES = {"owner", "editor", "viewer", "follower"}


class ErasureError(Exception):
    """Raised for expected erasure/export failures; carries the HTTP status."""

    def __init__(self, status: int, detail: str, extra: dict | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.extra = extra


def _find_crew_edge(graph: dict, trip_dtid: str, target_id: str) -> dict | None:
    for rel in graph.get("relationships", []):
        if (
            rel.get("$sourceId") == trip_dtid
            and rel.get("$relationshipName") == "hasCrew"
            and rel.get("$targetId") == target_id
        ):
            return rel
    return None


def erase_account(user_dtid: str) -> dict:
    """Erase one account: revert crew rows, drop follows, delete the twin.

    Raises ``ErasureError`` (404 no twin, 409 still owns trips, 503 graph
    failure). Returns the ``deleted`` summary the route answers with.
    Irreversible — the route docstring says so.
    """
    client = get_graph_client()
    if client is None:
        raise ErasureError(503, "Graph not configured")
    if not client.user_twin_exists(user_dtid):
        raise ErasureError(404, "No user identity to erase")

    rows = client.list_trips_for_user(user_dtid)
    owned = [r for r in rows if r.get("role") == "owner"]
    if owned:
        blocking = [
            {"dtId": r.get("dtId"), "title": r.get("title"), "slug": r.get("slug")}
            for r in owned
        ]
        names = ", ".join(f"{r.get('title') or r.get('dtId')}" for r in owned)
        raise ErasureError(
            409,
            f"You still own {len(owned)} trip(s) ({names}); delete or hand them over first.",
            extra={"ownedTrips": blocking},
        )

    node = client.get_user_profile(user_dtid) or {}
    # Pre-#196 edges carry no displayName: fall back to the User twin's name
    # so the crew never sees a blank row after the revert. The account's own
    # contact details are NOT carried over (see ``revert_crew_person``): the
    # crew-authored trip-relative row survives, the person's PII does not.
    account_name = node.get("displayName") or node.get("name") or user_dtid

    crew_reverted = 0
    for row in rows:
        trip_dtid = row.get("dtId")
        if not isinstance(trip_dtid, str) or not trip_dtid:
            continue
        graph = client.fetch_graph(trip_dtid)
        if not graph:
            raise ErasureError(503, f"Trip {trip_dtid} could not be re-read during erasure")
        edge = _find_crew_edge(graph, trip_dtid, user_dtid)
        if edge is None:
            continue  # edge already gone (a re-run converging) — not a failure
        role = edge.get("role") or "viewer"
        if role not in ROLES:
            role = "viewer"
        index = edge.get("index")
        index = index if isinstance(index, int) else 0
        note = edge.get("note")
        note = note if isinstance(note, str) else None
        display_name = edge.get("displayName")
        display_name = display_name if isinstance(display_name, str) and display_name else None
        placeholder_name = display_name or account_name
        if not client.revert_crew_person(
            trip_dtid, user_dtid, str(uuid.uuid4()), placeholder_name,
            role, index, note, display_name,
        ):
            raise ErasureError(503, f"Could not revert your crew entry on trip {trip_dtid}")
        crew_reverted += 1

    follows_removed = 0
    for target in client.following_of(user_dtid):
        if not client.unfollow_user(user_dtid, target):
            raise ErasureError(503, f"Could not remove your follow of {target}")
        follows_removed += 1
    for follower in client.followers_of(user_dtid):
        if not client.unfollow_user(follower, user_dtid):
            raise ErasureError(503, f"Could not remove {follower}'s follow of you")
        follows_removed += 1

    # Last: the twin has no incident edges left. If the delete still fails,
    # surface that honestly (503) rather than reporting success.
    if not client.delete_user_twin(user_dtid):
        raise ErasureError(503, "Could not delete your user identity")
    return {
        "sub": user_dtid,
        "crewEntriesReverted": crew_reverted,
        "followsRemoved": follows_removed,
        "twinDeleted": True,
    }


def _peer_entry(sub: str, node: dict | None) -> dict:
    """One social-graph entry: public-ish identity fields only.

    Never email or any other private property. A peer whose profile cannot
    be resolved (deleted account) still lists its sub with nullish names
    rather than dropping the row.
    """
    if node is None:
        return {"sub": sub, "name": None, "displayName": None}
    return {
        "sub": sub,
        "name": node.get("displayName") or node.get("name"),
        "displayName": node.get("displayName") or node.get("name"),
    }


def export_account(user_dtid: str) -> dict:
    """Build the portability document (GDPR art. 20) for one account.

    Raises ``ErasureError`` (404 no twin, 503 graph failure). ``ownedTrips``
    holds the caller's Trip models (the route serializes them through the
    same ``_public_trip`` path as ``GET /api/trips/{id}`` — never hand-rolled
    here, so the shapes cannot drift).
    """
    client = get_graph_client()
    if client is None:
        raise ErasureError(503, "Graph not configured")
    node = client.get_user_profile(user_dtid)
    if node is None:
        raise ErasureError(404, "No user identity — call /api/me/ensure first")

    profile = {k: v for k, v in node.items() if not (isinstance(k, str) and k.startswith("$"))}

    rows = client.list_trips_for_user(user_dtid)
    owned: list[Trip] = []
    crew_entries: list[dict] = []
    for row in rows:
        trip_dtid = row.get("dtId")
        if not isinstance(trip_dtid, str) or not trip_dtid:
            continue
        if row.get("role") == "owner":
            try:
                trip = get_trip_by_id(trip_dtid)
            except GraphNotFound:
                continue  # vanished mid-export (#171) — skip, don't 500
            if trip is not None:
                owned.append(trip)
            continue
        # The caller's OWN row on someone else's trip: their note and
        # displayName are their data. Read the CURRENT edge (never assume);
        # fall back to the summary when the bundle cannot be fetched.
        entry: dict[str, Any] = {
            "tripId": trip_dtid,
            "title": row.get("title"),
            "slug": row.get("slug"),
            "role": row.get("role"),
            "note": None,
            "displayName": None,
        }
        graph = client.fetch_graph(trip_dtid)
        if graph:
            edge = _find_crew_edge(graph, trip_dtid, user_dtid)
            if edge is not None:
                entry["role"] = edge.get("role") or entry["role"]
                note = edge.get("note")
                entry["note"] = note if isinstance(note, str) else None
                display_name = edge.get("displayName")
                entry["displayName"] = (
                    display_name if isinstance(display_name, str) and display_name else None
                )
        crew_entries.append(entry)

    following_ids = client.following_of(user_dtid)
    follower_ids = client.followers_of(user_dtid)
    profiles = client.get_user_profiles(list(dict.fromkeys(following_ids + follower_ids)))
    following = [_peer_entry(s, profiles.get(s)) for s in following_ids]
    followers = [_peer_entry(s, profiles.get(s)) for s in follower_ids]

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "profile": profile,
        "ownedTrips": owned,
        "crewEntries": crew_entries,
        "following": following,
        "followers": followers,
    }
