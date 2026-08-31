"""Live Konnektr Graph read adapter (P1 source of truth, issue #4).

This module is the ONLY place that imports ``konnektr-graph``. It exposes a
small, source-agnostic contract so the rest of the backend never depends on the
SDK directly:

    is_enabled()                    -> bool  (graph wired, or file fallback)
    find_trip_dtid_by_token(token)  -> dtid | None
    fetch_graph(dtid)               -> {"$dtId", "twins", "relationships"}
    list_trips_for_user(user_dtid)  -> [trip summary dict, ...]  (hasCrew access)

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

Input safety: the token arrives from the URL and the dtId is an internal id, so
both are validated against a strict charset before being interpolated into
Cypher (the SDK's ``query_twins`` does not forward query parameters).

If the SDK is missing or the endpoint is absent, ``is_enabled()`` is False and
the backend keeps serving from ``trip.json`` (graceful first boot / fallback).
"""

from __future__ import annotations

import re
from typing import Any, Optional

from app.config import KISEKI_GRAPH_TOKEN, KISEKI_GRAPH_URL

# Every node in the graph is a ``:Twin``; the kind is carried by the
# ``$metadata.$model`` property (dtmi:kiseki:travel:<Kind>;1).
TRIP_MODEL = "dtmi:kiseki:travel:Trip;1"

# A trip token is a secret-share id from the URL path — only these characters
# are ever interpolated into a Cypher string (no quotes/backslashes/semicolons).
_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~-]{1,256}$")
# Our twin ids are opaque UUIDs (see issue #8 restructure).
_DTID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
# A user twin id is `user:<authId>` (global auth id, transferred on login).
# Auth ids come from external IdPs (Auth0 uses `auth0|...`, `google-oauth2|...`)
# so we can't use a narrow whitelist. We only reject the characters that would
# break Cypher single-quoted-string interpolation: the quote itself, the
# backslash escape char, and control characters. Everything else is safe
# inside `'...'` and is validated again by the graph (no such node -> []).
_USER_RE = re.compile(r"^[^'\\\x00-\x1f]{1,256}$")

# Bounded traversal depth for the subgraph walk. The Kiseki graph is shallow:
# trip -> day -> block -> atLocation = 3 hops; we allow one hop of headroom so
# a future edge can't silently miss. Unbounded `[*0..]` makes the AGE planner
# explore the whole reachable graph and is dramatically slower.
MAX_HOPS = 4

# --- Cypher -----------------------------------------------------------------
# Locate the Trip twin by its secret share token. Scoped to one node; the model
# kind is re-checked in Python (avoids nested map access in Cypher).
_Q_FIND_TRIP = """
MATCH (trip:Twin)
WHERE trip.token = '{token}'
RETURN trip
LIMIT 1
"""

# All twins in the trip's connected component (trip itself + every node
# reachable along outgoing edges). A single query, scoped to the trip — not the
# whole store.
_Q_NODES = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = '{dtid}'
MATCH path = (trip)-[*0..{max_hops}]->(n:Twin)
RETURN collect(DISTINCT n) AS nodes
"""

# All relationships whose source is in the trip's component. AGE rejects a `$`
# map key (even quoted), so we collect each edge as a plain LIST
# ``[sourceId, relationshipName, targetId, role, index]`` and map it to the ADT
# relationship shape in Python. ``type(r)`` is the edge name.
_Q_RELS = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = '{dtid}'
MATCH (trip)-[*0..{max_hops}]->(a:Twin)
MATCH (a)-[r]->(b:Twin)
RETURN collect(DISTINCT [a.`$dtId`, type(r), b.`$dtId`, r.role, r.index]) AS rels
"""

# All trips a user has access to, reached via the ``hasCrew`` edge (trip ->
# user). Returns a flat LIST per trip ``[dtId, token, title, subtitle, stage,
# startDate, endDate, slug, cover, role]`` (map keys with `$` are rejected by
# AGE, so we assemble the summary dict in Python). The model-kind filter is
# applied in Python as elsewhere.
_Q_TRIPS_FOR_USER = """
MATCH (t:Twin)-[crew:hasCrew]->(u:Twin)
WHERE u.`$dtId` = '{uid}'
RETURN collect(DISTINCT [t.`$dtId`, t.token, t.title, t.subtitle, t.stage,
                         t.startDate, t.endDate, t.slug, t.cover, crew.role]) AS trips
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

        A single scoped Cypher query (token validated beforehand). Returns None
        if the graph is disabled, the token is malformed, or it is unknown.
        """
        if not self.is_enabled() or not _TOKEN_RE.match(token or ""):
            return None
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FIND_TRIP.format(token=token)
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

    def fetch_graph(self, trip_dtid: str) -> Optional[dict]:
        """Return the trip's connected component as a {twins, relationships} bundle.

        Two scoped Cypher queries (nodes + relationships) replace the old
        per-node walk. Both are limited to the trip's reachable subgraph within
        ``MAX_HOPS`` (bounded so the AGE planner never expands the whole graph).
        """
        if not self.is_enabled() or not _DTID_RE.match(trip_dtid or ""):
            return None
        try:
            node_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_NODES.format(dtid=trip_dtid, max_hops=MAX_HOPS)
                )
            )
            rel_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_RELS.format(dtid=trip_dtid, max_hops=MAX_HOPS)
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
        (shouldn't exist) out of the result.

        Returns an empty list if the graph is disabled, the id is malformed, or
        the user has no trips.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return []
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_TRIPS_FOR_USER.format(uid=user_dtid)
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

    @staticmethod
    def _rel_from_list(r: Any) -> dict:
        """Map a ``[src, name, tgt, role, index]`` row into an ADT relationship.

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
        """Map a ``[dtId, token, title, subtitle, stage, start, end, slug,
        cover, role]`` row (from ``_Q_TRIPS_FOR_USER``) into a trip summary dict.

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
