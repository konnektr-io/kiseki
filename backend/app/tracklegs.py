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

Elevation gains (#298) are summed from a SMOOTHED profile, not from the raw
sample-to-sample deltas: a barometric trace oscillates around the true profile,
and adding up every up-tick accumulates that oscillation — the denser the
recording, the larger the total (the same day read 5 947.8 m from its FIT and
3 236.5 m from the 1.8x-sparser GPX of the SAME riding, against the producer's
own 4 105 m). Each leg's profile is therefore averaged over a short window and
its gain counted only once it clears ``ELE_GAIN_THRESHOLD_M``, so the figure
tracks the mountain instead of the sample rate. Distances are NOT smoothed —
they are geometry.

A "lift" leg also has to look like one before it is served as a leg
(``LIFT_MIN_DISTANCE_M`` / ``LIFT_MIN_CLIMB_M``): the cadence rule catches
pauses and flat traverses, and a 1 m dashed stub on the day map is not a leg.
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

# --- elevation gain (#298) ---------------------------------------------------
# A barometric trace never sits still: it oscillates around the true profile,
# and summing every positive sample-to-sample delta accumulates that
# oscillation, so the same day read +6 % to +36 % above the producer's own
# session total and +84 % above the same day's sparser GPX. Two rules fix it:
#
# * a centred moving average over roughly this much TIME (a time window, not a
#   sample count — a sample count is itself density-dependent, which is the
#   bug) with a sample-count fallback for undated fixes, and
# * a gain threshold: a rise counts only once it clears this many metres above
#   the last counted reference, so residual jitter is not summed.
#
# Measured against the seven real Slopes days (FIT producer's own
# ``session_mesgs.total_ascent`` as the oracle): worst day 4.0 %, five of the
# seven within 2 % — where the raw sum was +6..+36 % high.
ELE_SMOOTH_S = 120.0  # time window for the moving average, when fixes are dated
ELE_SMOOTH_POINTS = 9  # sample-count window for fixes without timestamps
ELE_GAIN_THRESHOLD_M = 1.0  # a counted rise must clear this

# A "lift" leg shorter than this is not a lift ride (#298): a trailhead stub,
# a paused fix, or an artefact of the cadence rule (Slopes days start with a
# 1.4-11.6 m "lift" leg). Such a leg is demoted to a ridden leg and merged into
# its neighbour, so no dashed 1 m stub is drawn and no leg count is inflated.
LIFT_MIN_DISTANCE_M = 50.0

# …and a lift ride CLIMBS. A "lift" leg with no vertical of its own is another
# artefact — a paused recording, or a flat traverse the cadence rule caught
# (real exports carry 200-500 m "lifts" climbing 0 m) — and is demoted the same
# way. Every real lift in the seven Slopes days climbs far more than this.
LIFT_MIN_CLIMB_M = 20.0


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


def smoothed_profile(points: list[LegPoint]) -> list[Optional[float]]:
    """Centred moving average of the elevation trace (#298).

    The window is a TIME window (``ELE_SMOOTH_S``) whenever the fixes are
    dated, so the amount of smoothing does not depend on the recording rate —
    that rate-dependence IS the defect (a denser file accumulated more jitter:
    the same day read 5 947.8 m from its FIT and 3 236.5 m from the 1.8x
    sparser GPX of the same riding). Undated fixes fall back to a plain
    sample-count window (``ELE_SMOOTH_POINTS``); a fix without an elevation
    stays ``None`` and simply drops out of the window.
    """
    values = [p.ele for p in points]
    if not any(v is not None for v in values):
        return list(values)

    times = [parse_time(p.time) for p in points]
    half_s = ELE_SMOOTH_S / 2.0
    half_n = ELE_SMOOTH_POINTS // 2
    out: list[Optional[float]] = []
    lo = 0
    hi = 0
    for i, moment in enumerate(times):
        if moment is None:
            window = [
                v
                for v in values[max(0, i - half_n):i + half_n + 1]
                if v is not None
            ]
        else:
            # Advance the trailing edge past everything older than the window…
            while lo < i:
                other = times[lo]
                if other is None or (moment - other).total_seconds() > half_s:
                    lo += 1
                else:
                    break
            if hi < i:
                hi = i
            # …and the leading edge while the next fix is still inside it.
            while hi + 1 < len(times):
                other = times[hi + 1]
                if other is None or (other - moment).total_seconds() > half_s:
                    break
                hi += 1
            window = [v for v in values[lo:hi + 1] if v is not None]
        out.append(sum(window) / len(window) if window else None)
    return out


def profile_gain(values: list[Optional[float]]) -> float:
    """Positive gain of a profile, gated by ``ELE_GAIN_THRESHOLD_M``.

    A rise counts only once it clears the threshold above the last COUNTED
    reference; a fall resets that reference. Sub-threshold oscillation is
    therefore never summed, while a sustained climb is counted in full
    (the reference keeps advancing, so nothing above the noise is lost).
    """
    reference: Optional[float] = None
    gain = 0.0
    for value in values:
        if value is None:
            continue
        if reference is None:
            reference = value
            continue
        if value > reference + ELE_GAIN_THRESHOLD_M:
            gain += value - reference
            reference = value
        elif value < reference - ELE_GAIN_THRESHOLD_M:
            reference = value
    return gain


def _pair_runs(pair_is_ride: list[bool]) -> list[list]:
    """Consecutive same-type pairs → ``[type, first_pair, last_pair + 1]``."""
    runs: list[list] = []
    for i, ride in enumerate(pair_is_ride):
        want = "ride" if ride else "lift"
        if runs and runs[-1][0] == want:
            runs[-1][2] = i + 1
        else:
            runs.append([want, i, i + 1])
    return runs


def _full_legs(points: list[LegPoint], pair_is_ride: list[bool]) -> list[_FullLeg]:
    """Merge consecutive same-type pairs into legs with full-fidelity stats.

    Distance is summed pair by pair — geometry, never smoothed. Ascent is the
    gated gain of the ``smoothed_profile`` walk, attributed to the pair's own
    leg, so a leg's figure is that stretch of the day and the legs still sum
    to the whole track's ascent.
    """
    runs = _pair_runs(pair_is_ride)
    distances = [
        haversine_m(a.lat, a.lng, b.lat, b.lng)
        for a, b in zip(points, points[1:])
    ]

    def run_distance(run: list) -> float:
        return sum(distances[run[1]:run[2]])

    profile = smoothed_profile(points)
    # One walk over the whole trace, so the legs' figures sum to exactly the
    # track's (``profile_gain`` of the same profile): the reference is seeded
    # on the first fix that carries an elevation, then each pair's rise is the
    # step from the previous point — gated, and never counted twice.
    pair_gains = [0.0] * len(pair_is_ride)
    reference: Optional[float] = None
    for i, value in enumerate(profile):
        if value is None:
            continue
        if reference is None:
            reference = value
            continue
        if value > reference + ELE_GAIN_THRESHOLD_M:
            pair_gains[i - 1] = value - reference
            reference = value
        elif value < reference - ELE_GAIN_THRESHOLD_M:
            reference = value

    # A stray "lift" — too short to be a ride, or with no climb of its own — is
    # a ridden leg; same-type neighbours merge back together, so a demoted
    # stretch never survives as a leg of its own (and no dashed stub is drawn).
    # The climb test needs an elevation to read: a track that carries none
    # (a route-only GPX) keeps the legs its cadence produced.
    has_elevation = [p.ele is not None for p in points]
    merged: list[list] = []
    for run in runs:
        ascent = sum(pair_gains[run[1]:run[2]])
        measured_climb = any(has_elevation[run[1]:run[2] + 1])
        if run[0] == "lift" and (
            run_distance(run) < LIFT_MIN_DISTANCE_M
            or (measured_climb and ascent < LIFT_MIN_CLIMB_M)
        ):
            run[0] = "ride"
        if merged and merged[-1][0] == run[0]:
            merged[-1][2] = run[2]
        else:
            merged.append(run)

    return [
        _FullLeg(
            type=run[0],
            start=run[1],
            end=run[2],
            distance_m=run_distance(run),
            ascent_m=sum(pair_gains[run[1]:run[2]]),
        )
        for run in merged
    ]


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
