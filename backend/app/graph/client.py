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
parameter is ``MAX_HOPS``: it decides how many hops the trip's closure read
walks, and Apache AGE rejects a parameter in a range bound (they must be
compile-time literals), so the hop chain is generated from it in Python and the
constant is inlined as a literal — see ``_hop_chain`` (#267).

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
              "find_trip_dtid_by_claim_token": 60.0,
              "find_trip_dtid_by_follow_token": 60.0,
              # The feed's ordered reads (issue #199): 60 s, matching the
              # subgraph fetch they reuse. The feed is a poll, so a minute of
              # staleness is fine — and it is why feed.py must NOT add a second
              # cache layer of its own.
              "trips_for_user_ordered": 60.0, "trips_of_followed": 60.0,
              # The feed's own narrow read (#264) — same 60 s poll budget as
              # the ordered reads above. Its OWN key: it no longer shares
              # ``fetch_graph``'s entry, so the trip page still pays for the
              # full bundle while the feed stops paying for it entirely.
              "fetch_feed_bundle": 60.0,
              # The landing showcase (#249): same 60 s as the reads above.
              "list_showcase_trips": 60.0,
              # The signed-in home's map pins (#249 E2): same 60 s poll budget.
              "list_geo_trips": 60.0}


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
# ids, so retiring them is a subset match on the memoized args. Every trip-keyed
# read belongs here: a write retires the read cache so the caller's re-read sees
# its own edit (``_invalidate_graph_cache``), and the feed's narrow read (#264)
# is trip-keyed — omitting it would leave an edited trip's feed rows stale for
# up to its full TTL.
_CREW_CACHED_READS = {"fetch_graph", "role_for_user_on_trip", "list_trips_for_user",
                      "fetch_feed_bundle", "list_geo_trips"}
# Token lookups are keyed by the SECRET, not the trip id — a rotation or a
# revoke must therefore retire them by token value (#197). Crew writes
# deliberately leave them cached (a claim/link write doesn't change what a
# token resolves to).
_TOKEN_CACHED_READS = {"find_trip_dtid_by_claim_token", "find_trip_dtid_by_follow_token"}


def _invalidate_graph_cache(*, trip_dtid: str | None = None, user_dtid: str | None = None,
                            token: str | None = None) -> None:
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
    if not ids and not token:
        return
    with _GRAPH_CACHE_LOCK:
        stale = [
            k for k in _GRAPH_CACHE
            if (k[0] in _CREW_CACHED_READS and ids & set(k[1]))
            # Token lookups are keyed by the SECRET, not the trip id, so a
            # rotation/revoke retires them by value (#197).
            or (bool(token) and k[0] in _TOKEN_CACHED_READS and token in k[1])
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

# Bounds for the feed's writer-ordered trip reads (issue #199). Same rule as
# MAX_HOPS above: AGE takes bound parameters in WHERE but NOT in LIMIT / range
# bounds, so the limit is inlined — which is why it must be a validated int and
# never caller text. FEED_LIMIT_MAX is the single source of truth: feed.py
# clamps the HTTP `limit` to it too, so an oversized request cannot ask the
# graph to order the whole store before slicing.
FEED_LIMIT_MAX = 50
FEED_LIMIT_DEFAULT = 30

# The signed-out landing's showcase read (#249). Small on purpose: the front
# door shows a shelf of trips, not an archive, and every extra card is bytes
# an anonymous visitor pays for.
SHOWCASE_LIMIT_MAX = 24
SHOWCASE_LIMIT_DEFAULT = 8


def clamp_showcase_limit(limit: Any) -> int:
    """A validated int in ``1..SHOWCASE_LIMIT_MAX`` for the landing showcase.

    Same contract as ``clamp_feed_limit``: unparseable input falls back to the
    default instead of failing a read the front door depends on.
    """
    try:
        n = int(limit)
    except (TypeError, ValueError):
        return SHOWCASE_LIMIT_DEFAULT
    return max(1, min(n, SHOWCASE_LIMIT_MAX))


def clamp_feed_limit(limit: Any) -> int:
    """A validated int in ``1..FEED_LIMIT_MAX``, safe to interpolate.

    Unparseable input falls back to the default instead of raising: a bad
    ``limit`` is a caller bug, not a reason to fail a feed read.
    """
    try:
        n = int(limit)
    except (TypeError, ValueError):
        return FEED_LIMIT_DEFAULT
    return max(1, min(n, FEED_LIMIT_MAX))


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

# Locate the Trip twin by its FOLLOW token (#197) — the credential behind a
# "follow link". Deliberately a SEPARATE property from claimToken: a token
# that can locate a trip for following can never be used to claim an identity
# (claim_identity resolves by claimToken alone). `$followToken` is bound.
_Q_FIND_TRIP_BY_FOLLOW = """
MATCH (trip:Twin)
WHERE trip.followToken = $followToken
RETURN trip
LIMIT 1
"""

# Where the graph records its own write time, per twin AND per property:
# `$metadata.$lastUpdateTime` (ISO-8601 UTC) and `$lastUpdatedBy` (the actor).
# Reading them is verified on the live AGE 1.7.0 kiseki cluster (2026-09-14):
# `t.`$metadata`.`$lastUpdateTime`` (backtick access) and
# `t['$metadata']['$lastUpdateTime']` (bracket access) BOTH work, and either
# form is valid in ORDER BY — so a writer-ordered feed is a plain Cypher read:
# no timestamp column, no second store. `$metadata` is a nested map, so each
# property carries its OWN `$lastUpdateTime`; that is what lets the feed say
# *what* changed (stage, cover, title), not merely *that* something did.
_META_AT = "`$metadata`.`$lastUpdateTime`"
_META_BY = "`$metadata`.`$lastUpdatedBy`"

# The feed's two streams (issue #199), both ordered by the write time the graph
# records itself — no timestamp column, no second store. LIMIT is inlined by
# ``_clamp_limit`` (see above); `$uid` is a bound parameter.
#
# Stream 1 — every trip I can read: same reachability as
# ``list_trips_for_user`` (``Trip -[:hasCrew]-> Person``; the reverse direction
# matches nothing), plus the write metadata. `meta` rides along so the caller
# can say WHAT changed, not merely that something did: each property carries
# its own `$lastUpdateTime`.
#
# Stream 2 — trips of the people I follow. `follows` is person -> person and
# grants NO access, so the row carries `discoverable` and the caller applies the
# listing rule (#196). A private trip of a followed person must never appear:
# that is the rule the profile page already uses, mirrored rather than
# re-invented.
_Q_TRIPS_FOR_ME_ORDERED = """
MATCH (trip:Twin)-[:hasCrew]->(me:Twin)
WHERE me.`$dtId` = $uid
RETURN trip.`$dtId` AS dtId, trip.title AS title,
       trip.visibility AS visibility, trip.stage AS stage,
       trip.`$metadata`.`$lastUpdateTime` AS at,
       trip.`$metadata`.`$lastUpdatedBy` AS actor,
       trip.`$metadata` AS meta
ORDER BY at DESC LIMIT {limit}
"""

_Q_TRIPS_OF_FOLLOWED = """
MATCH (me:Twin)-[:follows]->(person:Twin)
MATCH (trip:Twin)-[:hasCrew]->(person)
WHERE me.`$dtId` = $uid
RETURN trip.`$dtId` AS dtId, trip.title AS title,
       trip.discoverable AS discoverable, trip.visibility AS visibility,
       trip.`$metadata`.`$lastUpdateTime` AS at,
       trip.`$metadata`.`$lastUpdatedBy` AS actor
ORDER BY at DESC LIMIT {limit}
"""


def _ordered_trip_row(row: dict) -> dict:
    """Map an ordered-trip row (stream 1 or 2) into the feed's flat summary.

    ``at`` / ``by`` are ``None`` for a twin the graph never stamped (the
    committed mocks carry `$metadata.$model` only): the feed renders those as
    "date unknown" rather than inventing one. ``discoverable`` appears only when
    the query returned it (stream 2) — "not asked" is not "not listed", and a
    twin with no such property never reads back True.
    """
    meta = row.get("meta")
    out = {
        "dtId": row.get("dtId"),
        "title": row.get("title") or "",
        "visibility": row.get("visibility") or "private",
        "stage": row.get("stage") or "",
        "at": row.get("at") or None,
        # The query aliases this `actor`: `AS by` is a syntax error in the
        # graph's SQL planner (BY is reserved). The public row key stays `by`.
        "by": row.get("actor") or None,
    }
    if isinstance(meta, dict):
        out["meta"] = meta
    if "discoverable" in row:
        out["discoverable"] = bool(row.get("discoverable"))
    return out

# The trip's connected component is read as an EXPLICIT hop chain, never as
# `-[*0..MAX_HOPS]->`. The variable-length form expands every PATH of length
# <= MAX_HOPS, and path multiplicity is what costs: on a 102-twin trip the
# closure holds 140 distinct edges but 1,665 path instances (`hasBlock` alone:
# 996 instances for ~51 blocks, because a block is reachable by more than one
# route). That expansion was 1,331 ms of a 1,461 ms read; chaining one-hop
# OPTIONAL MATCHes computes the identical node set in 32 ms (issue #267).
# Both queries are GENERATED from MAX_HOPS so the bound cannot drift out of
# them — a hardcoded chain would silently under-fetch if MAX_HOPS rose.
def _hop_chain(max_hops: int) -> str:
    """One ``OPTIONAL MATCH`` per hop: ``(trip)-->(h1)-->(h2)-->…``."""
    lines: list[str] = []
    prev = "trip"
    for i in range(1, max_hops + 1):
        lines.append(f"OPTIONAL MATCH ({prev})-->(h{i}:Twin)")
        prev = f"h{i}"
    return "\n".join(lines)


def _closure_expr(max_hops: int) -> str:
    """``collect(DISTINCT trip) + collect(DISTINCT h1) + …`` — hop 0 included."""
    parts = ["collect(DISTINCT trip)"]
    parts += [f"collect(DISTINCT h{i})" for i in range(1, max_hops + 1)]
    return " + ".join(parts)


_HOP_CHAIN = _hop_chain(MAX_HOPS)
_CLOSURE = _closure_expr(MAX_HOPS)

# All twins in the trip's connected component (trip itself + every node
# reachable along outgoing edges). A single query, scoped to the trip — not the
# whole store. `$dtid` is a bound parameter.
# The UNWIND + `collect(DISTINCT n)` round trip is what preserves the old
# `collect(DISTINCT n)` contract: a node can sit at more than one hop, so the
# concatenated lists carry duplicates, and `fetch_graph` builds its twin list
# positionally — un-deduped input would surface as repeated twins.
_Q_NODES = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
{chain}
WITH {closure} AS closure
UNWIND closure AS n
RETURN collect(DISTINCT n) AS nodes
""".format(chain=_HOP_CHAIN, closure=_CLOSURE)

# All relationships whose source is in the trip's component. Each edge comes back
# as a plain LIST — for SHAPE reasons, not because AGE refuses `$` keys (it
# accepts them quoted; see _META_AT). The bundle is assembled as dicts right
# here, so a nested map would only have to be re-shaped anyway.
# [sourceId, relationshipName, targetId, relationshipId, role, index, note,
#  displayName] and map it to the ADT relationship shape in Python. `type(r)`
# is the edge name; the edge's own `$relationshipId` property is included
# because it is the server's handle for get/delete-by-id (ADT scopes
# relationship ids per source twin) — without it the fetched bundle cannot
# drive relationship writes (issue #89: every relationship read back as
# id-less). `displayName` (#196) is the crew's own trip-relative name on
# hasCrew edges; shorter rows (pre-#196 edges) simply omit it.
# The closure is UNWOUND and matched per node rather than re-expanded: that is
# what stopped the hop-3 closure being paid for twice (issue #267). The
# `WHERE b IS NOT NULL` is load-bearing, not defensive: `OPTIONAL MATCH` after
# an UNWIND emits `[leaf, null, null, …]` for every node with no outgoing edge,
# and `_rel_from_list` maps such a row straight into the bundle as
# `{"$sourceId": <leaf>, "$relationshipName": None, …}` — 217 rows instead of
# the correct 140. A mandatory `MATCH` cannot be used to drop them instead:
# AGE rejects re-matching the UNWIND'd variable ("42712: variable 'a' already
# exists").
_Q_RELS = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
{chain}
WITH {closure} AS closure
UNWIND closure AS a
OPTIONAL MATCH (a)-[r]->(b:Twin)
WITH a, r, b WHERE b IS NOT NULL
RETURN collect(DISTINCT [a.`$dtId`, type(r), b.`$dtId`, r.`$relationshipId`, r.role, r.index, r.note, r.displayName]) AS rels
""".format(chain=_HOP_CHAIN, closure=_CLOSURE)

# All trips a user has access to, reached via the `hasCrew` edge (trip -> user).
# Returns a flat LIST per trip [dtId, visibility, title, subtitle, stage, startDate,
# endDate, slug, cover, role, discoverable] — a list, assembled into the summary
# dict in Python (shape, not an AGE limitation: `$` keys are fine when quoted,
# see _META_AT). `$uid` is a bound parameter.
# `discoverable` (#196 phase B) rides along so profile listings can apply the
# discoverable-only rule without a second query per trip.
_Q_TRIPS_FOR_USER = """
MATCH (t:Twin)-[crew:hasCrew]->(u:Twin)
WHERE u.`$dtId` = $uid
RETURN collect(DISTINCT [t.`$dtId`, t.visibility, t.title, t.subtitle, t.stage,
                         t.startDate, t.endDate, t.slug, t.cover, crew.role,
                         t.discoverable]) AS trips
"""

# The signed-out front door (#249): PUBLIC, DISCOVERABLE trips as cards —
# {dtId, title, subtitle, stage, dates, cover} and nothing else. Anonymous
# callers reach this, so it must never be a weaker gate than the one-trip read
# it advertises: ``/api/trips/{id}`` already serves a ``public`` trip to a
# caller with no token, so LISTING public trips discloses nothing that opening
# one does not. The rule is narrower than that route all the same —
# ``discoverable`` is the owner's listing opt-in (#196) — so a public trip that
# opted out of being listed stays off the landing page. ``private`` never
# matches.
#
# Rows, not ``collect()``: a bare LIMIT lets the planner stop after N matches
# instead of materialising every trip in the store first. No ORDER BY, because
# ordering is a display concern and the caller sorts.
_Q_SHOWCASE_TRIPS = """
MATCH (t:Twin)
WHERE t.visibility = 'public' AND t.discoverable = true
RETURN t.`$dtId` AS dtId, t.visibility AS visibility,
       t.discoverable AS discoverable, t.title AS title,
       t.subtitle AS subtitle, t.stage AS stage, t.startDate AS startDate,
       t.endDate AS endDate, t.cover AS cover
LIMIT {limit}
"""

# The signed-in home's map canvas (#249 E2): one anchor point per LISTABLE
# trip. Two queries, merged in Python — the same two-round-trip shape as
# ``_profile_trips`` (the target's trips + the viewer's trips for the role
# map), because the list rule is the same one: ``discoverable`` OR the viewer
# already has a role on it.
#
# Both carry each trip's registry locations as collected [name, lat, lng,
# edge-index] rows so the anchor ("the first located registry entry") is
# picked in Python without a second query per trip. ``$uid`` is a bound
# parameter; the discoverable read takes none.
_Q_GEO_MINE = """
MATCH (t:Twin)-[crew:hasCrew]->(u:Twin)
WHERE u.`$dtId` = $uid
OPTIONAL MATCH (t)-[a:atLocation]->(l:Twin)
RETURN t.`$dtId` AS dtId, t.title AS title, t.stage AS stage,
       collect(DISTINCT [l.name, l.lat, l.lng, a.index]) AS places
"""

_Q_GEO_DISCOVERABLE = """
MATCH (t:Twin)
WHERE t.discoverable = true
OPTIONAL MATCH (t)-[a:atLocation]->(l:Twin)
RETURN t.`$dtId` AS dtId, t.title AS title, t.stage AS stage,
       t.discoverable AS discoverable,
       collect(DISTINCT [l.name, l.lat, l.lng, a.index]) AS places
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
# Returns plain id LISTS (assembled in Python — see _META_AT on `$` keys).
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

# --- the feed's own read (#264) -------------------------------------------
# The activity feed walks exactly two hops of a trip — days, then each day's
# blocks — and reads nothing else (``feed.items_of_trip``). Doing that through
# ``fetch_graph`` meant paying for the WHOLE connected component: ``_Q_NODES``
# expands every twin within MAX_HOPS and ``_Q_RELS`` collects every edge in it,
# which measured ~0.9-2.9 s per trip and ~99.7% of the feed's 6.5 s cold load
# (three sequential walks) — cost driven by trip CONTENT, not trip count.
# Scoped to the two hops the feed reads, the same trip answers in ~8 ms.
#
# Deliberately NOT folded into ``fetch_graph``: the trip page needs the whole
# document, and narrowing that read would silently break it. Two reads, two
# cache keys, each paying only for what it uses.
_Q_FEED_NODES = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
MATCH (trip)-[:hasDay]->(day:Twin)
OPTIONAL MATCH (day)-[:hasBlock]->(block:Twin)
RETURN collect(DISTINCT day) AS days, collect(DISTINCT block) AS blocks
"""

# Edge rows are emitted in the ``_Q_RELS`` shape ([src, name, tgt, relId, role,
# index]) with the two unused middle slots left null, so ``_rel_from_list``
# maps them without a second mapper. Only ``index`` matters: it is what orders
# days and blocks (``feed._edge_targets``) — AGE row order is not stable.
_Q_FEED_RELS = """
MATCH (trip:Twin)
WHERE trip.`$dtId` = $dtid
MATCH (trip)-[de:hasDay]->(day:Twin)
OPTIONAL MATCH (day)-[be:hasBlock]->(block:Twin)
RETURN collect(DISTINCT [trip.`$dtId`, type(de), day.`$dtId`, null, null, de.index]) AS day_edges,
       collect(DISTINCT [day.`$dtId`, type(be), block.`$dtId`, null, null, be.index]) AS block_edges
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
    def find_trip_dtid_by_follow_token(self, follow_token: str) -> Optional[str]:
        """Return the Trip twin ``$dtId`` whose ``followToken`` matches (#197).

        The FOLLOW credential resolves a trip — it is never accepted where a
        CLAIM credential is required: ``claim_identity`` reads ``claimToken``
        only, so a follow token is structurally incapable of claiming crew
        (see ``tests/test_follow_197.py``).
        """
        if not self.is_enabled() or not _TOKEN_RE.match(follow_token or ""):
            return None
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FIND_TRIP_BY_FOLLOW, query_parameters={"followToken": follow_token}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph follow lookup failed: {exc}")
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
    def fetch_feed_bundle(self, trip_dtid: str) -> Optional[dict]:
        """The trip slice the ACTIVITY FEED reads — days and their blocks (#264).

        Same ``{twins, relationships}`` bundle shape as ``fetch_graph``, so
        ``feed.items_of_trip`` reads it unchanged, but scoped to the two hops
        that function actually walks: ``trip -[:hasDay]-> day -[:hasBlock]->
        block``. Sections, locations, crew, features, practicalities and every
        other edge are not in it, and neither is any twin beyond those days and
        blocks.

        This is a performance read, not a second source of truth: the feed
        walked the whole component per trip (~0.9-2.9 s) to read two hops of it,
        and only the edges the feed orders by (``index``) come back. Use
        ``fetch_graph`` for anything that needs the trip document.

        Returns ``None`` when the graph is disabled or the id is malformed, and
        a Trip-less bundle for an unknown id — the live graph's shape (#171),
        same as ``fetch_graph``.
        """
        if not self.is_enabled() or not _DTID_RE.match(trip_dtid or ""):
            return None
        try:
            node_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FEED_NODES, query_parameters={"dtid": trip_dtid}
                )
            )
            rel_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_FEED_RELS, query_parameters={"dtid": trip_dtid}
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph feed bundle fetch({trip_dtid}) failed: {exc}")
            return None

        nodes = (node_rows[0] or {}) if node_rows else {}
        edges = (rel_rows[0] or {}) if rel_rows else {}

        # ``collect()`` skips nulls, so a day with no blocks contributes the day
        # alone; DAYS come before BLOCKS, and a block belongs to exactly one day,
        # so the twin map the feed indexes cannot collide.
        twins = [self._norm_node(n) for n in (nodes.get("days") or []) if n]
        twins += [self._norm_node(n) for n in (nodes.get("blocks") or []) if n]

        raw_rels = (edges.get("day_edges") or []) + (edges.get("block_edges") or [])
        relationships = [
            self._rel_from_list(r)
            for r in raw_rels
            # An OPTIONAL MATCH miss collects a null-padded row; a row without a
            # target is not an edge.
            if isinstance(r, (list, tuple)) and len(r) > 2 and r[2]
        ]
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
    def list_showcase_trips(self, limit: int = SHOWCASE_LIMIT_DEFAULT) -> list[dict]:
        """Public, discoverable trips as cards — the signed-out landing (#249).

        Anonymous-safe by construction: the query reads card fields only, so
        this path cannot leak crew, a claim/follow token or ``practical`` that
        the one-trip public read hides. The rule is re-checked in Python rather
        than trusted to the WHERE clause — a listing that outlives its filter is
        a privacy bug — and that check is strict, so an absent flag never reads
        as "listable".

        Cached for 60 s like the other hot reads: the front door is hit by
        people who never sign in, and a trip published a minute ago appearing a
        minute later is fine. Returns ``[]`` when the graph is disabled or the
        read fails — the landing collapses the band instead of showing a broken
        shelf, and a marketing page must never 500 because the graph is down.
        """
        if not self.is_enabled():
            return []
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_SHOWCASE_TRIPS.format(limit=clamp_showcase_limit(limit))
                )
            )
        except Exception as exc:  # noqa: BLE001 — a landing read must not 5xx
            print(f"[kiseki] graph showcase read failed: {exc}")
            return []
        cards: list[dict] = []
        for row in rows:
            card = self._trip_card_from_row(row)
            if card is not None:
                cards.append(card)
        if not cards:
            # Not an error, but this is the failure that hides: a query AGE
            # accepts and that matches nothing looks exactly like a landing
            # page that was designed without examples. Say so once per cache
            # window (60 s) — with the row count, so a filter typo and an empty
            # graph are distinguishable from the log alone.
            print(
                "[kiseki] showcase read listed no trips "
                f"({len(rows)} row(s) matched, limit={clamp_showcase_limit(limit)})"
            )
        return cards

    @_cached_graph
    def list_geo_trips(self, user_dtid: str) -> list[dict]:
        """One anchor point per trip the viewer may LIST (#249 E2 — the gate
        slices 3 and 5 build on).

        A trip is listed when EITHER it is ``discoverable`` OR the viewer
        already has a role on it — the ``_profile_trips`` rule
        (``backend/app/main.py``), re-checked in Python, never trusted to the
        WHERE clause alone (same discipline as ``list_showcase_trips``).

        Each row is ``dtId, title, stage`` plus an ``anchor`` ``{lat, lng,
        name}`` — the FIRST located registry entry (``atLocation`` edge order,
        i.e. the trip's own ① ② … marker order). The choice is documented
        because a trip has many places and a pin needs one: the first stop is
        where the journey starts. Trips with no located place are OMITTED —
        never a null-island 0,0 pin.

        Cards, not documents: no crew, no claim/follow token, no ``practical``,
        no booking/cost fields. Cached 60 s like the other hot reads; ``[]``
        when the graph is disabled, the id is malformed, or the read fails —
        the home collapses the map instead of 500-ing.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return []
        try:
            mine_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_GEO_MINE, query_parameters={"uid": user_dtid}
                )
            )
            disc_rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_GEO_DISCOVERABLE
                )
            )
        except Exception as exc:  # noqa: BLE001 — a home read must not 5xx
            print(f"[kiseki] graph geo read failed: {exc}")
            return []
        out: list[dict] = []
        seen: set[str] = set()
        for row in mine_rows:
            geo = self._geo_row_from_dict(row, origin="mine")
            if geo is not None:
                seen.add(geo["dtId"])
                out.append(geo)
        for row in disc_rows:
            if not isinstance(row, dict) or row.get("dtId") in seen:
                continue
            # The second lock on the listing boundary: the query filters, but
            # an absent flag must never read as "listable".
            if row.get("discoverable") is not True:
                continue
            geo = self._geo_row_from_dict(row, origin="discover")
            if geo is not None:
                seen.add(geo["dtId"])
                out.append(geo)
        return out

    @_cached_graph
    def trips_for_user_ordered(
        self, user_dtid: str, limit: int = FEED_LIMIT_DEFAULT
    ) -> list[dict]:
        """Every trip a user can read, newest write first (feed stream 1).

        The same trips as ``list_trips_for_user`` — including those reached
        through a ``hasCrew role=follower`` edge, which DOES grant read — but
        ordered by the graph's own ``$metadata.$lastUpdateTime`` and carrying it
        plus ``by`` (the actor) and ``meta`` (the per-property times).

        Cached for 60 s like the other hot reads: the feed can be up to a minute
        stale, which is fine for a poll. Do NOT add a second cache layer in the
        caller.

        Returns an empty list if the graph is disabled, the id is malformed, or
        the query fails.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return []
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_TRIPS_FOR_ME_ORDERED.format(limit=clamp_feed_limit(limit)),
                    query_parameters={"uid": user_dtid},
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph trips-for-user-ordered({user_dtid}) failed: {exc}")
            return []
        return [_ordered_trip_row(r) for r in rows if isinstance(r, dict)]

    @_cached_graph
    def trips_of_followed(
        self, user_dtid: str, limit: int = FEED_LIMIT_DEFAULT
    ) -> list[dict]:
        """Trips of the people a user follows, newest write first (stream 2).

        ``follows`` grants no access, so every row is annotated with
        ``discoverable`` and the CALLER decides what may be listed (#196) — the
        query deliberately does not filter, so the rule lives in one place. A
        twin with no such property never reads back True.

        Cached for 60 s (see ``trips_for_user_ordered``); empty list when the
        graph is disabled, the id is malformed, or the query fails.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return []
        try:
            rows = list(
                self._client.query_twins(  # type: ignore[union-attr]
                    _Q_TRIPS_OF_FOLLOWED.format(limit=clamp_feed_limit(limit)),
                    query_parameters={"uid": user_dtid},
                )
            )
        except Exception as exc:
            print(f"[kiseki] graph trips-of-followed({user_dtid}) failed: {exc}")
            return []
        return [_ordered_trip_row(r) for r in rows if isinstance(r, dict)]

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

    def revert_crew_person(
        self,
        trip_dtid: str,
        user_dtid: str,
        person_dtid: str,
        name: str,
        role: str,
        index: int,
        note: Optional[str] = None,
        display_name: Optional[str] = None,
    ) -> bool:
        """Revert one trip's ``hasCrew`` edge from a User twin back to a fresh
        placeholder Person (account erasure, #196 phase C).

        The exact inverse of ``claim_crew_person``: upserts a new Person twin
        (trip-relative ``name`` only), upserts the trip->Person edge carrying
        the SAME ``role`` + ``index`` + ``note`` + ``displayName``, then
        deletes the old trip->User edge. The trip renders identically for
        everyone else; only the account behind the row is gone.

        Account-level props (``email``, ``contact`` — phone/email "when
        available") are deliberately NOT carried over: the crew-authored
        trip-relative row (name / role / index / note / displayName) survives,
        the erased person's own contact details do not. Erasure that re-created
        the person's phone number on a shared trip would defeat the point of
        art. 17.

        Raw SDK ops (like ``claim_crew_person``): the guarded write-client
        wrappers reject non-UUID twin ids, and a User ``$dtId`` is an auth sub,
        not a UUID.
        """
        if not (self.is_enabled() and _DTID_RE.match(trip_dtid or "")
                and _USER_RE.match(user_dtid or "") and _DTID_RE.match(person_dtid or "")):
            return False
        if not isinstance(name, str) or not name:
            return False
        if role not in {"owner", "editor", "viewer", "follower"} or not isinstance(index, int):
            return False
        if note is not None and not isinstance(note, str):
            return False
        if display_name is not None and not isinstance(display_name, str):
            return False
        try:
            from konnektr_graph import BasicDigitalTwin, BasicRelationship

            twin_props: dict[str, Any] = {
                "$dtId": person_dtid,
                "$metadata": {"$model": PERSON_MODEL},
                "name": name,
            }
            self._client.upsert_digital_twin(  # type: ignore[union-attr]
                person_dtid, BasicDigitalTwin.from_dict(twin_props)
            )
            rel_id = f"{trip_dtid}__hasCrew__{person_dtid}"
            props: dict[str, Any] = {
                "$relationshipId": rel_id,
                "$sourceId": trip_dtid,
                "$relationshipName": "hasCrew",
                "$targetId": person_dtid,
                "role": role,
                "index": index,
            }
            if note is not None:
                props["note"] = note
            if display_name:
                props["displayName"] = display_name
            self._client.upsert_relationship(  # type: ignore[union-attr]
                trip_dtid, rel_id, BasicRelationship.from_dict(props)
            )
            self._client.delete_relationship(  # type: ignore[union-attr]
                trip_dtid, f"{trip_dtid}__hasCrew__{user_dtid}"
            )
            _invalidate_graph_cache(trip_dtid=trip_dtid, user_dtid=user_dtid)
            return True
        except Exception as exc:
            print(f"[kiseki] graph crew revert({person_dtid}) failed: {exc}")
            return False

    def delete_user_twin(self, user_dtid: str) -> bool:
        """Delete a ``User`` twin (account erasure, #196 phase C).

        The caller removes every incident edge first (``hasCrew`` reverts +
        ``follows`` deletes) — the server does NOT cascade twin deletes, so a
        twin that still has edges refuses deletion and this returns False
        (the route surfaces that honestly as a 503, never as success). False
        when the twin does not exist either; the route checks existence first
        so a second erasure is a clean 404 there.
        """
        if not self.is_enabled() or not _USER_RE.match(user_dtid or ""):
            return False
        try:
            self._client.delete_digital_twin(user_dtid)  # type: ignore[union-attr]
            _invalidate_graph_cache(user_dtid=user_dtid)
            return True
        except Exception as exc:
            print(f"[kiseki] graph delete user twin({user_dtid}) failed: {exc}")
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

        ``_Q_RELS`` returns each edge as a plain list, so we assemble the canonical
        ``$sourceId`` /
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
    def _trip_card_from_row(row: Any) -> Optional[dict]:
        """One ``_Q_SHOWCASE_TRIPS`` row to a landing card, or ``None``.

        ``None`` means "not listable": no dtId, not public, or not
        ``discoverable``. The graph filters those already, but this is the
        second lock on a privacy boundary, so it compares strictly — a missing
        property must never read as True — and returns an allowlisted dict
        rather than the row, so a future column added to the query cannot ride
        along to an anonymous caller by accident.
        """
        if not isinstance(row, dict):
            return None
        dt_id = row.get("dtId")
        if not dt_id:
            return None
        if row.get("visibility") != "public" or row.get("discoverable") is not True:
            return None
        return {
            "dtId": dt_id,
            "title": row.get("title") or "",
            "subtitle": row.get("subtitle") or "",
            "stage": row.get("stage") or "",
            "startDate": row.get("startDate"),
            "endDate": row.get("endDate"),
            "cover": row.get("cover"),
        }

    @staticmethod
    def _geo_row_from_dict(row: Any, origin: str) -> Optional[dict]:
        """One ``_Q_GEO_*`` row to a map pin, or ``None``.

        ``None`` means "no pin": no dtId, or no located place — an unlocated
        trip is omitted rather than pinned at 0,0. Returns an allowlisted dict
        (never the row), so a future column added to the query cannot ride
        along to the caller by accident.
        """
        if not isinstance(row, dict):
            return None
        dt_id = row.get("dtId")
        if not dt_id:
            return None
        places = row.get("places") or []
        # Registry order is the `atLocation` edge `index` (trip_to_graph
        # writes it per registry position); entries without one sort last.
        # `collect()` over a trip with no locations yields a single
        # null-padded row — skipped like any other unlocated entry below.
        def _order(place: Any) -> tuple[bool, Any]:
            idx = place[3] if isinstance(place, (list, tuple)) and len(place) > 3 else None
            if isinstance(idx, bool) or not isinstance(idx, (int, float)):
                return (True, 0)
            return (False, idx)

        anchor: Optional[dict] = None
        for place in sorted(places, key=_order):
            if not isinstance(place, (list, tuple)) or len(place) < 3:
                continue
            name, lat, lng = place[0], place[1], place[2]
            if (
                isinstance(lat, bool)
                or isinstance(lng, bool)
                or not isinstance(lat, (int, float))
                or not isinstance(lng, (int, float))
            ):
                continue
            anchor = {"lat": lat, "lng": lng, "name": name or ""}
            break
        if anchor is None:
            return None
        return {
            "dtId": dt_id,
            "title": row.get("title") or "",
            "stage": row.get("stage") or "",
            "anchor": anchor,
            "origin": origin,
        }

    @staticmethod
    def _trip_summary_from_list(row: Any) -> dict:
        """Map a [dtId, visibility, title, subtitle, stage, start, end, slug,
        cover, role, discoverable] row (from ``_Q_TRIPS_FOR_USER``) into a trip summary dict.

        The query returns a plain list (shape — `$` keys are fine when quoted, see
        ``_META_AT``) and we name the fields here. ``$model`` is set so the caller's model-kind
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

