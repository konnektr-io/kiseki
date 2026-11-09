"""Server-side trip topology: the route chain and the per-day surface (#457).

Pure functions over a trip document — no network, no store, no cache
dependency: same input, same output. This is a 1:1 port of
``frontend/src/lib/route-surface.ts`` and ``day-surface.ts`` (branch base
``0daa4eb``); the frontend now renders what this module derives instead of
owning the rules (see ``docs/spec.md`` §8).

Why it lives here: the chain is the product's most-repaired logic and every
non-browser consumer (the content agent, the booklet, the PDF) had to
re-implement or reverse-engineer it, because it only existed as TypeScript in
the SPA. The app layer is the trust boundary (§8), so the trust boundary is
where the trip's shape is derived.

THE CONTRACT — the rules, preserved bug-for-bug (a semantic change is a
separate issue, deliberately):

1. **Which places are chain stops** (``place_role``). A stop is a place the
   trip is ANCHORED at: a section ``locationRefs`` base, or a movement endpoint
   it is still at the next day. A place that is only an endpoint of a single
   day's movement is a DAY TRIP, not a re-base (#435); a place CIRCLED by a
   longer stay is a day trip however else it is evidenced (#435); a TRANSIT
   NODE — one movement in, a DIFFERENT one out — is a stop even with no
   overnight (#361/#435 follow-up).
2. **Attribution** (``days_located`` / ``place_days``). A place's day is the
   earliest day any block title, ``from``/``location``/``to`` field or day title
   names it, after alias/IATA normalisation. ``via``/``route`` prose describes
   the ROAD, never a visit (#91). A day title that names a place ONLY through an
   alias is shorthand (``CUZ → LIM``) and counts only when the day has no
   located content of its own (#435). A section ``locationRefs`` range is
   clamped so a chapter cannot outlive its stay.
3. **The chain is a VISIT sequence** (``journey_visits``): one entry per STAY,
   so a base the trip returns to appears once per stay (#433). Stays are the
   contiguous runs of attributed days, ordered by first day with the registry
   position as tie-break — and places that share a first day are ordered by the
   movement chain of the days they share (``day_travel_order``, #454), never by
   where the author happened to drop them in the registry array.
4. **Leg matching** (``leg_block``): exact registry in the leg's own direction,
   then flight/ferry gateway proximity (``GATEWAY_MATCH_KM``), then the same two
   passes reversed (#433 — a reversed block must never beat a leg's own
   direction). A leg with no block at all is a GAP: provisional, never
   road-routed.
5. **Leg stage** (``leg_stage``): the block's own ``status``, else the trip
   stage for a block that speaks, else ``provisional`` for a gap (#91).
6. **Registry scaffold** (``is_registry_scaffold``): when no place has any
   re-base evidence, the registry IS the author's statement of intent, so every
   located place chains in marker order (#91).

Deliberately unchanged non-goals: geometry (``/api/maps/route``), and any rule
that the follow-up issue wants to *change* — parity first.
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterable

#: Gateway proximity for flight/ferry matching (#361 slice 4): a chain leg A→B
#: matches a flight/ferry block whose endpoints sit within this many kilometres
#: of A and B. Airports sit outside the cities they serve, so exact-registry
#: matching never fires for them.
GATEWAY_MATCH_KM = 50.0

#: The ``modes`` sentinel that marks a chain GAP — a pair with no transport
#: block of its own (#433). A gap draws the great-circle arc, not a road.
LEG_GAP_MODE = "gap"

PROVISIONAL_STAGES = frozenset({"idea", "options", "shortlist"})

LETTER_KINDS = frozenset({"activity", "lodging", "meal"})
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

#: Airport IATA codes seen in trip titles/descriptions (``lib/transport.ts``).
AIRPORT_CODES = re.compile(r"\b(BRU|FRA|YYC|LHR|SCL|CUZ|LIM|CTS|HND|NRT|KIX|AMS|CDG|MAD)\b")
_FLIGHT_WORDS = re.compile(r"(flight|depart|arriv)", re.IGNORECASE)

#: A character that is a letter or a digit — JS ``[^\p{L}\p{N}]`` boundary.
_ALNUM = r"[^\W_]"


_PATTERNS: dict[str, re.Pattern[str]] = {}


def _boundary_re(term: str) -> re.Pattern[str]:
    """Word-bounded, case-insensitive matcher for one place name/alias."""
    pat = _PATTERNS.get(term)
    if pat is None:
        pat = re.compile(rf"(?<!{_ALNUM})({re.escape(term)})(?!{_ALNUM})", re.IGNORECASE)
        _PATTERNS[term] = pat
    return pat


def _alnum_boundary(term: str) -> re.Pattern[str]:
    """Exact-name test used by ``day_title_locates`` (no alias fallback)."""
    return re.compile(rf"(?<!{_ALNUM}){re.escape(term)}(?!{_ALNUM})", re.IGNORECASE)


def stage_to_leg_stage(stage: str | None) -> str:
    """The trip's stage as a leg state — the fallback for a block without one."""
    if stage in PROVISIONAL_STAGES:
        return "provisional"
    return "planned" if stage == "planned" else "booked"


def expand_section_days(days: Iterable[int] | None) -> list[int]:
    """A section's day list: two values are an inclusive RANGE, more are literal.

    This is the section storage convention (``lib/sections.ts``), not
    ``day_range_label``'s literal reading.
    """
    if not days:
        return []
    out = list(days)
    if len(out) == 2 and out[1] >= out[0]:
        return list(range(out[0], out[1] + 1))
    return out


def classify_transport_mode(block: dict) -> str | None:
    """The ONE transport classifier (#88), mirrored from ``lib/transport.ts``.

    1. an explicit ``mode`` always wins;
    2. drive evidence (distance/duration/route/via) → drive;
    3. flight evidence (bookingCode / airport codes / flight words) → flight;
    4. otherwise ``None`` — the caller keeps its road default.
    """
    explicit = block.get("mode")
    if explicit:
        return explicit
    if block.get("distance") or block.get("duration") or block.get("route") or block.get("via"):
        return "drive"
    text = f"{block.get('title') or ''} {block.get('description') or ''}"
    is_flight = (
        bool(block.get("bookingCode"))
        or bool(AIRPORT_CODES.search(text))
        or bool(_FLIGHT_WORDS.search(block.get("title") or ""))
    )
    return "flight" if is_flight else None


def haversine_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    rad = math.pi / 180.0
    d_lat = (b_lat - a_lat) * rad
    d_lng = (b_lng - a_lng) * rad
    s = math.sin(d_lat / 2) ** 2 + math.cos(a_lat * rad) * math.cos(b_lat * rad) * math.sin(d_lng / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(min(1.0, s)))


def gateway_match(from_loc: dict, to_loc: dict, e_from: dict, e_to: dict) -> bool:
    """Do a block's resolved endpoints sit at the leg's ends, gateway-close?"""

    def within(a: dict, b: dict) -> bool:
        if a.get("lat") is None or a.get("lng") is None or b.get("lat") is None or b.get("lng") is None:
            return False
        return haversine_km(a["lat"], a["lng"], b["lat"], b["lng"]) <= GATEWAY_MATCH_KM

    return (within(from_loc, e_from) and within(to_loc, e_to)) or (
        within(from_loc, e_to) and within(to_loc, e_from)
    )


class Deriver:
    """One trip's derivation, with the memoisation the TS surface did per call.

    Place identity is the registry INDEX — the JS original compares object
    identity, and ``trip.locations`` order is the registry (marker) order, so the
    index is the same key without object equality games.
    """

    def __init__(self, trip: dict) -> None:
        self.trip = trip or {}
        self.locations: list[dict] = list(self.trip.get("locations") or [])
        self.days: list[dict] = list(self.trip.get("days") or [])
        self.sections: list[dict] = list(self.trip.get("sections") or [])
        self._find: dict[str, int | None] = {}
        self._text: dict[str, tuple[int, ...]] = {}
        self._block_places: dict[int, tuple[int, ...]] = {}
        self._endpoints: dict[int, tuple[int | None, int | None]] = {}
        self._days_located: dict[int, list[int]] = {}
        self._place_days: dict[int, list[int]] = {}
        self._role: dict[int, str] = {}
        self._anchors: dict[int, bool] = {}
        self._day_places: list[set[int]] | None = None
        self._all_blocks: list[dict] | None = None

    # ---------------------------------------------------------------- registry
    def find(self, name: str | None) -> int | None:
        """Registry index for a name/alias (case-insensitive), else ``None``."""
        if name is None:
            return None
        key = name.strip().lower()
        if key in self._find:
            return self._find[key]
        found: int | None = None
        for idx, loc in enumerate(self.locations):
            if (loc.get("name") or "").lower() == key or any(
                (a or "").lower() == key for a in (loc.get("alias") or [])
            ):
                found = idx
                break
        self._find[key] = found
        return found

    def loc(self, idx: int) -> dict:
        return self.locations[idx]

    def located_indices(self) -> list[int]:
        return [
            i
            for i, l in enumerate(self.locations)
            if l.get("lat") is not None and l.get("lng") is not None
        ]

    def all_blocks(self) -> list[dict]:
        """Day blocks then section-level (unscheduled) blocks — the whole pool."""
        if self._all_blocks is None:
            out: list[dict] = []
            for day in self.days:
                out.extend(day.get("blocks") or [])
            for section in self.sections:
                out.extend(section.get("blocks") or [])
            self._all_blocks = out
        return self._all_blocks

    def transports(self) -> list[dict]:
        return [b for b in self.all_blocks() if b.get("kind") == "transport"]

    # ------------------------------------------------------------------- text
    def locations_in_text(self, text: str | None) -> list[int]:
        """Every trip location named in free text, first appearance first.

        Word-bounded, and a hit nested inside a longer hit is dropped:
        "Sapporo Kokusai" is its own location and must not also resolve to
        New Chitose through its "Sapporo" alias.
        """
        if not text:
            return []
        cached = self._text.get(text)
        if cached is not None:
            return list(cached)
        hits: list[tuple[int, int, int]] = []  # (place idx, start, length)
        for idx, loc in enumerate(self.locations):
            terms = [loc.get("name") or ""] + list(loc.get("alias") or [])
            for term in terms:
                if not term or not term.strip():
                    continue
                for m in _boundary_re(term).finditer(text):
                    hits.append((idx, m.start(1), len(term)))
        kept = [
            h
            for j, h in enumerate(hits)
            if not any(
                k != j
                and o[1] <= h[1]
                and o[1] + o[2] >= h[1] + h[2]
                and o[2] > h[2]
                for k, o in enumerate(hits)
            )
        ]
        kept.sort(key=lambda h: h[1])
        out: list[int] = []
        for h in kept:
            if h[0] not in out:
                out.append(h[0])
        self._text[text] = tuple(out)
        return list(out)

    def block_places(self, block: dict) -> list[int]:
        """Every place a block touches — explicit fields first, then its title.

        PROSE SCOPE (#91): ``via``/``route`` never attribute a day; only
        ``block_endpoints`` reads them (for leg matching).
        """
        key = id(block)
        cached = self._block_places.get(key)
        if cached is not None:
            return list(cached)
        out: list[int] = []

        def push(idx: int | None) -> None:
            if idx is not None and idx not in out:
                out.append(idx)

        push(self.find(block.get("from")))
        push(self.find(block.get("location")))
        push(self.find(block.get("to")))
        for idx in self.locations_in_text(block.get("title")):
            push(idx)
        self._block_places[key] = tuple(out)
        return list(out)

    def block_endpoints(self, block: dict) -> tuple[int | None, int | None]:
        """A transport block's two ends, in order, filling gaps from prose."""
        key = id(block)
        cached = self._endpoints.get(key)
        if cached is not None:
            return cached
        named = self.locations_in_text(
            " · ".join([t for t in (block.get("title"), block.get("route"), block.get("via")) if t])
        )
        from_idx = self.find(block.get("from"))
        if from_idx is None and named:
            from_idx = named[0]
        to_idx = self.find(block.get("to"))
        if to_idx is None and len(named) > 1:
            to_idx = named[-1]
        if to_idx is not None and to_idx == from_idx:
            to_idx = None
        self._endpoints[key] = (from_idx, to_idx)
        return from_idx, to_idx

    # ------------------------------------------------------------------- legs
    def leg_block(self, from_idx: int, to_idx: int) -> dict | None:
        """The transport block describing the leg between two places (#433).

        Match order, strongest first: exact-registry as authored; flight/ferry
        gateway as authored; exact-registry reversed; gateway reversed.
        """
        if from_idx == to_idx:
            return None
        transports = self.transports()
        from_loc, to_loc = self.loc(from_idx), self.loc(to_idx)

        def exact(block: dict, same_direction: bool) -> bool:
            e_from, e_to = self.block_endpoints(block)
            return (
                e_from == from_idx and e_to == to_idx
                if same_direction
                else e_from == to_idx and e_to == from_idx
            )

        def gateway(block: dict, same_direction: bool) -> bool:
            if block.get("mode") not in ("flight", "ferry"):
                return False
            e_from_idx, e_to_idx = self.block_endpoints(block)
            if e_from_idx is None or e_to_idx is None:
                return False
            e_from, e_to = self.loc(e_from_idx), self.loc(e_to_idx)
            if same_direction:
                return gateway_match(from_loc, to_loc, e_from, e_to)
            return gateway_match(from_loc, to_loc, e_to, e_from)

        for predicate in (
            lambda b: exact(b, True),
            lambda b: gateway(b, True),
            lambda b: exact(b, False),
            lambda b: gateway(b, False),
        ):
            for block in transports:
                if predicate(block):
                    return block
        return None

    def leg_stage(self, from_idx: int, to_idx: int) -> tuple[str, dict | None]:
        """A leg's state: the block's own status, else the trip stage, else gap."""
        block = self.leg_block(from_idx, to_idx)
        if block is None:
            return "provisional", None
        status = block.get("status")
        if status in ("booked", "done"):
            return "booked", block
        if status == "planned":
            return "planned", block
        return stage_to_leg_stage(self.trip.get("stage")), block

    def leg_modes(self, places: Iterable[str]) -> list[str | None]:
        """Declared mode per consecutive pair — ``"gap"`` when no block exists."""
        idxs = [self.find(p) for p in places]
        out: list[str | None] = []
        for a, b in zip(idxs, idxs[1:]):
            if a is None or b is None:
                out.append(None)
                continue
            block = self.leg_block(a, b)
            out.append(LEG_GAP_MODE if block is None else classify_transport_mode(block))
        return out

    # ------------------------------------------------------------- attribution
    def day_places(self) -> list[set[int]]:
        """Per day, the places its blocks name — one pass, not one scan per place."""
        if self._day_places is None:
            self._day_places = [
                {p for b in (day.get("blocks") or []) for p in self.block_places(b)}
                for day in self.days
            ]
        return self._day_places

    def days_located(self, idx: int) -> list[int]:
        """Days a place is LOCATED on, from explicit content only."""
        cached = self._days_located.get(idx)
        if cached is not None:
            return list(cached)
        days: set[int] = set()
        attributed = self.day_places()
        for day_idx, day in enumerate(self.days):
            if idx in attributed[day_idx]:
                days.add(day_idx)
            elif self.day_title_locates(day.get("title"), idx, day.get("blocks") or []):
                days.add(day_idx)
        out = sorted(days)
        self._days_located[idx] = out
        return list(out)

    def day_title_locates(self, title: str | None, idx: int, blocks: list[dict]) -> bool:
        """Does a day TITLE put the trip at this place? (alias hit = shorthand)"""
        if idx not in self.locations_in_text(title):
            return False
        if not any(self.block_places(b) for b in blocks):
            return True
        name = self.loc(idx).get("name") or ""
        return bool(_alnum_boundary(name).search(title or ""))

    def place_days(self, idx: int) -> list[int]:
        """Days the trip happens AT a place — attributed days plus clamped refs."""
        cached = self._place_days.get(idx)
        if cached is not None:
            return list(cached)
        days: set[int] = set(self.days_located(idx))
        located = sorted(days)
        first = located[0] if located else None
        last = located[-1] if located else None
        for section in self.sections:
            refs = [self.find(r) for r in (section.get("locationRefs") or [])]
            if idx not in refs:
                continue
            for day_idx in expand_section_days(section.get("days")):
                if day_idx < 0 or day_idx >= len(self.days):
                    continue
                blocks = self.days[day_idx].get("blocks") or []
                elsewhere = any(
                    other != idx
                    for b in blocks
                    for other in self.block_places(b)
                )
                if elsewhere:
                    continue
                if first is not None and last is not None and (day_idx < first or day_idx > last):
                    continue
                days.add(day_idx)
        out = sorted(days)
        self._place_days[idx] = out
        return list(out)

    # ------------------------------------------------------------------ roles
    def is_transport_endpoint(self, idx: int) -> bool:
        """Is this place an endpoint of an AUTHORED movement (from/to)?"""
        for block in self.transports():
            for name in (block.get("from"), block.get("to")):
                if name and self.find(name) == idx:
                    return True
        return False

    def is_section_base(self, idx: int) -> bool:
        return any(
            self.find(r) == idx
            for section in self.sections
            for r in (section.get("locationRefs") or [])
        )

    def anchors_stay(self, idx: int) -> bool:
        """Does the trip STAY here? A chapter base, or an endpoint kept overnight."""
        cached = self._anchors.get(idx)
        if cached is None:
            cached = self.is_section_base(idx) or (
                self.is_transport_endpoint(idx) and len(self.place_days(idx)) > 1
            )
            self._anchors[idx] = cached
        return cached

    def is_circled_stay(self, idx: int) -> bool:
        """Is this stay CIRCLED by a longer one — a day trip (#435)?"""
        days = self.place_days(idx)
        if not days:
            return False
        if self.is_transport_endpoint(idx) and len(days) > 1:
            return False
        first, last = days[0], days[-1]
        for other in self.located_indices():
            if other == idx or not self.anchors_stay(other):
                continue
            other_days = self.place_days(other)
            if other_days and other_days[0] < first and other_days[-1] > last:
                return True
        return False

    def is_transit_node(self, idx: int) -> bool:
        """One movement brings the trip in, a DIFFERENT one takes it out (#435)."""
        counterparts: set[str] = set()
        for block in self.transports():
            if not block.get("from") or not block.get("to"):
                continue
            from_idx = self.find(block.get("from"))
            to_idx = self.find(block.get("to"))
            if from_idx is None or to_idx is None:
                continue
            if from_idx == idx:
                counterparts.add(self.loc(to_idx).get("name") or "")
            if to_idx == idx:
                counterparts.add(self.loc(from_idx).get("name") or "")
        return len(counterparts) > 1

    def place_role(self, idx: int) -> str:
        """``"stop"`` (re-base / transit node) or ``"excursion"`` (#91, #435)."""
        cached = self._role.get(idx)
        if cached is not None:
            return cached
        if self.is_transit_node(idx):
            role = "stop"
        elif not self.anchors_stay(idx):
            role = "excursion"
        elif self.is_circled_stay(idx):
            role = "excursion"
        else:
            role = "stop"
        self._role[idx] = role
        return role

    def is_registry_scaffold(self) -> bool:
        """No place has re-base evidence yet → the registry IS the intent (#91)."""
        return all(self.place_role(i) == "excursion" for i in self.located_indices())

    def chain_stops(self) -> list[int]:
        located = self.located_indices()
        if self.is_registry_scaffold():
            return located
        return [i for i in located if self.place_role(i) == "stop"]

    # ------------------------------------------------------------------ chain
    def journey_visits(self) -> list[dict]:
        """One entry per STAY, earliest first (#433, #454)."""
        stops = self.chain_stops()
        index_of = {idx: pos for pos, idx in enumerate(stops)}
        placed: list[dict] = []
        for place in stops:
            for run in _contiguous_runs(self.place_days(place)):
                placed.append({"place": place, "days": run, "index": index_of[place]})
        placed.sort(key=lambda p: (p["days"][0], p["index"]))
        self._order_shared_first_day(placed)

        visits: list[dict] = []
        for entry in placed:
            last = visits[-1] if visits else None
            if last is not None and last["place"] == entry["place"]:
                last["days"] = [*last["days"], *entry["days"]]
            else:
                visits.append({"place": entry["place"], "days": list(entry["days"])})
        # Ideas with no attributed day: registry order, after every real stay.
        for place in stops:
            if not self.place_days(place):
                visits.append({"place": place, "days": []})
        return visits

    def day_travel_order(self, days: Iterable[int]) -> dict[int, int]:
        """Topological walk over those days' transport ``from``/``to`` edges (#454)."""
        nodes: list[int] = []
        # Insertion-ordered adjacency (a JS ``Set``): Kahn's ready queue and the
        # cycle test both depend on first-authored-first, and a Python set of
        # ints iterates by value — which silently reordered two stays in the
        # Chile+Peru trip (#457 parity run).
        edges: dict[int, list[int]] = {}

        def touch(idx: int) -> None:
            if idx in edges:
                return
            nodes.append(idx)
            edges[idx] = []

        def reaches(start: int, target: int) -> bool:
            seen = {start}
            stack = [start]
            while stack:
                node = stack.pop()
                if node == target:
                    return True
                for nxt in edges.get(node, ()):  # type: ignore[union-attr]
                    if nxt not in seen:
                        seen.add(nxt)
                        stack.append(nxt)
            return False

        for day_idx in days:
            day = self.days[day_idx] if 0 <= day_idx < len(self.days) else None
            for block in (day or {}).get("blocks") or []:
                if block.get("kind") != "transport":
                    continue
                from_idx, to_idx = self.block_endpoints(block)
                if from_idx is None or to_idx is None:
                    continue
                touch(from_idx)
                touch(to_idx)
                if reaches(to_idx, from_idx):
                    continue
                if to_idx not in edges[from_idx]:
                    edges[from_idx].append(to_idx)

        indegree = {n: 0 for n in nodes}
        for tos in edges.values():
            for to in tos:
                indegree[to] = indegree.get(to, 0) + 1
        ordered: list[int] = []
        ready = [n for n in nodes if indegree.get(n, 0) == 0]
        while ready:
            nxt = ready.pop(0)
            ordered.append(nxt)
            for to in edges.get(nxt, ()):  # type: ignore[union-attr]
                left = indegree.get(to, 0) - 1
                indegree[to] = left
                if left == 0:
                    ready.append(to)
        for n in nodes:
            if n not in ordered:
                ordered.append(n)
        return {n: i for i, n in enumerate(ordered)}

    def _order_shared_first_day(self, placed: list[dict]) -> None:
        """Order places sharing a first day by the movements of the days they share."""
        start = 0
        while start < len(placed):
            end = start + 1
            while end < len(placed) and placed[end]["days"][0] == placed[start]["days"][0]:
                end += 1
            shared: list[int] = list(placed[start]["days"])
            for entry in placed[start + 1 : end]:
                shared = [d for d in shared if d in entry["days"]]
            rank = self.day_travel_order(shared)
            slots = [i for i in range(start, end) if placed[i]["place"] in rank]
            if len(slots) > 1:
                ranked = sorted(
                    ((placed[i], i, rank[placed[i]["place"]]) for i in slots),
                    key=lambda t: (t[2], t[1]),
                )
                for k, (entry, _at, _rank) in enumerate(ranked):
                    placed[slots[k]] = entry
            start = end

    def returns_to_start(self) -> bool:
        placed = [v for v in self.journey_visits() if v["days"]]
        if len(placed) < 3:
            return False
        return placed[0]["place"] == placed[-1]["place"]

    def trip_excursions(self) -> list[int]:
        return [i for i in self.located_indices() if self.place_role(i) == "excursion"]

    def trip_journey(self) -> dict:
        """The whole journey, keyed by registry index (internal form)."""
        visits = self.journey_visits()
        chain = [v["place"] for v in visits]
        legs = []
        for from_idx, to_idx in zip(chain, chain[1:]):
            stage, block = self.leg_stage(from_idx, to_idx)
            mode = None if block is None else classify_transport_mode(block)
            legs.append(
                {
                    "from": from_idx,
                    "to": to_idx,
                    "stage": stage,
                    "mode": mode,
                    "gap": block is None,
                    "blockId": (block or {}).get("id"),
                }
            )
        return {
            "stops": list(self.located_indices()),
            "chain": chain,
            "visits": visits,
            "legs": legs,
            "loop": self.returns_to_start(),
            "excursions": self.trip_excursions(),
        }

    def rail_handle(self, idx: int) -> dict | None:
        """Where a scan-level place selection lands in the itinerary rail."""
        refs: list[str] = []
        for section in self.sections:
            for ref in section.get("locationRefs") or []:
                if self.find(ref) == idx:
                    refs.append(ref)
        if refs:
            return {"kind": "pill", "refs": refs}
        days = self.place_days(idx)
        if not days:
            return None
        first = days[0]
        rendered = (
            any(first in expand_section_days(s.get("days")) for s in self.sections)
            if self.sections
            else bool(self.days)
        )
        return {"kind": "day", "dayIdx": first} if rendered else None

    # -------------------------------------------------------------- day level
    def day_surface(self, day_idx: int) -> dict | None:
        """One day's world, derived from that day's blocks alone (#90)."""
        if day_idx < 0 or day_idx >= len(self.days):
            return None
        day = self.days[day_idx]
        ordered = sorted(day.get("blocks") or [], key=lambda b: b.get("order") or 0)
        markers: list[dict] = []
        legs: list[dict] = []
        endpoints: list[int] = []
        tracks: list[dict] = []
        chip_by_place: dict[int, dict] = {}
        chip_count = 0

        def pin_at(idx: int) -> None:
            if not any(m.get("role") == "place" and m.get("place") == idx for m in markers):
                markers.append({"role": "place", "place": idx})

        for block in ordered:
            if block.get("track") and block.get("id"):
                tracks.append({"blockId": block["id"], "url": block["track"]})
            if block.get("kind") == "transport":
                from_idx, to_idx = self.block_endpoints(block)
                resolved = [
                    i
                    for i in (from_idx, to_idx)
                    if i is not None and self.loc(i).get("lat") is not None and self.loc(i).get("lng") is not None
                ]
                if resolved:
                    both = (
                        from_idx is not None
                        and to_idx is not None
                        and self.loc(from_idx).get("lat") is not None
                        and self.loc(from_idx).get("lng") is not None
                        and self.loc(to_idx).get("lat") is not None
                        and self.loc(to_idx).get("lng") is not None
                    )
                    if both:
                        legs.append(
                            {
                                "from": from_idx,
                                "to": to_idx,
                                "blockId": block.get("id"),
                                "stage": self.block_leg_stage(block),
                                "mode": classify_transport_mode(block),
                            }
                        )
                    for idx in resolved:
                        pin_at(idx)
                        if idx not in endpoints:
                            endpoints.append(idx)
                continue

            if block.get("kind") not in LETTER_KINDS or not block.get("id"):
                continue
            anchor = None
            if block.get("location"):
                anchor = self.find(block.get("location"))
            if anchor is None and block.get("from"):
                anchor = self.find(block.get("from"))
            if anchor is None and block.get("to"):
                anchor = self.find(block.get("to"))
            if anchor is None:
                anchor = self.match_title_place(block.get("title"))
            if anchor is None or self.loc(anchor).get("lat") is None or self.loc(anchor).get("lng") is None:
                continue

            existing = chip_by_place.get(anchor)
            if existing is not None:
                existing["blockIds"].append(block["id"])
                continue
            chip_count += 1
            marker = {
                "role": "activity",
                "place": anchor,
                "letter": activity_letter(chip_count),
                "blockIds": [block["id"]],
            }
            chip_by_place[anchor] = marker
            markers.append(marker)

        return {"markers": markers, "legs": legs, "endpoints": endpoints, "tracks": tracks}

    def block_leg_stage(self, block: dict) -> str:
        status = block.get("status")
        if status in ("booked", "done"):
            return "booked"
        if status == "planned":
            return "planned"
        return stage_to_leg_stage(self.trip.get("stage"))

    def match_title_place(self, title: str | None) -> int | None:
        """A place the block title names by CONTAINS match, longest name first."""
        if not title:
            return None
        text = title.lower()
        hits = []
        for idx, loc in enumerate(self.locations):
            name = (loc.get("name") or "").lower()
            if name and name in text:
                hits.append(idx)
                continue
            if any(len(a or "") >= 3 and (a or "").lower() in text for a in (loc.get("alias") or [])):
                hits.append(idx)
        if not hits:
            return None
        hits.sort(key=lambda i: -len(self.loc(i).get("name") or ""))
        return hits[0]


def _contiguous_runs(days: list[int]) -> list[list[int]]:
    runs: list[list[int]] = []
    for day in days:
        if runs and day == runs[-1][-1] + 1:
            runs[-1].append(day)
        else:
            runs.append([day])
    return runs


def activity_letter(n: int) -> str:
    """The n-th (1-based) activity letter; past Z the cycle repeats ("A2")."""
    if n < 1:
        return "A"
    i = n - 1
    cycle = i // 26
    return _LETTERS[i % 26] + (str(cycle + 1) if cycle > 0 else "")


# --------------------------------------------------------------------- wire
def _names(deriver: Deriver, indices: Iterable[int]) -> list[str]:
    return [deriver.loc(i).get("name") or "" for i in indices]


def journey_payload(trip: dict) -> dict:
    """The ``journey`` member of a trip read — the chain, keyed by place NAME.

    Names, not indices: the whole point (#457) is that a writer or an agent can
    read the shape of the trip off the payload, and "Huaraz → Lima → Cusco" is
    the shape. The SPA resolves a name against ``trip.locations`` the same way
    every other surface already does (``findLocation``).

    Deliberately COMPACT: the raw ``Journey`` objects (every ``TripLocation``
    four times, every leg's whole ``Block``) measured +16…109% of the trip
    document; this projection measured 3–14%. Nothing here is derivable from a
    redacted field, so the payload is identical for crew and strangers.
    """
    return _journey_from(Deriver(trip))


def _journey_from(d: Deriver) -> dict:
    journey = d.trip_journey()
    rail = {}
    for idx in d.located_indices():
        handle = d.rail_handle(idx)
        if handle is not None:
            rail[d.loc(idx).get("name") or ""] = handle
    return {
        "stops": _names(d, journey["stops"]),
        "chain": _names(d, journey["chain"]),
        "visits": [
            {"place": d.loc(v["place"]).get("name") or "", "days": v["days"]} for v in journey["visits"]
        ],
        "legs": [
            {
                "from": d.loc(leg["from"]).get("name") or "",
                "to": d.loc(leg["to"]).get("name") or "",
                "stage": leg["stage"],
                "mode": leg["mode"],
                "gap": leg["gap"],
                "blockId": leg["blockId"],
            }
            for leg in journey["legs"]
        ],
        "loop": journey["loop"],
        "excursions": _names(d, journey["excursions"]),
        "rail": rail,
    }


def day_surface_payload(trip: dict, day_idx: int, deriver: Deriver | None = None) -> dict | None:
    """One day's surface, keyed by place NAME — ``None`` past the last day."""
    d = deriver or Deriver(trip)
    surface = d.day_surface(day_idx)
    if surface is None:
        return None
    return {
        "markers": [
            (
                {"role": "place", "place": d.loc(m["place"]).get("name") or ""}
                if m.get("role") == "place"
                else {
                    "role": "activity",
                    "place": d.loc(m["place"]).get("name") or "",
                    "letter": m["letter"],
                    "blockIds": m["blockIds"],
                }
            )
            for m in surface["markers"]
        ],
        "legs": [
            {
                "from": d.loc(leg["from"]).get("name") or "",
                "to": d.loc(leg["to"]).get("name") or "",
                "blockId": leg["blockId"],
                "stage": leg["stage"],
                "mode": leg["mode"],
            }
            for leg in surface["legs"]
        ],
        "endpoints": _names(d, surface["endpoints"]),
        "tracks": surface["tracks"],
    }


def day_surfaces_payload(trip: dict, deriver: Deriver | None = None) -> list[dict | None]:
    """Every day's surface from ONE derivation (the trip read attaches these)."""
    d = deriver or Deriver(trip)
    return [day_surface_payload(trip, i, d) for i in range(len(d.days))]


def attach(trip: dict) -> dict:
    """Add ``journey`` and per-day ``surface`` to a serialized trip document.

    Mutates and returns ``data`` so the read path can stay one expression. The
    document must be the FULL one (pre-redaction): redaction strips booking
    blocks and costs, and a booking block naming a place attributes a day, so
    deriving from the redacted form would give strangers a different chain.

    ONE ``Deriver`` for both halves: the caches (block places, endpoints, days
    per place) are the whole cost of the derivation, and re-deriving them per
    day is what would blow the 20 ms budget on a 17-day trip.
    """
    data = trip
    d = Deriver(data)
    data["journey"] = _journey_from(d)
    for day, surface in zip(data.get("days") or [], day_surfaces_payload(data, d)):
        if surface is not None:
            day["surface"] = surface
    return data
