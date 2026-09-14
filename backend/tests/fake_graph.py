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
        """Mirror the LIVE graph's unknown-id shape (issue #171).

        The real graph answers an unknown ``$dtId`` with a NON-EMPTY bundle
        (``{"$dtId": …, "twins": [], "relationships": []}`` — Cypher
        ``collect()`` over zero matches), NOT ``None``. Reproducing that here
        is the point: the store/converter must treat a truthy Trip-less
        bundle as "absent" (→ 404), and with the old ``return None`` the
        tests never exercised that path (prod 500'd on it).
        """
        t = self.twin(trip_dtid)
        if t is None or self.kind(trip_dtid) != "Trip":
            return {"$dtId": trip_dtid, "twins": [], "relationships": []}
        bundle = self._bundle()
        bundle["$dtId"] = trip_dtid
        return bundle

    def user_twin_exists(self, user_dtid: str) -> bool:
        return self.twin(user_dtid) is not None

    def follow_trip(self, trip_dtid: str, user_dtid: str, profile: dict) -> bool:
        """Mirror the real ``follow_trip`` (#65 / #197): a non-crew user gets a
        ``hasCrew`` edge with ``role=follower``.

        Creates the User twin when it is missing (no verified email → False;
        the server invents no identity) and never duplicates an edge or
        downgrades a role that is already there.
        """
        if not self.create_user_twin(user_dtid, profile):
            return False
        if self.role_for_user_on_trip(trip_dtid, user_dtid) is not None:
            return True
        used: list[int] = [r["index"] for r in self.rels_from(trip_dtid, "hasCrew")
                           if isinstance(r.get("index"), int)]
        self.rels.append({
            "$relationshipId": f"{trip_dtid}__hasCrew__{user_dtid}",
            "$sourceId": trip_dtid,
            "$relationshipName": "hasCrew",
            "$targetId": user_dtid,
            "role": "follower",
            "index": max(used) + 1 if used else 0,
        })
        return True

    def find_trip_dtid_by_claim_token(self, claim_token: str) -> str | None:
        """Mirror the live claim-token lookup (claim flow, #6)."""
        for t in self.twins:
            if (t.get("$metadata") or {}).get("$model") == "dtmi:kiseki:travel:Trip;1":
                if t.get("claimToken") == claim_token:
                    return t["$dtId"]
        return None

    def find_trip_dtid_by_follow_token(self, follow_token: str) -> str | None:
        """Mirror the live follow-token lookup (#197).

        Deliberately a SEPARATE lookup from the claim one: the follow
        credential locates a trip, and nothing here ever hands it to
        ``claim_crew_person``.
        """
        for t in self.twins:
            if (t.get("$metadata") or {}).get("$model") == "dtmi:kiseki:travel:Trip;1":
                if t.get("followToken") == follow_token:
                    return t["$dtId"]
        return None

    def claim_crew_person(self, trip_dtid: str, user_dtid: str, person_dtid: str,
                          role: str, index: int, note: str | None = None,
                          display_name: str | None = None) -> bool:
        """Mirror the real ``claim_crew_person`` (#6 + #196): upsert the
        trip->User hasCrew edge (same role + index + note + displayName as the
        placeholder's), delete the old trip->Person edge, then delete the
        placeholder node (edges first — the server refuses non-cascade
        deletes, like ``delete_twin`` above)."""
        old = next(
            (r for r in self.rels
             if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
             and r.get("$targetId") == person_dtid),
            None,
        )
        if old is None:
            return False
        edge: dict = {
            "$relationshipId": f"{trip_dtid}__hasCrew__{user_dtid}",
            "$sourceId": trip_dtid,
            "$relationshipName": "hasCrew",
            "$targetId": user_dtid,
            "role": role,
            "index": index,
        }
        if note is not None:
            edge["note"] = note
        if display_name:
            edge["displayName"] = display_name
        existing = self.rel(edge["$relationshipId"])
        if existing is not None:
            self.rels.remove(existing)
        self.rels.append(edge)
        self.rels.remove(old)
        # The placeholder goes with the claim; a claimed User twin is global.
        # Edges are gone first so the no-cascade guard below stays quiet.
        self.rels = [r for r in self.rels
                     if not (r.get("$sourceId") == person_dtid or r.get("$targetId") == person_dtid)]
        person = self.twin(person_dtid)
        if person is not None:
            self.twins.remove(person)
        return True
    def revert_crew_person(self, trip_dtid: str, user_dtid: str, person_dtid: str,
                           name: str, role: str, index: int, note: str | None = None,
                           display_name: str | None = None) -> bool:
        """Mirror the real ``revert_crew_person`` (#196 phase C): upsert the
        fresh Person twin, upsert the trip->Person hasCrew edge (same role +
        index + note + displayName), then delete the old trip->User edge.
        No account-level props (email/contact) are carried over — erasure
        drops the subject's PII, as the real client does."""
        old = next(
            (r for r in self.rels
             if r.get("$sourceId") == trip_dtid and r.get("$relationshipName") == "hasCrew"
             and r.get("$targetId") == user_dtid),
            None,
        )
        if old is None:
            return False
        twin_props: dict = {
            "$dtId": person_dtid,
            "$metadata": {"$model": "dtmi:kiseki:travel:Person;1"},
            "name": name,
        }
        existing_twin = self.twin(person_dtid)
        if existing_twin is not None:
            self.twins.remove(existing_twin)
        self.twins.append(twin_props)
        edge: dict = {
            "$relationshipId": f"{trip_dtid}__hasCrew__{person_dtid}",
            "$sourceId": trip_dtid,
            "$relationshipName": "hasCrew",
            "$targetId": person_dtid,
            "role": role,
            "index": index,
        }
        if note is not None:
            edge["note"] = note
        if display_name:
            edge["displayName"] = display_name
        existing = self.rel(edge["$relationshipId"])
        if existing is not None:
            self.rels.remove(existing)
        self.rels.append(edge)
        self.rels.remove(old)
        return True

    def delete_user_twin(self, user_dtid: str) -> bool:
        """Mirror the real ``delete_user_twin`` (#196 phase C): refuse (False)
        when the twin still has incident edges — exactly like the server, and
        like ``delete_twin`` above — so the tests catch an ordering bug."""
        t = self.twin(user_dtid)
        if t is None:
            return False
        touching = [r for r in self.rels
                    if r.get("$sourceId") == user_dtid or r.get("$targetId") == user_dtid]
        if touching:
            return False
        self.twins.remove(t)
        return True
    def create_user_twin(self, user_dtid: str, profile: dict) -> bool:
        """Mirror the real ``create_user_twin`` (claim flow, #6): a User twin
        without a verified email is refused (False) — the server invents no
        identity. PUT by ``$dtId`` — idempotent."""
        email = ((profile or {}).get("email") or "").strip()
        if not email:
            return False
        name = ((profile or {}).get("name") or "").strip() or email.split("@")[0]
        if self.twin(user_dtid) is None:
            self.twins.append({
                "$dtId": user_dtid,
                "$metadata": {"$model": "dtmi:kiseki:travel:User;1"},
                "name": name,
                "email": email,
                "displayName": name,
                "authProvider": "external",
            })
        return True

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
                        "discoverable": bool(t.get("discoverable", False)),
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
        """Delete a twin — mirrors the real server, which does NOT cascade:
        deleting a vertex that still has relationships fails (Postgres
        "Cannot delete a vertex that has edge(s)"), so callers must remove the
        twin's edges first (issue #89 live smoke found delete_block relying on
        a cascade the server refuses)."""
        self._note(trip_dtid, x_user_id)
        t = self.twin(dtid)
        if t is None:
            raise FakeGraphError(f"no twin {dtid}")
        touching = [r for r in self.rels
                    if r.get("$sourceId") == dtid or r.get("$targetId") == dtid]
        if touching:
            raise FakeGraphError(
                f"cannot delete twin {dtid}: still has {len(touching)} "
                f"relationship(s) — delete the edges first (server refuses non-cascade deletes)"
            )
        self.twins.remove(t)

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
        existing = self._rel_under(rel_id, trip_dtid)
        _apply_patch_ops(existing, patch_ops)

    def delete_relationship(self, trip_dtid: str, rel_id: str,
                            x_user_id: str | None = None) -> None:
        """Delete by (source, id) — mirrors the real server, which scopes a
        relationship under its SOURCE twin. ``trip_dtid`` here is the edge's
        ``$sourceId`` (the trip for hasCrew/root atLocation; the section/day/
        block for their outgoing edges); passing the trip for an edge that is
        sourced elsewhere must fail exactly like the live graph 404s (issue
        #89: the old wrapper passed the trip for every edge and every such
        delete died live while tests stayed green)."""
        self._note(trip_dtid, x_user_id)
        existing = self._rel_under(rel_id, trip_dtid)
        self.rels.remove(existing)

    def _rel_under(self, rel_id: str, source_dtid: str) -> dict:
        existing = self.rel(rel_id)
        if existing is None:
            raise FakeGraphError(f"no relationship {rel_id}")
        if existing.get("$sourceId") != source_dtid:
            raise FakeGraphError(
                f"relationship {rel_id} is not sourced at {source_dtid} "
                f"(source is {existing.get('$sourceId')})"
            )
        return existing

    # ------------------------------------------------------------ follows (#196)
    def follow_user(self, actor_dtid: str, target_dtid: str) -> bool:
        """Mirror the real ``follow_user``: upsert the ADT-shaped follows edge.
        Idempotent; self-follow and unknown targets are refused (False)."""
        if actor_dtid == target_dtid:
            return False
        if self.twin(target_dtid) is None:
            return False
        rel_id = f"{actor_dtid}__follows__{target_dtid}"
        existing = self.rel(rel_id)
        if existing is not None:
            self.rels.remove(existing)
        self.rels.append({
            "$relationshipId": rel_id,
            "$sourceId": actor_dtid,
            "$relationshipName": "follows",
            "$targetId": target_dtid,
        })
        return True

    def unfollow_user(self, actor_dtid: str, target_dtid: str) -> bool:
        """Mirror the real ``unfollow_user``: idempotent delete (missing edge
        is a no-op, not an error)."""
        rel_id = f"{actor_dtid}__follows__{target_dtid}"
        existing = self.rel(rel_id)
        if existing is not None:
            self.rels.remove(existing)
        return True

    def followers_of(self, user_dtid: str) -> list[str]:
        return [r["$sourceId"] for r in self.rels
                if r.get("$relationshipName") == "follows"
                and r.get("$targetId") == user_dtid]

    def following_of(self, user_dtid: str) -> list[str]:
        return [r["$targetId"] for r in self.rels
                if r.get("$relationshipName") == "follows"
                and r.get("$sourceId") == user_dtid]

    # ------------------------------------------------------- profiles (#196 phase B)
    def get_user_profile(self, user_dtid: str) -> dict | None:
        """Mirror the real ``get_user_profile``: the flat User twin dict, or
        None when absent (or not a User twin — placeholders are not profiles)."""
        import copy as _copy

        t = self.twin(user_dtid)
        if t is None:
            return None
        if (t.get("$metadata") or {}).get("$model") != "dtmi:kiseki:travel:User;1":
            return None
        return _copy.deepcopy(t)

    def get_user_profiles(self, user_dtids: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for sub in user_dtids or []:
            if not isinstance(sub, str) or sub in out:
                continue
            node = self.get_user_profile(sub)
            if node is not None:
                out[sub] = node
        return out

    def set_user_public_name(self, user_dtid: str, public_name: bool) -> dict | None:
        """Mirror the real ``set_user_public_name``: preserve every prop, flip
        only ``publicName``. None when the twin does not exist."""
        import copy as _copy

        t = self.twin(user_dtid)
        if t is None or (t.get("$metadata") or {}).get("$model") != "dtmi:kiseki:travel:User;1":
            return None
        t["publicName"] = bool(public_name)
        return _copy.deepcopy(t)
