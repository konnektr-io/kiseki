"""Live Konnektr Graph adapter (P1 source of truth, issue #4).

This module is the ONLY place that imports ``konnektr-graph``. It exposes a
small, source-agnostic contract so the rest of the backend never depends on the
SDK directly:

    is_enabled()                    -> bool  (graph wired; else local trip.json source)
    find_trip_dtid_by_claim_token(t)-> dtid | None   (issue #6 join link)
    fetch_graph(dtid)               -> {"$dtId", "twins", "relationships"}
    list_trips_for_user(user_dtid)  -> [trip summary dict, ...]  (hasCrew access)
    role_for_user_on_trip(...)      -> role | None                 (ACL, #5)
    create_user_twin(...)           -> bool   (claim flow, #6)
    claim_crew_person(...)          -> bool   (edge transfer + placeholder delete, #6)
    update_twin_props(...)          -> None   (content writes, #46 — see below)

``fetch_graph`` always returns the SAME normalized shape as the committed
``data/seed/*.graph.json`` fixtures (produced by ``scripts/trip_to_graph.py``):
an ADT twin/relationship bundle. ``convert.graph_to_trip`` consumes that shape
regardless of whether it came from the live SDK or a seed file, so the rest of
the backend is unchanged.

Both queries are written in **Cypher** through ``query_twins`` (``POST /query``)
— never the ADT query language, and never a full-store ``SELECT``. Each query is
scoped to a single trip's *connected component* (trip + everything reachable
along outgoing edges), so we never walk the SDK node-by-node and never scan the
whole graph.

**Parameterized Cypher (SDK >= 0.3.8).** The dtId / uid arrive from the
URL, so they are passed as Cypher query parameters (``$dtid`` /
``$uid``) — never interpolated into the query string. ``query_twins`` forwards
``query_parameters`` to the server's ``/query`` endpoint, where the Cypher
engine binds them safely. (A defensive regex still validates each value; it is
defense-in-depth, not what makes the query safe.) The one value that is NOT a
parameter is ``MAX_HOPS`` in the variable-length-edge bound ``[*0..MAX_HOPS]``:
Apache AGE rejects a parameter there (range bounds must be compile-time
literals), and ``MAX_HOPS`` is a constant non-negative int, so it is inlined as
a literal.

If the SDK is missing or the endpoint is absent, ``is_enabled()`` is False and
the backend serves the local ``trip.json`` files directly (local-dev / CI mode).
There is no file fallback when the graph is enabled — a graph read failure is
surfaced as a 404, never masked by a stale file.
"""

from __future__ import annotations

import re
import threading
import time
from functools import wraps
from typing import Any, Callable, Optional

from app.config import KISEKI_GRAPH_TOKEN, KISEKI_GRAPH_URL

# In-process TTL cache for the hot graph reads. Trip content changes rarely
# (content updates re-seed or kubectl-cp), and every SPA page load otherwise
# re-runs a role lookup + the subgraph fetch. With the graph rate limiter off,
# this keeps page loads fast instead of hammering the API. Only TRUTHY results
# are cached — a None (not found / transient failure) is re-queried next time.
_GRAPH_CACHE: dict[tuple, tuple[float, Any]] = {}
_GRAPH_CACHE_LOCK = threading.Lock()
_GRAPH_TTL = {"fetch_graph": 60.0, "role_for_user_on_trip": 30.0,
              "list_trips_for_user": 30.0,
              "find_trip_dtid_by_claim_token": 60.0}


def _cached_graph(method: Callable) -> Callable:
    @wraps(method)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        key = (method.__name__, args, tuple(sorted(kwargs.items())))
        with _GRAPH_CACHE_LOCK:
            hit = _GRAPH_CACHE.get(key)
            if hit and hit[0] > time.monotonic():
                return hit[1]
        result = method(self, *args, **kwargs)
        if result:
            with _GRAPH_CACHE_LOCK:
                _GRAPH_CACHE[key] = (time.monotonic() + _GRAPH_TTL.get(method.__name__, 30.0), result)
        return result

    return wrapper


def _clear_graph_cache() -> None:
    """Drop the whole cache (tests)."""
    with _GRAPH_CACHE_LOCK:
        _GRAPH_CACHE.clear()


# The cached reads a crew write (claim #6 / follow #65) makes stale. Keyed on
# ids, so retiring them is a subset match on the memoized args.
_CREW_CACHED_READS = {"fetch_graph", "role_for_user_on_trip", "list_trips_for_user"}


def _invalidate_graph_cache(*, trip_dtid: str | None = None, user_dtid: str | None = None) -> None:
    """Retire the cache entries a crew write changed — not the whole cache.

    Needed because a write is immediately followed by a re-read: the caller
    rebuilds the Trip to return it, and ``role_for_user_on_trip`` was usually
    consulted (and its miss memoized) on the way in. Without this the re-read
    is served the PRE-write graph for up to the TTL — the claim flow has been
    returning a trip whose placeholder is still unclaimed for that reason.

    Clearing everything instead would work and is what the follow path did, but
    the TTL cache is the thing that keeps reads off the graph, so one person
    joining a trip should not cost every other trip its cached document.
    """
    ids = {v for v in (trip_dtid, user_dtid) if v}
    if not ids:
        return
    with _GRAPH_CACHE_LOCK:
        stale = [
            k for k in _GRAPH_CACHE
            if k[0] in _CREW_CACHED_READS and ids & set(k[1])
        ]
        for k in stale:
            del _GRAPH_CACHE[k]

# Every node in the graph is a ``:Twin``; the kind is carried by the
# ``$metadata.$model`` property (dtmi:kiseki:travel:<Kind>;1).
TRIP_MODEL = "dtmi:kiseki:travel:Trip;1"
USER_MODEL = "dtmi:kiseki:travel:User;1"
PERSON_MODEL = "dtmi:kiseki:travel:Person;1"

# A claim token is a secret invite id. Validated as defense in depth —
# the value is passed as a Cypher parameter, never interpolated.
_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~-]{1,256}$")
# Our twin ids are opaque UUIDs (see issue #8 restructure).
_DTID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
# A user twin id is `user:<authId>` (global auth id, transferred on login).
# Auth ids come from external IdPs (Auth0 uses `auth0|...`, `google-oauth2|...`)
# so we can't use a narrow whitelist; we only reject characters that would break
# a Cypher single-quoted-string IF we ever had to inline (we don't — it's a
# parameter). The graph validates again (no such node -> []).
_USER_RE = re.compile(r"^[^'\\\x00-\x1f]{1,256}$")

# Bounded traversal depth for the subgraph walk. The Kiseki graph is shallow:
# trip -> day/section -> block -> location = 3 hops; we bind exactly that. Do
# NOT raise this casually: AGE enumerates every path up to the bound, and each
# extra hop multiplies the row count (the Query-Units cost of the page-load
# subgraph fetch). This MUST be a compile-time literal in the range bound, so
# it is inlined (not a parameter).
MAX_HOPS = 3

# --- Cypher (parameterized) -----------------------------------------------
# Locate the Trip twin by its CLAIM token (issue #6 join link) — the only
# secret that remains after #64 (visibility gates the id route; claimToken
# authorizes the join). `$claimToken` is a bound parameter.
_Q_FIND_TRIP_BY_CLAIM = """
MATCH (trip:Twin)
WHERE trip.claimToken = $claimToken
RETURN trip
LIMIT 1
"""

# All twins in the trip's connected component (trip itself + every node
# reachable along outgoing edges). A single query, scoped to the trip — not the
# whole store. `$dtid` is a bound parameter; MAX_HOPS is a literal range bound.
# NOTE: the path is deliberately NOT bound (`MATCH path = ...`): AGE would
# materialize every path object between every reachable pair, which dominates
# the query cost. Binding only the end node lets the planner work with the
# reachability closure instead.
_Q_NODES = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
MATCH (trip)-[*0..{max_hops}]->(n:Twin)
RETURN collect(DISTINCT n) AS nodes
""".format(max_hops=MAX_HOPS)

# All relationships whose source is in the trip's component. AGE rejects a `$`
# map key (even quoted), so we collect each edge as a plain LIST
# [sourceId, relationshipName, targetId, relationshipId, role, index, note,
#  displayName] and map it to the ADT relationship shape in Python. `type(r)`
# is the edge name; the edge's own `$relationshipId` property is included
# because it is the server's handle for get/delete-by-id (ADT scopes
# relationship ids per source twin) — without it the fetched bundle cannot
# drive relationship writes (issue #89: every relationship read back as
# id-less). `displayName` (#196) is the crew's own trip-relative name on
# hasCrew edges; shorter rows (pre-#196 edges) simply omit it.
_Q_RELS = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
MATCH (trip)-[*0..{max_hops}]->(a:Twin)
MATCH (a)-[r]->(b:Twin)
RETURN collect(DISTINCT [a.`$dtId`, type(r), b.`$dtId`, r.`$relationshipId`, r.role, r.index, r.note, r.displayName]) AS rels
""".format(max_hops=MAX_HOPS)

# All trips a user has access to, reached via the `hasCrew` edge (trip -> user).
# Returns a flat LIST per trip [dtId, visibility, title, subtitle, stage, startDate,
# endDate, slug, cover, role, discoverable] (map keys with `$` are rejected by AGE, so we
# assemble the summary dict in Python). `$uid` is a bound parameter.
# `discoverable` (#196 phase B) rides along so profile listings can apply the
# discoverable-only rule without a second query per trip.
_Q_TRIPS_FOR_USER = """
MATCH (t:Twin)-[crew:hasCrew]->(u:Twin)
WHERE u.`$dtId` = $uid
RETURN collect(DISTINCT [t.`$dtId`, t.visibility, t.title, t.subtitle, t.stage,
                         t.startDate, t.endDate, t.slug, t.cover, crew.role,
                         t.discoverable]) AS trips
"""

# ACL: the role a user has on ONE trip (issue #5). Trip-scoped via `$dtid`;
# the person is the User twin whose `$dtId` IS the global auth id (created on
# claim — issue #6). Deliberately NOT matched by name/email: those are
# self-asserted claims, not credentials — a spoofed display name must never
# grant a role. Until a user claims their identity, the protected path is 403.
_Q_ROLE_FOR_USER = """
MATCH (trip:Twin)-[crew:hasCrew]->(u:Twin)
WHERE trip.`$dtId` = $dtid AND u.`$dtId` = $uid
RETURN crew.role AS role
LIMIT 1
"""

# Person->person social graph (issue #196). Single-hop, user-scoped, one
# round-trip each — never a node-by-node walk, never a full-store scan.
# Returns plain id LISTS (AGE rejects `$`-prefixed map keys, so no maps).
# `$uid` is a bound parameter.
_Q_FOLLOWERS_OF = """
MATCH (f:Twin)-[r:follows]->(u:Twin)
WHERE u.`$dtId` = $uid
RETURN collect(DISTINCT f.`$dtId`) AS followers
"""

_Q_FOLLOWING_OF = """
MATCH (u:Twin)-[r:follows]->(t:Twin)
WHERE u.`$dtId` = $uid
RETURN collect(DISTINCT t.`$dtId`) AS following
"""


class GraphReadClient:
    """Read trips from a live Konnektr Graph (konnektr-graph SDK)."""

    def __init__(self) -> None:
        self.url = KISEKI_GRAPH_URL
        self.token = KISEKI_GRAPH_TOKEN
        self._client: Any = None
        self._import_error: Optional[str] = None
        if self.url and self.token:
            try:
                from konnektr_graph import KonnektrGraphClient
                from konnektr_graph.auth.static_token_credential import (
                    StaticTokenCredential,
                )

                self._client = KonnektrGraphClient(
                    self.url, StaticTokenCredential(self.token)
                )
            except Exception as exc:  # pragma: no cover - defensive
                self._client = None
                self._import_error = str(exc)

    def is_enabled(self) -> bool:
        return self._client is not None

    @_cached_graph
    def find_trip_dtid_by_claim_token(self, claim_token: str) -> Optional[str]:
        """Return the Trip twin ``$dtId`` whose ``claimToken`` property matches.

        Same contract as ``find_trip_dtid_by_token`` but for the join/claim
        secret (issue #6). ``$claimToken`` is a bound parameter.
        """
        if not self.is_enabled() or not _TOKEN_RE.match(claim_token or ""):
            return None
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FIND_TRIP_BY_CLAIM, query_parameters={"claimToken": claim_token}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph claim lookup failed: {exc}")
            return None
        if not rows:
            return None
        trip = self._norm_node((rows[0] or {}).get("trip") or {})
        if trip.get("$metadata", {}).get("$model") != TRIP_MODEL:
            return None
        return trip.get("$dtId")

    @_cached_graph
    def fetch_graph(self, trip_dtid: str) -> Optional[dict]:
        """Return the trip's connected component as a {twins, relationships} bundle.

        Two scoped, parameterized Cypher queries (nodes + relationships) replace
        the old per-node walk. Both are limited to the trip's reachable subgraph
        within ``MAX_HOPS`` (bounded so the AGE planner never expands the whole
        graph). ``$dtid`` is bound server-side.
        """
        if not self.is_enabled() or not _DTID_RE.match(trip_dtid or ""):
            return None
        try:
            node_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_NODES, query_parameters={"dtid": trip_dtid}
                )
            )
            rel_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_RELS, query_parameters={"dtid": trip_dtid}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph subgraph fetch({trip_dtid}) failed: {exc}")
            return None

        nodes = (node_rows[0] or {}).get("nodes") or [] if node_rows else []
        raw_rels = (rel_rows[0] or {}).get("rels") or [] if rel_rows else []

        twins = [self._norm_node(n) for n in nodes if n]
        relationships = [self._rel_from_list(r) for r in raw_rels if r]
        return {"$dtId": trip_dtid, "twins": twins, "relationships": relationships}

    @_cached_graph
    def list_trips_for_user(self, user_dtid: str) -> list[dict]:
        """Return every trip a user (by twin ``$dtId``) has access to.

        Reached via the ``hasCrew`` edge (trip -> user). Each result is a flat
        summary dict (``dtId`` / ``token`` / ``title`` / ``stage`` / ``role`` …)
        ready for the "my trips" listing — the user does NOT need the full
        subgraph here. The model-kind guard keeps non-Trip ``hasCrew`` sources
        (shouldn't exist) out of the result. ``$uid`` is bound server-side.

        Returns an empty list if the graph is disabled, the id is malformed, or
        the user has no trips.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return []
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_TRIPS_FOR_USER, query_parameters={"uid": user_dtid}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph trips-for-user({user_dtid}) failed: {exc}")
            return []
        if not rows:
            return []
        raw = (rows[0] or {}).get("trips") or []
        out: list[dict] = []
        for row in raw:
            if not isinstance(row, (list, tuple)) or len(row) < 10:
                continue
            summary = self._trip_summary_from_list(row)
            if summary.get("$model") == TRIP_MODEL or summary.get("dtId"):
                out.append(summary)
        return out

    @_cached_graph
    def role_for_user_on_trip(
        self,
        trip_dtid: str,
        user_dtid: str,
    ) -> Optional[str]:
        """ACL role (owner|editor|viewer|follower) of a user on one trip.

        The person is the User twin whose ``$dtId`` IS the global auth id
        (created when the user claims their crew identity — issue #6). No
        name/email matching: self-asserted profile values are not credentials.
        Returns None when there is no role (no access). Values are bound
        Cypher parameters, validated defensively first.
        """
        if not self.is_enabled() or not _DTID_RE.match(trip_dtid or ""):
            return None
        if not _USER_RE.match(user_dtid or ""):
            return None
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_ROLE_FOR_USER,
                    query_parameters={"dtid": trip_dtid, "uid": user_dtid},
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph role lookup({trip_dtid}) failed: {exc}")
            return None
        if not rows:
            return None
        role = (rows[0] or {}).get("role")
        return role if isinstance(role, str) else None

    # ------------------------------------------------------------- claim (#6) + follow (#65)

    def create_user_twin(self, user_dtid: str, profile: dict[str, Any]) -> bool:
        """Upsert the User twin for an authenticated user (claim flow, #6).

        ``$dtId`` IS the global auth id (the token's ``sub``). The twin carries
        the OIDC profile; ``role`` stays on the ``hasCrew`` EDGE, never on the
        node. PUT by ``$dtId`` — idempotent.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return False
        email = (profile.get("email") or "").strip()
        if not email:
            return False  # a User twin without a verified email is not useful
        name = (profile.get("name") or "").strip() or email.split("@")[0]
        auth_provider = "external"
        for prefix, provider in (("google-oauth2|", "google"), ("auth0|", "auth0")):
            if user_dtid.startswith(prefix):
                auth_provider = provider
                break
        try:
            from konnektr_graph import BasicDigitalTwin

            twin = BasicDigitalTwin.from_dict(
                {
                    "$dtId": user_dtid,
                    "$metadata": {"$model": USER_MODEL},
                    "name": name,
                    "email": email,
                    "displayName": name,
                    "authProvider": auth_provider,
                }
            )
            self._client.upsert_digital_twin(user_dtid, twin)  # type: ignore[union-attr]
            return True
        except Exception as exc:
            print(f"[kiseki] graph create user twin({user_dtid}) failed: {exc}")
            return False

    def user_twin_exists(self, user_dtid: str) -> bool:
        """True when a User twin with this global auth id exists (issue #9).

        Uses the SDK's native ``get_digital_twin`` (a 404 surfaces as
        ``ResourceNotFoundError``) — no hand-rolled Cypher probe (Niko,
        2026-09-09). Uncached on purpose: trip creation checks-then-provisions
        in one flow, and a cached False would re-provision (harmless but
        noisy) or, worse, mask a twin created a moment ago. A rare op — no
        TTL needed.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return False
        try:
            from konnektr_graph import ResourceNotFoundError

            self._client.get_digital_twin(user_dtid)  # type: ignore[union-attr]
            return True
        except ResourceNotFoundError:
            return False
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[kiseki] graph user exists({user_dtid}) failed: {exc}")
            return False

    def claim_crew_person(
        self,
        trip_dtid: str,
        user_dtid: str,
        person_dtid: str,
        role: str,
        index: int,
        note: Optional[str] = None,
        display_name: Optional[str] = None,
    ) -> bool:
        """Transfer a trip's ``hasCrew`` edge from a placeholder Person to the
        User twin, then retire the placeholder (issue #6).

        Upserts the trip->User edge (same ``role`` + ``index`` + ``note`` +
        ``displayName`` as the placeholder's), deletes the old trip->Person
        edge, and deletes the placeholder node itself — the placeholder is
        gone once claimed. ``displayName`` (#196) is the crew's OWN name for
        this trip: carried over so a claim never renames the crew member to
        the account's name.
        """
        if not (self.is_enabled() and _DTID_RE.match(trip_dtid or "")
                and _USER_RE.match(user_dtid or "") and _DTID_RE.match(person_dtid or "")):
            return False
        if role not in {"owner", "editor", "viewer", "follower"} or not isinstance(index, int):
            return False
        if note is not None and not isinstance(note, str):
            return False
        if display_name is not None and not isinstance(display_name, str):
            return False
        try:
            from konnektr_graph import BasicRelationship

            rel_id = f"{trip_dtid}__hasCrew__{user_dtid}"
            props: dict[str, Any] = {
                "$relationshipId": rel_id,
                "$sourceId": trip_dtid,
                "$relationshipName": "hasCrew",
                "$targetId": user_dtid,
                "role": role,
                "index": index,
            }
            if note is not None:
                props["note"] = note
            if display_name:
                props["displayName"] = display_name
            rel = BasicRelationship.from_dict(props)
            self._client.upsert_relationship(trip_dtid, rel_id, rel)  # type: ignore[union-attr]
            self._client.delete_relationship(  # type: ignore[union-attr]
                trip_dtid, f"{trip_dtid}__hasCrew__{person_dtid}"
            )
            self._client.delete_digital_twin(person_dtid)  # type: ignore[union-attr]
            _invalidate_graph_cache(trip_dtid=trip_dtid, user_dtid=user_dtid)
            return True
        except Exception as exc:
            print(f"[kiseki] graph claim transfer({person_dtid}) failed: {exc}")
            return False

    def follow_trip(self, trip_dtid: str, user_dtid: str, profile: dict[str, Any]) -> bool:
        """Create a `hasCrew` edge with `role=follower` for a non-crew user (#65).

        Used when a logged-in user follows a trip via its `claimToken` invite
        (private trips require the invite; public trips can be followed
        optionally). Creates the User twin if missing, then upserts
        trip->User hasCrew(follower). No placeholder is involved, so nothing
        is deleted. The edge index appends after the existing crew.
        """
        if not (self.is_enabled() and _DTID_RE.match(trip_dtid or "")
                and _USER_RE.match(user_dtid or "")):
            return False
        # Ensure user twin exists (idempotent)
        if not self.create_user_twin(user_dtid, profile):
            return False
        # Don't double-follow
        if self.role_for_user_on_trip(trip_dtid, user_dtid) is not None:
            return True
        # Next crew index (display order). Read it FRESH — the TTL cache would
        # hand back a pre-write crew list — and take max+1 rather than a count:
        # a claim deletes a placeholder edge, so a count can collide with an
        # index still in use. Two follows in the same instant can still pick the
        # same slot; there is no transaction to hold here, and a shared display
        # position is a cosmetic tie, not a correctness bug.
        try:
            _invalidate_graph_cache(trip_dtid=trip_dtid)
            graph = self.fetch_graph(trip_dtid)
            used = [
                rel.get("index")
                for rel in (graph or {}).get("relationships", [])
                if rel.get("$sourceId") == trip_dtid
                and rel.get("$relationshipName") == "hasCrew"
                and isinstance(rel.get("index"), int)
            ]
            index = max(used) + 1 if used else 0
            from konnektr_graph import BasicRelationship

            rel_id = f"{trip_dtid}__hasCrew__{user_dtid}"
            follower_name = (profile.get("name") or "").strip() or (profile.get("email") or "").split("@")[0].strip()
            rel_props: dict[str, Any] = {
                "$relationshipId": rel_id,
                "$sourceId": trip_dtid,
                "$relationshipName": "hasCrew",
                "$targetId": user_dtid,
                "role": "follower",
                "index": index,
            }
            if follower_name:
                # The follower's own name for this trip rides the edge (#196),
                # like every other hasCrew edge.
                rel_props["displayName"] = follower_name
            rel = BasicRelationship.from_dict(rel_props)
            self._client.upsert_relationship(trip_dtid, rel_id, rel)  # type: ignore[union-attr]
            # The miss memoized by the double-follow check above, plus this
            # trip's document and the user's trip list, are all stale now.
            _invalidate_graph_cache(trip_dtid=trip_dtid, user_dtid=user_dtid)
            return True
        except Exception as exc:
            print(f"[kiseki] graph follow({trip_dtid},{user_dtid}) failed: {exc}")
            return False

    # ------------------------------------------------------- follows (#196)
    # Person->person social graph: one-directional, no approval, no
    # reciprocity. Following a person grants NO trip access — visibility still
    # gates every trip read (phase B asserts this; the edge is social only).

    def follow_user(self, actor_dtid: str, target_dtid: str) -> bool:
        """Upsert the ``follows`` relationship ``{actor} → {target}`` (#196).

        ADT-shaped body (only ``$relationshipId`` / ``$sourceId`` /
        ``$relationshipName`` / ``$targetId`` — no ``$metadata``). Idempotent:
        following twice upserts the same edge id, not an error. Self-follow
        and an unknown target twin are refused (False).
        """
        if not (self.is_enabled() and _USER_RE.match(actor_dtid or "")
                and _USER_RE.match(target_dtid or "")):
            return False
        if actor_dtid == target_dtid:
            return False  # no self-follow
        if not self.user_twin_exists(target_dtid):
            return False  # unknown target — the route maps this to 404
        try:
            from konnektr_graph import BasicRelationship

            rel_id = f"{actor_dtid}__follows__{target_dtid}"
            rel = BasicRelationship.from_dict(
                {
                    "$relationshipId": rel_id,
                    "$sourceId": actor_dtid,
                    "$relationshipName": "follows",
                    "$targetId": target_dtid,
                }
            )
            self._client.upsert_relationship(actor_dtid, rel_id, rel)  # type: ignore[union-attr]
            return True
        except Exception as exc:
            print(f"[kiseki] graph follow_user({actor_dtid},{target_dtid}) failed: {exc}")
            return False

    def unfollow_user(self, actor_dtid: str, target_dtid: str) -> bool:
        """Delete the ``follows`` relationship ``{actor} → {target}`` (#196).

        Idempotent: unfollowing someone not followed is a no-op (True), not
        an error.
        """
        if not (self.is_enabled() and _USER_RE.match(actor_dtid or "")
                and _USER_RE.match(target_dtid or "")):
            return False
        try:
            rel_id = f"{actor_dtid}__follows__{target_dtid}"
            self._client.delete_relationship(actor_dtid, rel_id)  # type: ignore[union-attr]
            return True
        except Exception as exc:
            # Deleting a missing edge is the idempotent no-op, not a failure.
            if getattr(exc, "status_code", None) == 404:
                return True
            try:
                from konnektr_graph import ResourceNotFoundError

                if isinstance(exc, ResourceNotFoundError):
                    return True
            except Exception:
                pass
            print(f"[kiseki] graph unfollow_user({actor_dtid},{target_dtid}) failed: {exc}")
            return False

    def followers_of(self, user_dtid: str) -> list[str]:
        """``$dtId``s of every user following ``user_dtid`` (#196).

        Single scoped Cypher query (one hop, ``$uid`` bound server-side) —
        never an ADT ``SELECT *`` and never a node-by-node walk.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return []
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FOLLOWERS_OF, query_parameters={"uid": user_dtid}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph followers_of({user_dtid}) failed: {exc}")
            return []
        if not rows:
            return []
        raw = (rows[0] or {}).get("followers") or []
        return [u for u in raw if isinstance(u, str) and u]

    def following_of(self, user_dtid: str) -> list[str]:
        """``$dtId``s of every user ``user_dtid`` follows (#196).

        Single scoped Cypher query (one hop, ``$uid`` bound server-side) —
        never an ADT ``SELECT *`` and never a node-by-node walk.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return []
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FOLLOWING_OF, query_parameters={"uid": user_dtid}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph following_of({user_dtid}) failed: {exc}")
            return []
        if not rows:
            return []
        raw = (rows[0] or {}).get("following") or []
        return [u for u in raw if isinstance(u, str) and u]

    # ------------------------------------------------------- profiles (#196 phase B)
    # Public-ish person reads: one twin fetch per sub (the proven
    # ``get_digital_twin`` path ``user_twin_exists`` already uses — no new
    # query surface), plus the single-hop follow queries above. A profile read
    # is therefore a bounded handful of round-trips, never a node-by-node walk.

    def get_user_profile(self, user_dtid: str) -> dict | None:
        """Flat props of one ``User`` twin (``GET /api/users/{sub}``, #196).

        Returns the ADT-style twin dict (``$dtId`` / ``$metadata`` / props) or
        None when the twin is absent, malformed, or not a ``User``. Uncached on
        purpose, like ``user_twin_exists``: a profile must reflect the latest
        write (e.g. a just-flipped ``publicName``).
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return None
        try:
            from konnektr_graph import ResourceNotFoundError

            twin = self._client.get_digital_twin(user_dtid)  # type: ignore[union-attr]
        except ResourceNotFoundError:
            return None
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[kiseki] graph user profile({user_dtid}) failed: {exc}")
            return None
        node = self._norm_node(
            twin.to_dict() if hasattr(twin, "to_dict") else twin
        )
        if not node or node.get("$dtId") != user_dtid:
            return None
        if node.get("$metadata", {}).get("$model") != USER_MODEL:
            return None
        return node

    def get_user_profiles(self, user_dtids: list[str]) -> dict[str, dict]:
        """Batch twin fetch for people lists (followers/following, crew render).

        Serial ``get_digital_twin`` calls — one proven op per sub, capped by
        the caller (people lists cap at 200; crews are a handful). Dangling
        ids (edge without a twin) are skipped, never fabricated.
        """
        out: dict[str, dict] = {}
        for sub in user_dtids or []:
            if not isinstance(sub, str) or sub in out:
                continue
            node = self.get_user_profile(sub)
            if node is not None:
                out[sub] = node
        return out

    def set_user_public_name(self, user_dtid: str, public_name: bool) -> dict | None:
        """Write the caller's own ``User.publicName`` opt-in (``PUT /api/me``).

        Get-then-upsert-full: the existing props (name/email/displayName/…)
        are preserved and only ``publicName`` changes. Returns those props, or
        None when the twin does not exist (the route maps this to 404 — the
        client calls ``ensure`` first).

        "The twin is missing" and "the graph refused the write" are DIFFERENT
        answers: a failed write raises ``GraphWriteError`` (mapped to 503), it
        never collapses into None — reporting a failed write as 404 would tell
        the caller to re-provision an identity that already exists.

        The upsert body is rebuilt from the current props with only ``$dtId`` +
        ``$metadata.$model``: a read's ``$etag`` / ``$lastUpdateTime`` is never
        echoed back into a write (stale-etag rule, cf. ``trip_to_graph.py``).
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return None
        current = self.get_user_profile(user_dtid)
        if current is None:
            return None
        props = {
            k: v
            for k, v in current.items()
            if not (isinstance(k, str) and k.startswith("$"))
        }
        props["publicName"] = bool(public_name)
        try:
            from konnektr_graph import BasicDigitalTwin

            twin = BasicDigitalTwin.from_dict(
                {"$dtId": user_dtid, "$metadata": {"$model": USER_MODEL}, **props}
            )
            self._client.upsert_digital_twin(user_dtid, twin)  # type: ignore[union-attr]
        except Exception as exc:
            print(f"[kiseki] graph set publicName({user_dtid}) failed: {exc}")
            raise GraphWriteError(503, f"graph write failed for {user_dtid}") from exc
        return props


    @staticmethod
    def _rel_from_list(r: Any) -> dict:
        """Map a [src, name, tgt, relId, role, index, note, displayName] row into
        an ADT relationship.

        ``_Q_RELS`` returns each edge as a plain list (AGE rejects `$`-prefixed
        map keys), so we assemble the canonical ``$sourceId`` /
        ``$relationshipName`` / ``$targetId`` / ``$relationshipId`` keys plus any
        edge properties (``role`` / ``index`` / ``note`` / ``displayName``) here.
        Shorter rows (pre-id, pre-note or pre-#196 edges) simply omit the
        missing properties.
        """
        if not isinstance(r, (list, tuple)):
            return dict(r) if isinstance(r, dict) else {}
        src, name, tgt, rel_id = (list(r) + [None, None, None, None])[:4]
        out: dict[str, Any] = {
            "$sourceId": src,
            "$relationshipName": name,
            "$targetId": tgt,
        }
        if rel_id is not None:
            out["$relationshipId"] = rel_id
        # edge properties ride in positions 4..n
        for k, v in zip(("role", "index", "note", "displayName"), r[4:]):
            if v is not None:
                out[k] = v
        return out

    @staticmethod
    def _trip_summary_from_list(row: Any) -> dict:
        """Map a [dtId, visibility, title, subtitle, stage, start, end, slug,
        cover, role, discoverable] row (from ``_Q_TRIPS_FOR_USER``) into a trip summary dict.

        AGE rejects `$`-prefixed map keys, so the query returns a plain list and
        we name the fields here. ``$model`` is set so the caller's model-kind
        guard works uniformly. Pre-#196-phase-B rows (10 wide, no discoverable)
        read back as ``discoverable: False``.
        """
        if not isinstance(row, (list, tuple)):
            return {}
        (
            dt_id, visibility, title, subtitle, stage,
            start, end, slug, cover, role,
        ) = (list(row) + [None] * 10)[:10]
        discoverable = row[10] if isinstance(row, (list, tuple)) and len(row) > 10 else None
        return {
            "$dtId": dt_id,
            "$model": TRIP_MODEL,
            "dtId": dt_id,
            "visibility": visibility,
            "title": title,
            "subtitle": subtitle,
            "stage": stage,
            "startDate": start,
            "endDate": end,
            "slug": slug,
            "cover": cover,
            "role": role,
            "discoverable": bool(discoverable),
        }

    @staticmethod
    def _norm_node(node: Any) -> dict:
        """Normalize an AGE vertex into a flat ADT-style twin dict.

        Handles both a seed/ADT-style flat map (``$dtId`` at top level) and an
        Apache AGE vertex object, which may serialize as
        ``{id, label, properties: {...}}`` — in which case we lift the
        properties to the top level so ``convert`` finds ``$dtId`` / ``$metadata``.
        """
        if not isinstance(node, dict):
            to_dict = getattr(node, "to_dict", None)
            return to_dict() if callable(to_dict) else {}
        props = node.get("properties")
        if isinstance(props, dict) and "$dtId" not in node:
            merged: dict[str, Any] = dict(props)
            if "$metadata" not in merged and node.get("$metadata") is not None:
                merged["$metadata"] = node["$metadata"]
            return merged
        return node

# ---------------------------------------------------------- content writes (#46)
# The write-path service (``app/write.py``) mutates trip content through these
# thin SDK ops. Every op:
#   - validates ids defensively before touching the SDK,
#   - forwards the caller's auth ``sub`` as ``x-user-id`` so the graph stamps
#     ``$lastUpdatedBy`` server-side (chart has x-user-id enabled, #3) — the
#     SDK accepts per-call ``headers``, so concurrent callers never bleed into
#     each other's attribution,
#   - retires this trip's cached reads on success (a write is immediately
#     followed by a re-read of the document).
# Errors raise ``GraphWriteError`` with an HTTP-ish status so the service can
# map them precisely (404 unknown twin, 409 conflict, 503 graph failure) —
# unlike the claim bool-returning ops above, content writes must not fail soft.


class GraphWriteError(Exception):
    """Raised when a graph content write fails; carries an HTTP status."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class GraphWriteClient(GraphReadClient):
    """Thin JSON-Patch/upsert surface for trip content writes (#46).

    Reuses the read client's SDK wiring (same endpoint, same token, same
    module-level cache — writes retire the entries they stale). Constructed
    exactly like ``GraphReadClient``; ``is_enabled()`` is inherited.
    """

    _REL_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,128}__[A-Za-z0-9]{1,64}__[A-Za-z0-9|@._:-]{1,256}$")

    # ------------------------------------------------------------- twin ops
    def update_twin_props(
        self,
        trip_dtid: str,
        dtid: str,
        patch_ops: list[dict[str, Any]],
        x_user_id: str | None = None,
    ) -> None:
        """Apply a JSON Patch to one twin's properties (content fields only).

        ``patch_ops`` is the RFC 6902 list sent verbatim to the graph's
        PATCH /digitaltwins/<id>. The service builds ops against the CURRENT
        twin props (``add`` for missing properties, ``replace`` for existing,
        ``remove`` for explicit clears), so this method never guesses.
        """
        self._guard_content(trip_dtid, dtid, x_user_id)
        self._run(
            lambda: self._client.update_digital_twin(  # type: ignore[union-attr]
                dtid, patch_ops, headers={"x-user-id": x_user_id or ""}
            ),
            trip_dtid, f"twin patch {dtid}",
        )

    def upsert_twin(
        self,
        trip_dtid: str,
        twin: dict[str, Any],
        x_user_id: str | None = None,
    ) -> None:
        """PUT an ADT-shaped twin (create or full replace by ``$dtId``)."""
        self._guard_content(trip_dtid, str(twin.get("$dtId") or ""), x_user_id)
        self._run(
            lambda: self._client.upsert_digital_twin(  # type: ignore[union-attr]
                twin["$dtId"], self._as_basic_twin(twin),
                headers={"x-user-id": x_user_id or ""},
            ),
            trip_dtid, f"twin upsert {twin.get('$dtId')}",
        )

    def delete_twin(self, trip_dtid: str, dtid: str, x_user_id: str | None = None) -> None:
        """Delete a twin (and, server-side, its incident edges)."""
        self._guard_content(trip_dtid, dtid, x_user_id)
        self._run(
            lambda: self._client.delete_digital_twin(  # type: ignore[union-attr]
                dtid, headers={"x-user-id": x_user_id or ""}
            ),
            trip_dtid, f"twin delete {dtid}",
        )

    # -------------------------------------------------------- relationship ops
    def upsert_relationship(
        self,
        trip_dtid: str,
        rel: dict[str, Any],
        x_user_id: str | None = None,
    ) -> None:
        """PUT an ADT relationship (``$relationshipId`` = ``<src>__<name>__<tgt>``)."""
        self._guard_content(trip_dtid, str(rel.get("$sourceId") or ""), x_user_id)
        self._run(
            lambda: self._client.upsert_relationship(  # type: ignore[union-attr]
                rel["$sourceId"], rel["$relationshipId"],
                self._as_basic_relationship(rel),
                headers={"x-user-id": x_user_id or ""},
            ),
            trip_dtid, f"relationship upsert {rel.get('$relationshipId')}",
        )

    def update_relationship_props(
        self,
        source_dtid: str,
        rel_id: str,
        patch_ops: list[dict[str, Any]],
        x_user_id: str | None = None,
    ) -> None:
        """Apply a JSON Patch to one relationship's properties (e.g. crew role/note).

        ADT scopes a relationship under its SOURCE twin — ``source_dtid`` must be
        the edge's ``$sourceId`` (the trip for ``hasCrew``/root ``atLocation``,
        the section/day/block for their outgoing edges), not merely the trip.
        """
        self._guard_content(source_dtid, source_dtid, x_user_id)
        self._run(
            lambda: self._client.update_relationship(  # type: ignore[union-attr]
                source_dtid, rel_id, patch_ops, headers={"x-user-id": x_user_id or ""}
            ),
            source_dtid, f"relationship patch {rel_id}",
        )

    def delete_relationship(self, source_dtid: str, rel_id: str, x_user_id: str | None = None) -> None:
        """Delete a relationship by its ``<src>__<name>__<tgt>`` id.

        ``source_dtid`` must be the edge's ``$sourceId`` — the server only knows
        the relationship under its source twin (issue #89: passing the trip for a
        section/day-sourced edge makes every delete 404 → 500).
        """
        self._guard_content(source_dtid, source_dtid, x_user_id)
        self._run(
            lambda: self._client.delete_relationship(  # type: ignore[union-attr]
                source_dtid, rel_id, headers={"x-user-id": x_user_id or ""}
            ),
            source_dtid, f"relationship delete {rel_id}",
        )

    # ---------------------------------------------------------------- helpers
    def _guard_content(self, trip_dtid: str, dtid: str, x_user_id: str | None) -> None:
        if not self.is_enabled():
            raise GraphWriteError(503, "Graph not configured")
        if not _DTID_RE.match(trip_dtid or "") or not _DTID_RE.match(dtid or ""):
            raise GraphWriteError(422, f"Malformed twin id: {dtid!r}")
        if x_user_id is not None and not _USER_RE.match(x_user_id):
            raise GraphWriteError(422, "Malformed actor id")

    def _run(self, fn: Callable, trip_dtid: str, what: str) -> None:
        try:
            fn()
        except Exception as exc:
            # SDK maps HTTP statuses to typed exceptions carrying status_code
            # (404 ResourceNotFound, 409 ResourceExists, 401/403 auth, else
            # HttpResponseError). A graph-auth failure is our problem, not the
            # caller's: surface it as 503, never as a client 401/403.
            status = getattr(exc, "status_code", None)
            if status == 404:
                raise GraphWriteError(404, f"Graph entity not found ({what})") from exc
            if status == 409:
                raise GraphWriteError(409, f"Graph conflict ({what})") from exc
            print(f"[kiseki] graph write {what} failed: {exc}")
            raise GraphWriteError(503, f"Graph write failed ({what})") from exc
        _invalidate_graph_cache(trip_dtid=trip_dtid)

    @staticmethod
    def _as_basic_twin(twin: dict[str, Any]):
        from konnektr_graph import BasicDigitalTwin

        return BasicDigitalTwin.from_dict(twin)

    @staticmethod
    def _as_basic_relationship(rel: dict[str, Any]):
        from konnektr_graph import BasicRelationship

        return BasicRelationship.from_dict(rel)

