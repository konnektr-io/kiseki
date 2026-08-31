"""Live Konnektr Graph adapter (P1 source of truth, issue #4).

This module is the ONLY place that imports ``konnektr-graph``. It exposes a
small, source-agnostic contract so the rest of the backend never depends on the
SDK directly:

    is_enabled()                    -> bool  (graph wired; else local trip.json source)
    find_trip_dtid_by_token(token)  -> dtid | None
    find_trip_dtid_by_claim_token(t)-> dtid | None   (issue #6 join link)
    fetch_graph(dtid)               -> {"$dtId", "twins", "relationships"}
    list_trips_for_user(user_dtid)  -> [trip summary dict, ...]  (hasCrew access)
    role_for_user_on_trip(...)      -> role | None                 (ACL, #5)
    create_user_twin(...)           -> bool   (claim flow, #6)
    claim_crew_person(...)          -> bool   (edge transfer + placeholder delete, #6)

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

**Parameterized Cypher (SDK >= 0.3.8).** The token / dtId / uid arrive from the
URL, so they are passed as Cypher query parameters (``$token`` / ``$dtid`` /
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
from typing import Any, Optional

from app.config import KISEKI_GRAPH_TOKEN, KISEKI_GRAPH_URL

# Every node in the graph is a ``:Twin``; the kind is carried by the
# ``$metadata.$model`` property (dtmi:kiseki:travel:<Kind>;1).
TRIP_MODEL = "dtmi:kiseki:travel:Trip;1"
USER_MODEL = "dtmi:kiseki:travel:User;1"
PERSON_MODEL = "dtmi:kiseki:travel:Person;1"

# A trip token is a secret-share id from the URL path. Validated as defense in
# depth — the value is passed as a Cypher parameter, never interpolated.
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
# trip -> day -> block -> atLocation = 3 hops; we allow one hop of headroom so
# a future edge can't silently miss. Unbounded [*0..] makes the AGE planner
# explore the whole reachable graph and is dramatically slower. This MUST be a
# compile-time literal in the range bound, so it is inlined (not a parameter).
MAX_HOPS = 4

# --- Cypher (parameterized) -----------------------------------------------
# Locate the Trip twin by its secret share token. Scoped to one node; the model
# kind is re-checked in Python. `$token` is a bound parameter.
_Q_FIND_TRIP = """
MATCH (trip:Twin)
WHERE trip.token = $token
RETURN trip
LIMIT 1
"""

# Same, but keyed on the CLAIM token (issue #6 join link) — a separate secret
# that authorizes claiming a crew identity on this trip.
_Q_FIND_TRIP_BY_CLAIM = """
MATCH (trip:Twin)
WHERE trip.claimToken = $claimToken
RETURN trip
LIMIT 1
"""

# All twins in the trip's connected component (trip itself + every node
# reachable along outgoing edges). A single query, scoped to the trip — not the
# whole store. `$dtid` is a bound parameter; MAX_HOPS is a literal range bound.
_Q_NODES = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
MATCH path = (trip)-[*0..{max_hops}]->(n:Twin)
RETURN collect(DISTINCT n) AS nodes
""".format(max_hops=MAX_HOPS)

# All relationships whose source is in the trip's component. AGE rejects a `$`
# map key (even quoted), so we collect each edge as a plain LIST
# [sourceId, relationshipName, targetId, role, index] and map it to the ADT
# relationship shape in Python. `type(r)` is the edge name.
_Q_RELS = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
MATCH (trip)-[*0..{max_hops}]->(a:Twin)
MATCH (a)-[r]->(b:Twin)
RETURN collect(DISTINCT [a.`$dtId`, type(r), b.`$dtId`, r.role, r.index]) AS rels
""".format(max_hops=MAX_HOPS)

# All trips a user has access to, reached via the `hasCrew` edge (trip -> user).
# Returns a flat LIST per trip [dtId, token, title, subtitle, stage, startDate,
# endDate, slug, cover, role] (map keys with `$` are rejected by AGE, so we
# assemble the summary dict in Python). `$uid` is a bound parameter.
_Q_TRIPS_FOR_USER = """
MATCH (t:Twin)-[crew:hasCrew]->(u:Twin)
WHERE u.`$dtId` = $uid
RETURN collect(DISTINCT [t.`$dtId`, t.token, t.title, t.subtitle, t.stage,
                         t.startDate, t.endDate, t.slug, t.cover, crew.role]) AS trips
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

    def find_trip_dtid_by_token(self, token: str) -> Optional[str]:
        """Return the Trip twin ``$dtId`` whose ``token`` property matches.

        A single scoped, parameterized Cypher query (``$token`` bound server-side).
        Returns None if the graph is disabled, the token is malformed, or it is
        unknown.
        """
        if not self.is_enabled() or not _TOKEN_RE.match(token or ""):
            return None
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FIND_TRIP, query_parameters={"token": token}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph trip lookup failed: {exc}")
            return None
        if not rows:
            return None
        trip = self._norm_node((rows[0] or {}).get("trip") or {})
        if trip.get("$metadata", {}).get("$model") != TRIP_MODEL:
            return None
        return trip.get("$dtId")

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

    # ------------------------------------------------------------- claim (#6)

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

    def claim_crew_person(
        self,
        trip_dtid: str,
        user_dtid: str,
        person_dtid: str,
        role: str,
        index: int,
    ) -> bool:
        """Transfer a trip's ``hasCrew`` edge from a placeholder Person to the
        User twin, then retire the placeholder (issue #6).

        Upserts the trip->User edge (same ``role`` + ``index`` as the
        placeholder's), deletes the old trip->Person edge, and deletes the
        placeholder node itself — the placeholder is gone once claimed.
        """
        if not (self.is_enabled() and _DTID_RE.match(trip_dtid or "")
                and _USER_RE.match(user_dtid or "") and _DTID_RE.match(person_dtid or "")):
            return False
        if role not in {"owner", "editor", "viewer", "follower"} or not isinstance(index, int):
            return False
        try:
            from konnektr_graph import BasicRelationship

            rel_id = f"{trip_dtid}__hasCrew__{user_dtid}"
            rel = BasicRelationship.from_dict(
                {
                    "$relationshipId": rel_id,
                    "$sourceId": trip_dtid,
                    "$relationshipName": "hasCrew",
                    "$targetId": user_dtid,
                    "role": role,
                    "index": index,
                }
            )
            self._client.upsert_relationship(trip_dtid, rel_id, rel)  # type: ignore[union-attr]
            self._client.delete_relationship(  # type: ignore[union-attr]
                trip_dtid, f"{trip_dtid}__hasCrew__{person_dtid}"
            )
            self._client.delete_digital_twin(person_dtid)  # type: ignore[union-attr]
            return True
        except Exception as exc:
            print(f"[kiseki] graph claim transfer({person_dtid}) failed: {exc}")
            return False

    @staticmethod
    def _rel_from_list(r: Any) -> dict:
        """Map a [src, name, tgt, role, index] row into an ADT relationship.

        ``_Q_RELS`` returns each edge as a plain list (AGE rejects `$`-prefixed
        map keys), so we assemble the canonical ``$sourceId`` /
        ``$relationshipName`` / ``$targetId`` keys plus any edge properties
        (``role`` / ``index``) here.
        """
        if not isinstance(r, (list, tuple)):
            return dict(r) if isinstance(r, dict) else {}
        src, name, tgt = (list(r) + [None, None, None])[:3]
        out: dict[str, Any] = {
            "$sourceId": src,
            "$relationshipName": name,
            "$targetId": tgt,
        }
        # edge properties ride in positions 3..n
        for k, v in (zip(("role", "index"), r[3:4]) if len(r) == 4
                     else zip(("role", "index"), r[3:5])):
            if v is not None:
                out[k] = v
        return out

    @staticmethod
    def _trip_summary_from_list(row: Any) -> dict:
        """Map a [dtId, token, title, subtitle, stage, start, end, slug,
        cover, role] row (from ``_Q_TRIPS_FOR_USER``) into a trip summary dict.

        AGE rejects `$`-prefixed map keys, so the query returns a plain list and
        we name the fields here. ``$model`` is set so the caller's model-kind
        guard works uniformly.
        """
        if not isinstance(row, (list, tuple)):
            return {}
        (
            dt_id, token, title, subtitle, stage,
            start, end, slug, cover, role,
        ) = (list(row) + [None] * 10)[:10]
        return {
            "$dtId": dt_id,
            "$model": TRIP_MODEL,
            "dtId": dt_id,
            "token": token,
            "title": title,
            "subtitle": subtitle,
            "stage": stage,
            "startDate": start,
            "endDate": end,
            "slug": slug,
            "cover": cover,
            "role": role,
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
