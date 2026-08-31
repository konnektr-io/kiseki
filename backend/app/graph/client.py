"""Live Konnektr Graph read adapter (P1 source of truth, issue #4).

This module is the ONLY place that imports ``konnektr-graph``. It exposes a
small, source-agnostic contract so the rest of the backend never depends on the
SDK directly:

    is_enabled()                    -> bool  (graph wired, or file fallback)
    find_trip_dtid_by_token(token)  -> dtid | None
    fetch_graph(dtid)               -> {"$dtId", "twins", "relationships"}

``fetch_graph`` always returns the SAME normalized shape as the committed
``data/seed/*.graph.json`` fixtures (produced by ``scripts/trip_to_graph.py``):
an ADT twin/relationship bundle. ``convert.graph_to_trip`` consumes that shape
regardless of whether it came from the live SDK or a seed file.

If the SDK is missing or the endpoint is absent, ``is_enabled()`` is False and
the backend keeps serving from ``trip.json`` (graceful first boot / fallback).
"""

from __future__ import annotations

from typing import Any, Optional

from app.config import KISEKI_GRAPH_TOKEN, KISEKI_GRAPH_URL

TRIP_MODEL = "dtmi:kiseki:travel:Trip;1"


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

        We list Trip twins and filter by token client-side — robust against
        query-selector syntax differences across graph backends.
        """
        if not self.is_enabled():
            return None
        try:
            for row in self._client.query_twins(  # type: ignore[union-attr]
                f"SELECT * FROM DIGITALTWINS WHERE $model = '{TRIP_MODEL}'"
            ):
                if row.get("token") == token:
                    return row.get("$dtId")
        except Exception as exc:
            print(f"[kiseki] graph trip query failed: {exc}")
        return None

    def fetch_graph(self, trip_dtid: str) -> Optional[dict]:
        """Walk the trip subgraph and return {twins, relationships}.

        BFS from the Trip twin along every outgoing relationship, fetching each
        referenced twin and its relationships. The Trip→Day→Block,
        Trip→Section→(Day|Block|Location), Trip→Crew/Feature/Location edges are
        all reachable this way; a visited-set prevents loops.
        """
        if not self.is_enabled():
            return None
        try:
            from konnektr_graph import BasicDigitalTwin, BasicRelationship
        except Exception:
            return None

        try:
            root = self._client.get_digital_twin(trip_dtid)  # type: ignore[union-attr]
        except Exception as exc:
            print(f"[kiseki] graph get_digital_twin({trip_dtid}) failed: {exc}")
            return None

        def _norm_twin(t: Any) -> dict:
            return t.to_dict() if isinstance(t, BasicDigitalTwin) else dict(t)

        def _norm_rel(r: Any) -> dict:
            return r.to_dict() if isinstance(r, BasicRelationship) else dict(r)

        twins: list[dict] = [_norm_twin(root)]
        relationships: list[dict] = []
        visited: set[str] = {trip_dtid}
        queue: list[str] = [trip_dtid]

        while queue:
            current = queue.pop(0)
            try:
                rels = list(self._client.list_relationships(current))  # type: ignore[union-attr]
            except Exception as exc:
                print(f"[kiseki] list_relationships({current}) failed: {exc}")
                rels = []
            for r in rels:
                rn = _norm_rel(r)
                relationships.append(rn)
                tgt = rn.get("$targetId")
                if tgt and tgt not in visited:
                    try:
                        t = self._client.get_digital_twin(tgt)  # type: ignore[union-attr]
                    except Exception as exc:
                        print(f"[kiseki] get_digital_twin({tgt}) failed: {exc}")
                        continue
                    twins.append(_norm_twin(t))
                    visited.add(tgt)
                    queue.append(tgt)

        return {"$dtId": trip_dtid, "twins": twins, "relationships": relationships}
