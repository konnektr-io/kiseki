"""In-memory Konnektr Graph double for write-path tests (#46).

A real GraphReadClient/GraphWriteClient talks to the live graph over HTTP;
endpoint tests for the write API need a graph that actually APPLIES writes so
the write → re-read roundtrip can be asserted (a write that the next GET does
not reflect is a bug). ``FakeGraph`` is a stateful stand-in implementing the
same client surface the store uses:

Reads (mirrors ``app.graph.client.GraphReadClient``):
    is_enabled() -> True
    fetch_graph(trip_dtid)               -> {twins, relationships} bundle
    role_for_user_on_trip(trip, user)    -> role | None (hasCrew edge only)
    list_trips_for_user(user)            -> [summary, ...]

Writes (mirrors ``app.graph.client.GraphWriteClient``, thin SDK ops):
    update_twin(trip_dtid, dtid, patch_ops, x_user_id)
    upsert_twin(trip_dtid, twin_dict, x_user_id)
    delete_twin(trip_dtid, dtid, x_user_id)
    upsert_relationship(trip_dtid, rel_dict, x_user_id)
    update_relationship(trip_dtid, rel_id, patch_ops, x_user_id)
    delete_relationship(trip_dtid, rel_id, x_user_id)

JSON Patch semantics are RFC 6902 (strict): ``add`` inserts or overwrites at an
existing parent, ``replace`` requires the path to exist, ``remove`` requires it
to exist, ``-`` appends to arrays, numeric indices insert. The write service
builds its ops against the CURRENT twin props, so the double's strictness
catches a service bug (e.g. ``replace`` on a missing property) that a
permissive server might hide.

Seed from a committed anon fixture (``data/mocks/*.graph.anon.json``) so
``convert.graph_to_trip`` works unchanged; helper methods mutate the store the
way a fixture would (grant the test user a crew role, flip visibility).
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

_MOCKS = Path(__file__).resolve().parent.parent / "data" / "mocks"


class FakeGraphError(Exception):
    """Raised on invalid patch ops / missing entities (test double only)."""


def _apply_patch_ops(target: dict, ops: list[dict]) -> None:
    """Apply RFC 6902 ops to a flat ADT-style twin dict (props only)."""
    for op in ops:
        action = op.get("op")
        path = op.get("path", "")
        if action in ("add", "replace", "remove"):
            _apply_single(target, action, path, op.get("value", None))
        else:
            raise FakeGraphError(f"unsupported patch op {action!r}")


def _resolve_parent(target: dict, path: str) -> tuple[Any, str]:
    """Walk a '/a/b/2/c' path to (parent, last_key); parent is dict or list."""
    if not path.startswith("/") or path == "/":
        raise FakeGraphError(f"bad patch path {path!r}")
    parts = path.strip("/").split("/")
    cur: Any = target
    for part in parts[:-1]:
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError) as exc:
                raise FakeGraphError(f"bad array index in {path!r}") from exc
        else:
            if part not in cur:
                raise FakeGraphError(f"missing parent segment {part!r} of {path!r}")
            cur = cur[part]
    return cur, parts[-1]


def _apply_single(target: dict, action: str, path: str, value: Any) -> None:
    if action == "remove":
        parent, key = _resolve_parent(target, path)
        if isinstance(parent, list):
            idx = int(key)
            if not 0 <= idx < len(parent):
                raise FakeGraphError(f"remove index out of range: {path}")
            parent.pop(idx)
        elif key in parent:
            del parent[key]
        else:
            raise FakeGraphError(f"remove on missing property: {path}")
        return

    parent, key = _resolve_parent(target, path)
    if isinstance(parent, list):
        if key == "-":
            parent.append(value)
            return
        idx = int(key)
        if action == "replace":
            if not 0 <= idx < len(parent):
                raise FakeGraphError(f"replace index out of range: {path}")
            parent[idx] = value
        else:  # add
            if idx < 0 or idx > len(parent):
                raise FakeGraphError(f"add index out of range: {path}")
            parent.insert(idx, value)
        return
    # dict parent
    if action == "replace" and key not in parent:
        raise FakeGraphError(f"replace on missing property: {path}")
    parent[key] = value


class FakeGraph:
    """Stateful in-memory {twins, relationships} store + client surface."""

    def __init__(self, fixture: str = "canada-2027.graph.anon.json") -> None:
        raw = json.loads((_MOCKS / fixture).read_text(encoding="utf-8"))
        self.root = raw["$dtId"]
        self.twins: list[dict] = copy.deepcopy(raw["twins"])
        self.rels: list[dict] = copy.deepcopy(raw["relationships"])
        self.write_headers: list[dict] = []  # x-user-id capture per write call

    # ------------------------------------------------------------ store ops
    def _bundle(self) -> dict:
        return {
            "$dtId": self.root,
            "twins": copy.deepcopy(self.twins),
            "relationships": copy.deepcopy(self.rels),
        }

    def twin(self, dtid: str) -> dict | None:
        return next((t for t in self.twins if t.get("$dtId") == dtid), None)

    def kind(self, dtid: str) -> str | None:
        t = self.twin(dtid)
        if t is None:
            return None
        model = (t.get("$metadata") or {}).get("$model", "")
        return model.rsplit(":", 1)[-1].split(";")[0] if model else None

    def rels_from(self, src: str, name: str | None = None) -> list[dict]:
        out = [r for r in self.rels if r.get("$sourceId") == src]
        if name:
            out = [r for r in out if r.get("$relationshipName") == name]
        return out

    def rel(self, rel_id: str) -> dict | None:
        return next((r for r in self.rels if r.get("$relationshipId") == rel_id), None)

    def set_twin_prop(self, dtid: str, prop: str, value: Any) -> None:
        t = self.twin(dtid)
        if t is None:
            raise FakeGraphError(f"no twin {dtid}")
        if value is None:
            t.pop(prop, None)
        else:
            t[prop] = value

    def add_user_role(self, trip_dtid: str, user_dtid: str, role: str, name: str = "Test Owner") -> None:
        """Fixture helper: give the test identity a crew role on a trip.

        Creates the User twin (``$dtId`` = auth sub) + ``hasCrew`` edge so the
        real ACL path (``role_for_user_on_trip``) resolves, not a monkeypatch.
        """
        existing = next(
            (r for r in self.rels
             if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
             and r.get("$targetId") == user_dtid),
            None,
        )
        if existing is None:
            if self.twin(user_dtid) is None:
                self.twins.append({
                    "$dtId": user_dtid,
                    "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
                    "name": name,
                    "email": "agent@test.local",
                    "displayName": name,
                    "authProvider": "external",
                })
            used = [
                r.get("index") for r in self.rels_from(trip_dtid, "hasCrew")
                if isinstance(r.get("index"), int)
            ]
            index = max(used) + 1 if used else 0
            self.rels.append({
                "$relationshipId": f"{trip_dtid}__hasCrew__{user_dtid}",
                "$sourceId": trip_dtid,
                "$relationshipName": "hasCrew",
                "$targetId": user_dtid,
                "role": role,
                "index": index,
            })
        else:
            existing["role"] = role

    # ------------------------------------------------------------ read surface
    def is_enabled(self) -> bool:
        return True

    def fetch_graph(self, trip_dtid: str) -> dict | None:
        if trip_dtid != self.root or self.twin(trip_dtid) is None:
            return None
        return self._bundle()

    def role_for_user_on_trip(self, trip_dtid: str, user_dtid: str) -> str | None:
        for r in self.rels_from(trip_dtid, "hasCrew"):
            if r.get("$targetId") == user_dtid:
                role = r.get("role")
                return role if isinstance(role, str) else None
        return None

    def list_trips_for_user(self, user_dtid: str) -> list[dict]:
        out = []
        for r in self.rels:
            if r.get("$relationshipName") == "hasCrew" and r.get("$targetId") == user_dtid:
                t = self.twin(r.get("$sourceId", ""))
                if t:
                    out.append({
                        "dtId": t["$dtId"], "visibility": t.get("visibility", "private"),
                        "title": t.get("title", ""), "subtitle": t.get("subtitle", ""),
                        "stage": t.get("stage", "idea"), "startDate": t.get("startDate"),
                        "endDate": t.get("endDate"), "slug": t.get("slug", ""),
                        "cover": t.get("cover"), "role": r.get("role"),
                    })
        return out

    # ------------------------------------------------------------ write surface
    def _note(self, trip_dtid: str, x_user_id: str | None) -> None:
        self.write_headers.append({"x-user-id": x_user_id, "trip": trip_dtid})

    def update_twin_props(self, trip_dtid: str, dtid: str, patch_ops: list[dict],
                          x_user_id: str | None = None) -> None:
        self._note(trip_dtid, x_user_id)
        t = self.twin(dtid)
        if t is None:
            raise FakeGraphError(f"no twin {dtid}")
        for op in patch_ops:
            path = op.get("path", "")
            if path in ("/$dtId", "/$metadata") or path.startswith("/$metadata"):
                raise FakeGraphError("patch targets protected framing")
        _apply_patch_ops(t, patch_ops)

    def upsert_twin(self, trip_dtid: str, twin: dict, x_user_id: str | None = None) -> None:
        self._note(trip_dtid, x_user_id)
        dtid = twin.get("$dtId")
        existing = self.twin(dtid)
        if existing is not None:
            self.twins.remove(existing)
        self.twins.append(copy.deepcopy(twin))

    def delete_twin(self, trip_dtid: str, dtid: str, x_user_id: str | None = None) -> None:
        self._note(trip_dtid, x_user_id)
        t = self.twin(dtid)
        if t is None:
            raise FakeGraphError(f"no twin {dtid}")
        self.twins.remove(t)
        self.rels = [r for r in self.rels
                     if r.get("$sourceId") != dtid and r.get("$targetId") != dtid]

    def upsert_relationship(self, trip_dtid: str, rel: dict,
                            x_user_id: str | None = None) -> None:
        self._note(trip_dtid, x_user_id)
        rel_id = rel.get("$relationshipId")
        existing = self.rel(rel_id)
        if existing is not None:
            self.rels.remove(existing)
        self.rels.append(copy.deepcopy(rel))

    def update_relationship_props(self, trip_dtid: str, rel_id: str, patch_ops: list[dict],
                                  x_user_id: str | None = None) -> None:
        self._note(trip_dtid, x_user_id)
        existing = self.rel(rel_id)
        if existing is None:
            raise FakeGraphError(f"no relationship {rel_id}")
        _apply_patch_ops(existing, patch_ops)

    def delete_relationship(self, trip_dtid: str, rel_id: str,
                            x_user_id: str | None = None) -> None:
        self._note(trip_dtid, x_user_id)
        existing = self.rel(rel_id)
        if existing is None:
            raise FakeGraphError(f"no relationship {rel_id}")
        self.rels.remove(existing)
