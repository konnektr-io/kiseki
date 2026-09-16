"""Elevation gain tracks the mountain, not the sample rate (issue #298).

A barometric trace oscillates around the true profile. Summing every positive
sample-to-sample delta accumulated that oscillation, so the SAME day's riding
read 5 947.8 m from its FIT and 3 236.5 m from its 1.8x sparser GPX, and both
ran +6..+36 % above the producer's own ``session_mesgs.total_ascent``.

Three rules fix it, and each is pinned here:

1. the profile is averaged over a TIME window (a sample-count window is itself
   density-dependent — the defect), so a denser recording no longer reads
   higher purely for being denser;
2. a rise is counted only once it clears ``ELE_GAIN_THRESHOLD_M`` above the
   last counted reference, so residual jitter is never summed;
3. a "lift" leg shorter than ``LIFT_MIN_DISTANCE_M`` is a stray stub (a
   trailhead pair, a paused fix, an artefact of the cadence rule), not a lift
   ride, and folds back into the ride beside it.

The proof against Niko's seven real Slopes days (FIT producer totals as the
oracle) runs only when the files are handed in — see the opt-in tests in
``test_fit_track_290.py`` (``KISEKI_REAL_FIT`` / ``KISEKI_REAL_GPX``).
"""

from __future__ import annotations

import os

import pytest

from app.fit import parse_fit
from app.tracklegs import (
    ELE_GAIN_THRESHOLD_M,
    LIFT_GAP_S,
    LIFT_MIN_DISTANCE_M,
    LegPoint,
    build_feature,
    gap_seconds,
    haversine_m,
    profile_gain,
    smoothed_profile,
)

# A 200 m chair ride and the 200 m run back down, sampled every `step` seconds
# with the barometer jittering ±1.5 m as a function of TIME (so the same
# physical day can be re-sampled at a different rate).
CLIMB_M = 200.0
SPAN_S = 300.0
LAT, LNG = 50.0, -122.95


def _jitter(second: float) -> float:
    return 1.5 if int(second) % 2 == 0 else -1.5


def _day(step_s: float) -> tuple[list[LegPoint], list[bool]]:
    """Climb SPAN_S up, then SPAN_S down, one fix every ``step_s`` seconds.

    Positions step ~2 m per fix so the legs carry a real length (a leg shorter
    than ``LIFT_MIN_DISTANCE_M`` is folded into its neighbour by design).
    """
    points: list[LegPoint] = []
    samples = int(SPAN_S / step_s)
    for i in range(samples + 1):
        t = i * step_s
        ele = 800.0 + CLIMB_M * (t / SPAN_S) + _jitter(t)
        points.append(
            LegPoint(lat=LAT + i * 0.00002, lng=LNG, ele=ele,
                     time=f"2026-03-01T09:{int(t // 60):02d}:{int(t % 60):02d}Z")
        )
    for i in range(1, samples + 1):
        t = SPAN_S + i * step_s
        ele = 1000.0 - CLIMB_M * (i * step_s / SPAN_S) + _jitter(t)
        points.append(
            LegPoint(lat=LAT + (samples + i) * 0.00002, lng=LNG, ele=ele,
                     time=f"2026-03-01T09:{int(t // 60):02d}:{int(t % 60):02d}Z")
        )
    # The climb is the lift, the descent the ridden run (as on a real day).
    rides = [i >= samples for i in range(len(points) - 1)]
    return points, rides


def _raw_positive_sum(points: list[LegPoint]) -> float:
    """The pre-#298 figure: every up-tick summed, jitter and all."""
    values = [p.ele for p in points]
    return sum(b - a for a, b in zip(values, values[1:]) if a is not None and b is not None and b > a)


# ------------------------------------------------------------------ jitter


def test_dense_jitter_no_longer_inflates_the_gain() -> None:
    """A 200 m climb reads ~200 m, however hard the barometer wobbles.

    The band is not exact: this fixture is a TWO-leg day, so the first climb
    carries the smoothing window's end effect on its own. A real day spreads
    that over ~25 legs (measured within 4 % of the producer's own totals).
    """
    points, rides = _day(1.0)
    props = build_feature(points, rides)["properties"]
    raw = _raw_positive_sum(points)
    assert raw > 4 * CLIMB_M  # the fixture really does carry the jitter…
    assert props["liftVerticalM"] < 1.05 * CLIMB_M  # …and it no longer reaches the card
    assert props["liftVerticalM"] > 0.7 * CLIMB_M  # while the real climb survives


def test_the_gain_does_not_scale_with_sample_density() -> None:
    """The same physical day at 1 s and at 5 s reads the same figure.

    This is the defect itself: the raw sum grew with the recording rate (the
    FIT/GPX +84 %), so the two samplings of one day must now agree.
    """
    dense, dense_rides = _day(1.0)
    sparse, sparse_rides = _day(5.0)
    dense_feature = build_feature(dense, dense_rides)["properties"]
    sparse_feature = build_feature(sparse, sparse_rides)["properties"]

    # The RAW sums are far apart (5x the samples, 5x the accumulated jitter)…
    assert _raw_positive_sum(dense) > 1.5 * _raw_positive_sum(sparse)
    # …the smoothed figures are not.
    ratio = dense_feature["ascentM"] / sparse_feature["ascentM"]
    assert 0.9 < ratio < 1.1, (dense_feature["ascentM"], sparse_feature["ascentM"])


# ------------------------------------------------------------------ profile rules


def test_a_sustained_climb_is_not_eroded_by_the_window() -> None:
    """Smoothing must not eat a real climb — a 20-minute ascent keeps ~all of it.

    (Only the trace's own ends lose the window's half-width; every climb with a
    descent in front of it is measured against a reference that descends with
    it, which is why a real lift-served day keeps its vertical.)
    """
    fixes = 600
    points = [
        LegPoint(lat=LAT, lng=LNG, ele=1000.0 + CLIMB_M * i / fixes,
                 time=f"2026-03-01T{9 + (i * 2) // 3600:02d}:{((i * 2) % 3600) // 60:02d}:{(i * 2) % 60:02d}Z")
        for i in range(fixes + 1)
    ]
    assert profile_gain(smoothed_profile(points)) > 0.9 * CLIMB_M


def test_sub_threshold_rises_still_accumulate() -> None:
    """A slow climb (steps under the threshold) is still counted in full."""
    points = [
        LegPoint(lat=LAT, lng=LNG, ele=1000.0 + i * 0.2, time=f"2026-03-01T09:00:{i:02d}Z")
        for i in range(60)
    ]
    gain = profile_gain([p.ele for p in points])
    assert gain > 0.9 * (59 * 0.2)


def test_track_ascent_is_the_sum_of_its_legs() -> None:
    """One walk over one profile: the card's total is exactly its legs' sum."""
    points, rides = _day(2.0)
    props = build_feature(points, rides)["properties"]
    assert props["ascentM"] == round(
        sum(leg["ascentM"] for leg in props["legs"]), 1
    )


# ------------------------------------------------------------------ stray lift stubs


def _climb_and_pause() -> tuple[list[LegPoint], list[bool]]:
    """A dense ridden stretch with one >2 min PAUSE in the middle.

    The cadence rule reads the pair across the pause as a lift — 20 m, no
    climb — which used to surface as a dashed "lift" leg of its own.
    """
    points: list[LegPoint] = []
    for i in range(10):
        points.append(
            LegPoint(lat=LAT + i * 0.00002, lng=LNG, ele=1200.0,
                     time=f"2026-03-01T09:00:{i:02d}Z")
        )
    points.append(
        LegPoint(lat=LAT + 10 * 0.00002, lng=LNG, ele=1200.0,
                 time="2026-03-01T09:05:00Z")
    )
    for i in range(1, 11):
        points.append(
            LegPoint(lat=LAT + (10 + i) * 0.00002, lng=LNG, ele=1200.0,
                     time=f"2026-03-01T09:06:{i:02d}Z")
        )
    rides = [True] * (len(points) - 1)
    # The pair spanning the pause is beyond LIFT_GAP_S, so the cadence rule
    # reads it as a lift — 2 m of "lift" that is really a stopped recording.
    pause_pair = 9  # points[9] (09:00:09) → points[10] (09:05:00)
    rides[pause_pair] = False
    return points, rides


def test_a_sub_50_m_lift_stub_is_not_a_leg() -> None:
    points, rides = _climb_and_pause()
    assert gap_seconds(points[9], points[10]) > LIFT_GAP_S  # the cadence stub
    props = build_feature(points, rides)["properties"]
    # The 0 m "lift" pair is folded back into the ride: no stub leg survives.
    assert [leg["type"] for leg in props["legs"]] == ["ride"]
    assert props["liftDistanceM"] == 0.0
    assert props["rideDistanceM"] == props["distanceM"]


def test_a_real_lift_leg_is_kept() -> None:
    """The gate is a minimum LENGTH, not a ban on lifts."""
    points: list[LegPoint] = []
    for i in range(20):  # 5-minute chair ride, ~11 m per fix, 1200 → 1390
        points.append(
            LegPoint(lat=LAT + i * 0.0001, lng=LNG, ele=1200.0 + i * 10,
                     time=f"2026-03-01T09:{i // 4:02d}:{(i % 4) * 15:02d}Z")
        )
    for i in range(10):  # the run's opening fixes, on the flat
        points.append(
            LegPoint(lat=LAT + (20 + i) * 0.0001, lng=LNG, ele=1400.0,
                     time=f"2026-03-01T09:05:{i:02d}Z")
        )
    rides = [False] * 19 + [True] * 10
    props = build_feature(points, rides)["properties"]
    lifts = [leg for leg in props["legs"] if leg["type"] == "lift"]
    assert len(lifts) == 1
    assert lifts[0]["distanceM"] > LIFT_MIN_DISTANCE_M
    assert props["liftVerticalM"] > 0.8 * 190.0  # the climb stays on the lift
    assert props["ascentM"] == round(sum(leg["ascentM"] for leg in props["legs"]), 1)


def test_a_flat_lift_leg_is_not_a_lift() -> None:
    """A 500 m "lift" that climbs nothing is a traverse (or a paused fix).

    The cadence rule sees the long gap, not the mountain — real exports carry
    200-500 m "lifts" with 0 m of climb, drawn as dashed lift legs.
    """
    points: list[LegPoint] = []
    for i in range(10):  # 10 dense fixes, then a long gap, then 10 more: flat
        points.append(
            LegPoint(lat=LAT + i * 0.0004, lng=LNG, ele=900.0,
                     time=f"2026-03-01T09:00:{i:02d}Z")
        )
    for i in range(1, 11):
        points.append(
            LegPoint(lat=LAT + (10 + i) * 0.0004, lng=LNG, ele=900.0,
                     time=f"2026-03-01T09:04:{i:02d}Z")
        )
    rides = [True] * (len(points) - 1)
    rides[9] = False  # the pair across the 4-minute gap: "lift", 0 m of climb
    props = build_feature(points, rides)["properties"]
    assert props["liftDistanceM"] == 0.0
    assert [leg["type"] for leg in props["legs"]] == ["ride"]


def test_a_lift_leg_kept_when_the_track_carries_no_elevation() -> None:
    """No elevation to read = nothing to demote on: the cadence legs stand."""
    points = [
        LegPoint(lat=LAT + i * 0.0005, lng=LNG, ele=None,
                 time=f"2026-03-01T09:00:{i:02d}Z")
        for i in range(4)
    ]
    points.append(LegPoint(lat=LAT + 0.003, lng=LNG, ele=None, time="2026-03-01T09:05:00Z"))
    rides = [True, True, True, False]
    props = build_feature(points, rides)["properties"]
    assert [leg["type"] for leg in props["legs"]] == ["ride", "lift"]


def test_the_gate_is_above_a_single_sample_step() -> None:
    """A one-fix "lift" (a paused recording) is never a leg, by construction."""
    assert LIFT_MIN_DISTANCE_M >= 50.0
    assert ELE_GAIN_THRESHOLD_M > 0.0
    # A stub the size of the issue's worst case (1.4 m in one second).
    points = [
        LegPoint(lat=LAT, lng=LNG, ele=900.0, time="2026-03-01T09:00:00Z"),
        LegPoint(lat=LAT + 0.00001, lng=LNG, ele=900.0, time="2026-03-01T09:00:01Z"),
        LegPoint(lat=LAT + 0.00002, lng=LNG, ele=900.0, time="2026-03-01T09:00:02Z"),
    ]
    assert haversine_m(LAT, LNG, LAT + 0.00002, LNG) < LIFT_MIN_DISTANCE_M
    props = build_feature(points, [True, False])["properties"]
    assert [leg["type"] for leg in props["legs"]] == ["ride"]


# ------------------------------------------------- the real days (opt-in)
# The seven real Slopes exports are trip content and never enter git (the repo
# is public). Point ``KISEKI_REAL_TRACKS_DIR`` at a directory of them and every
# day is measured against the PRODUCER'S OWN session total — the acceptance
# criterion of #298. Before the fix the same set read +6 % to +36 % high.


_REAL_DIR = os.environ.get("KISEKI_REAL_TRACKS_DIR", "")
_needs_real_days = pytest.mark.skipif(
    not (_REAL_DIR and os.path.isdir(_REAL_DIR)),
    reason="needs KISEKI_REAL_TRACKS_DIR (real Slopes FIT exports, not in git)",
)


def _producer_totals(raw: bytes) -> tuple[float, float]:
    """The FIT's own session ascent + the sum of its lift splits' ascent."""
    from garmin_fit_sdk import Decoder, Stream

    messages, errors = Decoder(Stream.from_byte_array(bytearray(raw))).read()
    assert not errors, errors[:1]
    session = (messages.get("session_mesgs") or [{}])[0]
    lift = sum(
        s.get("total_ascent") or 0
        for s in messages.get("split_mesgs", [])
        if str(s.get("split_type")) == "ski_lift_split"
    )
    return float(session.get("total_ascent") or 0), float(lift)


@_needs_real_days
def test_every_real_day_matches_the_producer() -> None:
    days = sorted(f for f in os.listdir(_REAL_DIR) if f.endswith(".fit"))
    assert days, f"no .fit exports in {_REAL_DIR}"
    checked = 0
    for name in days:
        with open(os.path.join(_REAL_DIR, name), "rb") as fh:
            raw = fh.read()
        producer_ascent, producer_lift = _producer_totals(raw)
        if not producer_ascent:
            continue  # a file with no session summary cannot be an oracle
        props = parse_fit(raw, name)["properties"]
        assert props["ascentM"] == pytest.approx(producer_ascent, rel=0.05), (
            name, props["ascentM"], producer_ascent
        )
        if producer_lift:
            assert props["liftVerticalM"] == pytest.approx(producer_lift, rel=0.05), (
                name, props["liftVerticalM"], producer_lift
            )
        checked += 1
    assert checked >= 1
