"""FIT track parsing for activity blocks (issue #290, preferred path).

Slopes writes a ``.fit`` whose ``split`` messages label EVERY leg at the
source — ``ski_run_split`` for ridden runs, ``ski_lift_split`` for lift rides
— each with its own start/end time, start/end position, distance and
ascent/descent. No guessing: the legs below come from the producer.

Decoding uses Garmin's official SDK (``garmin-fit-sdk``): the dependency
question AGENTS.md asks for was raised on #290 and answered by handing over a
real Slopes ``.fit`` to build against. The official SDK is the smallest
surface that works — ``split`` is a newer FIT message (split = 312) and older
decoders (e.g. fitparse 1.2.0) report it as ``unknown_312`` and silently drop
exactly the labels this feature exists for.

Label precedence per file:
1. ``split_mesgs`` with a ``split_type`` — exact producer legs (Slopes).
2. ``lap_mesgs`` time intervals — every lap is a ridden run (Slopes laps are
   all descents, ``lap_trigger`` vendor-specific); the complements between
   laps are lift/transit legs.
3. Recording-cadence fallback (``tracklegs.cadence_is_ride``) when a file
   carries positions but no usable laps — same rule as the GPX path.

``FitError`` parallels ``GpxError``: the route turns it into a per-file 422
naming the file (the #251 contract: never accept-and-drop).
"""

from __future__ import annotations

import datetime as _dt
from typing import Optional

from .tracklegs import (
    LegPoint,
    build_feature,
    cadence_is_ride,
)

# Refuse to parse beyond this many bytes even if the caller forgot the cap
# (same bound as GPX — a recorded day is kilobytes, not megabytes).
MAX_BYTES = 8 * 1024 * 1024

# FIT semicircles → degrees (the SDK leaves positions unscaled).
_SEMICIRCLE = 180.0 / 2**31


class FitError(ValueError):
    """A FIT file that cannot become a track."""


def _iso(moment: object) -> Optional[str]:
    """A decoded FIT timestamp → ``…Z`` ISO string (matches the GPX shape)."""
    if moment is None:
        return None
    if isinstance(moment, _dt.date) and not isinstance(
        moment, _dt.datetime
    ):
        moment = _dt.datetime(
            moment.year, moment.month, moment.day, tzinfo=_dt.timezone.utc
        )
    if not isinstance(moment, _dt.datetime):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)
    return (
        moment.astimezone(_dt.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _deg(semicircles: object) -> Optional[float]:
    """Semicircle position → degrees, else None (missing/invalid)."""
    if isinstance(semicircles, bool) or not isinstance(
        semicircles, (int, float)
    ):
        return None
    deg = float(semicircles) * _SEMICIRCLE
    return deg if -180.0 <= deg <= 180.0 else None


def _span_seconds(start: object, seconds: object, fallback: object) -> object:
    """Lap end = start + timer time (elapsed when the timer time is absent)."""
    if not isinstance(start, _dt.datetime):
        return None
    raw = seconds if seconds is not None else fallback
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    delta = float(raw)
    if delta < 0:
        return None
    return start + _dt.timedelta(seconds=delta)


def _inside(span: tuple[_dt.datetime, _dt.datetime], moment: object) -> bool:
    """Half-open containment [start, end) — a boundary fix belongs to the leg
    it starts, never to both."""
    if not isinstance(moment, _dt.datetime):
        return False
    lo, hi = span
    moment_naive = moment.replace(tzinfo=None)
    return lo.replace(tzinfo=None) <= moment_naive < hi.replace(tzinfo=None)


def parse_fit(raw: bytes, label: str) -> dict:
    """Parse FIT bytes into the GeoJSON Feature the day map draws (#290).

    Returns the feature dict directly (same shape as ``GpxTrack.to_feature``:
    one decimated ``LineString`` + ``properties`` with the ride/lift split and
    ``legs``). Raises ``FitError`` naming the file when the bytes are not a
    decodable FIT activity or carry no usable positions.
    """
    if len(raw) > MAX_BYTES:
        raise FitError(
            f"{label}: FIT larger than {MAX_BYTES // (1024 * 1024)} MB is not a track"
        )
    try:
        from garmin_fit_sdk import Decoder, Stream
    except ImportError as exc:  # pragma: no cover — dependency is installed
        raise FitError(f"{label}: FIT decoding is unavailable ({exc})") from exc

    try:
        decoder = Decoder(Stream.from_byte_array(bytes(raw)))
        messages, errors = decoder.read()
    except Exception as exc:
        raise FitError(f"{label}: not a readable FIT file ({exc})") from exc
    if errors:
        raise FitError(f"{label}: not a readable FIT file ({errors[0]})")
    if not messages or "record_mesgs" not in messages:
        raise FitError(f"{label}: no track points found (no record messages)")

    points: list[LegPoint] = []
    moments: list[Optional[_dt.datetime]] = []
    for record in messages.get("record_mesgs", []):
        lat = _deg(record.get("position_lat"))
        lng = _deg(record.get("position_long"))
        if lat is None or lng is None:
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
            continue
        ele = record.get("enhanced_altitude", record.get("altitude"))
        if isinstance(ele, bool) or not isinstance(ele, (int, float)):
            ele = None
        stamp = record.get("timestamp")
        if not isinstance(stamp, _dt.datetime):
            stamp = None
        points.append(
            LegPoint(
                lat=lat, lng=lng,
                ele=float(ele) if ele is not None else None,
                time=_iso(stamp),
            )
        )
        moments.append(stamp)
    if not points:
        raise FitError(
            f"{label}: no track points found (records carry no positions)"
        )

    pair_is_ride = _classify(messages, moments, points)
    return build_feature(points, pair_is_ride)


def _ride_spans(messages: dict) -> Optional[list[tuple[_dt.datetime, _dt.datetime]]]:
    """Producer-labelled ridden intervals, or None when the file has none.

    Splits win over laps: a ``ski_run_split`` names its own start AND end
    (``end_time``), so the leg is exact even when the timer kept running into
    the lift queue. Laps name only their start — the end is start + timer
    time — which is equally exact for Slopes (its laps are pure descents).
    """
    splits = messages.get("split_mesgs") or []
    spans: list[tuple[_dt.datetime, _dt.datetime]] = []
    for split in splits:
        kind = str(split.get("split_type") or "")
        if kind != "ski_run_split":
            continue
        start, end = split.get("start_time"), split.get("end_time")
        if isinstance(start, _dt.datetime) and isinstance(end, _dt.datetime):
            if end > start:
                spans.append((start, end))
    if spans:
        return spans
    laps = messages.get("lap_mesgs") or []
    for lap in laps:
        start = lap.get("start_time")
        end = _span_seconds(
            start,
            lap.get("total_timer_time"),
            lap.get("total_elapsed_time"),
        )
        if isinstance(start, _dt.datetime) and isinstance(end, _dt.datetime):
            if end > start:
                spans.append((start, end))
    return spans or None


def _classify(
    messages: dict,
    moments: list[Optional[_dt.datetime]],
    points: list[LegPoint],
) -> list[bool]:
    """One ride flag per consecutive pair (``True`` = ridden run)."""
    spans = _ride_spans(messages)
    if spans:
        flags: list[bool] = []
        for a_stamp, b_stamp in zip(moments, moments[1:]):
            # A pair is ridden when its MIDPOINT falls inside a producer leg —
            # midpoints never sit exactly on a boundary, so the half-open
            # intervals above classify every pair unambiguously.
            mids = [
                s for s in (a_stamp, b_stamp) if isinstance(s, _dt.datetime)
            ]
            if len(mids) < 2:
                flags.append(True)
                continue
            mid = mids[0] + (mids[1] - mids[0]) / 2
            flags.append(any(_inside(span, mid) for span in spans))
        return flags
    # No usable producer labels — the GPX cadence rule on record timestamps.
    return [
        cadence_is_ride(a, b) for a, b in zip(points, points[1:])
    ]
