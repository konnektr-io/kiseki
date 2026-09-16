"""Leg segmentation shared by the GPX + FIT track parsers (issue #290).

A recorded day mixes ridden runs with lift rides on ONE polyline, so the day
card reads two distances (the rider's riding-only figure next to the trace
total) and the map cannot draw the shape of the day the way Slopes/Strava do.
Both parsers classify every consecutive point pair as a ridden (``ride``) or
lift (``lift``) pair — FIT from the producer's own labels (``split_mesgs``
``ski_run_split``/``ski_lift_split``, laps, else cadence), GPX from the
recording cadence (>2 min between fixes climbs on a lift) — and this module
turns those pair flags into the legs the API serves and every surface draws:

``properties: { distanceM, ascentM, durationS, pointCount, rideDistanceM,
liftDistanceM, liftVerticalM, legs: [{ type, startIndex, endIndex,
distanceM, ascentM, durationS }] }``

``startIndex``/``endIndex`` are inclusive indices into the (decimated)
``geometry.coordinates`` — ``coordinates[start:end+1]`` is the leg's line, so
a surface draws each leg in its own style without re-deriving anything.
``distanceM``/``ascentM`` stay the FULL-fidelity totals (the card's numbers
never depend on how hard the line was decimated for the map).
"""

from __future__ import annotations

import datetime as _dt
import math
from dataclasses import dataclass
from typing import Optional

# A pair of fixes more than this far apart is a lift leg, not riding (#290):
# Slopes samples roughly every 2 s while riding and goes sparse on the lifts,
# so a lift surfaces as a long interval between fixes. Verified against the
# rider's own logged figures (dense segments reproduce them to ~0.3 km on the
# Slopes-original exports).
LIFT_GAP_S = 120.0

# Payload bound for the line the map draws: the response carries at most this
# many coordinates (endpoints always kept). Decimation runs PER LEG (each leg
# keeps its endpoints), so a leg boundary never dissolves into a neighbour —
# the dashed/solid split the client draws is the one the parser classified.
RESPONSE_MAX_POINTS = 2000


@dataclass
class LegPoint:
    """One track fix in the shared shape both parsers produce."""

    lat: float
    lng: float
    ele: Optional[float] = None
    time: Optional[str] = None  # ISO-8601 as carried (GPX "…Z", FIT "…Z")


@dataclass
class TrackLeg:
    """One classified run of pairs: the API's ``legs`` entry."""

    type: str  # "ride" | "lift"
    start_index: int  # inclusive, into the decimated coordinates
    end_index: int  # inclusive
    distance_m: float  # full-fidelity haversine sum over the leg's pairs
    ascent_m: float  # full-fidelity positive elevation sum
    duration_s: Optional[int] = None

    def to_properties(self) -> dict:
        props: dict = {
            "type": self.type,
            "startIndex": self.start_index,
            "endIndex": self.end_index,
            "distanceM": round(self.distance_m, 1),
            "ascentM": round(self.ascent_m, 1),
        }
        if self.duration_s is not None:
            props["durationS"] = self.duration_s
        return props


def haversine_m(
    a_lat: float, a_lng: float, b_lat: float, b_lng: float
) -> float:
    """Great-circle metres between two points (WGS84 mean radius)."""
    r = 6371000.0
    d_lat = math.radians(b_lat - a_lat)
    d_lng = math.radians(b_lng - a_lng)
    s = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(a_lat))
        * math.cos(math.radians(b_lat))
        * math.sin(d_lng / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(s)))


def parse_time(value: Optional[str]) -> Optional[_dt.datetime]:
    """An ISO-8601 fix time → aware datetime, else None (never raises)."""
    if not value or not isinstance(value, str):
        return None
    try:
        moment = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)
    return moment


def duration_between(
    start: Optional[str], end: Optional[str]
) -> Optional[int]:
    """Wall-clock seconds between two ISO fix times, else None."""
    a, b = parse_time(start), parse_time(end)
    if a is None or b is None:
        return None
    delta = (b - a).total_seconds()
    return int(delta) if delta >= 0 else None


def gap_seconds(a: LegPoint, b: LegPoint) -> Optional[float]:
    """Seconds between two consecutive fixes, else None when either is undated."""
    ta, tb = parse_time(a.time), parse_time(b.time)
    if ta is None or tb is None:
        return None
    return (tb - ta).total_seconds()


def cadence_is_ride(a: LegPoint, b: LegPoint) -> bool:
    """The #290 GPX fallback rule: a pair >2 min apart is a lift leg.

    Undated pairs cannot be classified by cadence — they stay ``ride`` (the
    pre-#290 behaviour: one unbroken ridden line), never a guessed lift.
    """
    gap = gap_seconds(a, b)
    if gap is None:
        return True
    return gap <= LIFT_GAP_S


@dataclass
class _FullLeg:
    """A classified run of pairs at full fidelity (indices into ``points``)."""

    type: str
    start: int  # first point index (inclusive)
    end: int  # last point index (inclusive)
    distance_m: float = 0.0
    ascent_m: float = 0.0


def _full_legs(points: list[LegPoint], pair_is_ride: list[bool]) -> list[_FullLeg]:
    """Merge consecutive same-type pairs into legs with full-fidelity stats."""
    legs: list[_FullLeg] = []
    for i, ride in enumerate(pair_is_ride):
        a, b = points[i], points[i + 1]
        dist = haversine_m(a.lat, a.lng, b.lat, b.lng)
        ascent = (
            b.ele - a.ele
            if a.ele is not None and b.ele is not None and b.ele > a.ele
            else 0.0
        )
        want = "ride" if ride else "lift"
        if legs and legs[-1].type == want:
            leg = legs[-1]
            leg.end = i + 1
            leg.distance_m += dist
            leg.ascent_m += ascent
        else:
            legs.append(_FullLeg(type=want, start=i, end=i + 1,
                                 distance_m=dist, ascent_m=ascent))
    return legs


def build_feature(
    points: list[LegPoint],
    pair_is_ride: list[bool],
    *,
    limit: int = RESPONSE_MAX_POINTS,
) -> dict:
    """The GeoJSON Feature the day map draws + the card reads (#290).

    ``pair_is_ride[i]`` classifies the pair ``points[i] → points[i+1]``. Each
    leg is decimated independently (endpoints kept, budget split ∝ leg length,
    minimum 2 points) and concatenated with DUPLICATE joints — leg k's
    ``endIndex`` and leg k+1's ``startIndex`` hold the same coordinate, so
    slicing never needs off-by-one care. Totals are full-fidelity.
    """
    legs_full = _full_legs(points, pair_is_ride)
    total = len(points)

    # Per-leg point budget ∝ leg length (a leg is pairs+1 points), min 2.
    budgets: list[int] = []
    if total <= limit or limit < 2:
        budgets = [leg.end - leg.start + 1 for leg in legs_full]
    else:
        raw = [
            max(2, round((leg.end - leg.start + 1) / total * limit))
            for leg in legs_full
        ]
        over = sum(raw) - limit
        # Deterministic shave: walk legs longest-first, round-robin, min 2.
        order = sorted(range(len(raw)), key=lambda j: -raw[j])
        k = 0
        while over > 0:
            j = order[k % len(order)]
            if raw[j] > 2:
                raw[j] -= 1
                over -= 1
            k += 1
            if k > 10 * (len(order) + over + 1):
                break
        budgets = raw

    coordinates: list[list[float]] = []
    legs: list[TrackLeg] = []
    for leg, budget in zip(legs_full, budgets):
        span = list(range(leg.start, leg.end + 1))
        if len(span) > budget and budget >= 2:
            step = (len(span) - 1) / (budget - 1)
            keep = sorted({round(i * step) for i in range(budget)})
            keep = [k for k in keep if k < len(span)]
            if keep[-1] != len(span) - 1:
                keep[-1] = len(span) - 1
            span = [span[k] for k in keep]
        start_index = len(coordinates)
        for idx in span:
            p = points[idx]
            coordinates.append([p.lng, p.lat])
        legs.append(
            TrackLeg(
                type=leg.type,
                start_index=start_index,
                end_index=len(coordinates) - 1,
                distance_m=leg.distance_m,
                ascent_m=leg.ascent_m,
                duration_s=duration_between(
                    points[span[0]].time, points[span[-1]].time
                ),
            )
        )

    distance_m = sum(leg.distance_m for leg in legs_full)
    ascent_m = sum(leg.ascent_m for leg in legs_full)
    ride_m = sum(leg.distance_m for leg in legs_full if leg.type == "ride")
    lift_m = distance_m - ride_m
    lift_vertical_m = sum(
        leg.ascent_m for leg in legs_full if leg.type == "lift"
    )
    times = [p.time for p in points if p.time]

    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coordinates},
        "properties": {
            "distanceM": round(distance_m, 1),
            "ascentM": round(ascent_m, 1),
            "startTime": times[0] if times else None,
            "endTime": times[-1] if times else None,
            "durationS": duration_between(
                times[0] if times else None, times[-1] if times else None
            ),
            "pointCount": len(points),
            "rideDistanceM": round(ride_m, 1),
            "liftDistanceM": round(lift_m, 1),
            "liftVerticalM": round(lift_vertical_m, 1),
            "legs": [leg.to_properties() for leg in legs],
        },
    }
